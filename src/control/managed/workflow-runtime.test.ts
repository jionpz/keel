import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  ManagedTicketStageRunner,
  ManagedWorkflowTickResult,
} from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type { JstackRoutePlan } from '../../generated/managed.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'
import { answerManagedTicketDecision } from './decision-store.js'
import { fixtureRoutePackage, fixtureRoutePlan } from './route-test-utils.js'
import type { ManagedTicketWorker } from './ticket-runtime.js'
import { diffDigest } from './ticket-workspace.js'
import {
  commitManagedWorkflowPlan,
  createManagedWorkflow,
  getManagedWorkflowProjection,
  retryManagedWorkflow,
  tickManagedWorkflow,
} from './workflow-runtime.js'
import { insertWorkflowEvidence } from './workflow-store.js'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return result.stdout.trim()
}

async function head(cwd: string): Promise<string> {
  return git(cwd, 'rev-parse', 'HEAD')
}

async function commitFile(cwd: string, path: string, body: string): Promise<string> {
  await mkdir(dirname(join(cwd, path)), { recursive: true })
  await writeFile(join(cwd, path), body)
  await git(cwd, 'add', path)
  await git(cwd, 'commit', '-m', `update ${path}`)
  return head(cwd)
}

function success(
  stage: 'execute' | 'verify' | 'review' | 'land',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: '1.0',
    stage,
    status: 'completed',
    summary: `${stage} completed`,
    ...extra,
  }
}

const workerTools = [
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write',
  'bash',
  'Agent',
  'web_search',
  'fetch_content',
]

function workerWith(
  handler: (input: Parameters<ManagedTicketStageRunner>[0]) => Promise<Record<string, unknown>>,
): ManagedTicketWorker {
  return {
    harness: 'pi',
    toolInventory: workerTools,
    run: async (input) => ({
      ok: true,
      value: {
        output: (await handler(input)) as never,
        usage: ZERO_USAGE,
      },
    }),
  }
}

function happyWorker(): ManagedTicketWorker {
  return workerWith(async (input) => {
    if (input.stage === 'execute') {
      const safe = input.package.ticket.id.replace(/[^A-Za-z0-9._-]/g, '-')
      const commit = await commitFile(input.workspace_path, `src/${safe}.txt`, `${safe}\n`)
      return success('execute', { commit, worktree_head: commit })
    }
    const current = await head(input.workspace_path)
    if (input.stage === 'verify') {
      return success('verify', {
        worktree_head: current,
        checks: [
          {
            command: 'git status --porcelain',
            exit_code: 0,
            passed: true,
            output_digest: sha256Text('clean'),
            output_excerpt: 'clean',
          },
        ],
      })
    }
    if (input.stage === 'review') {
      const digest = await diffDigest(input.workspace_path, input.baseline_commit, current)
      if (!digest.ok) throw new Error(digest.error.detail)
      return success('review', {
        review: {
          reviewed_commit: current,
          diff_digest: digest.value,
          findings: [],
        },
      })
    }
    const branch = await git(input.workspace_path, 'rev-parse', '--abbrev-ref', 'HEAD')
    return success('land', {
      land: {
        branch,
        commit: current,
        action_intent: {
          kind: 'push_and_pr',
          remote: 'origin',
          pr_title: `workflow ${input.package.ticket.id}`,
          pr_body: 'workflow fixture',
        },
      },
      requested_action: {
        action: 'push fixture branch to origin and open a pull request',
        reason: 'provider still describes the pr_ready handoff',
      },
    })
  })
}

interface SeededWorkflow {
  readonly workflowId: string
  readonly repoId: string
  readonly repo: string
  readonly worktreeRoot: string
}

async function seedWorkflow(
  plan: JstackRoutePlan,
  options: {
    readonly completionTarget?: 'branch_ready' | 'pr_ready'
    readonly externalIssue?: string
  } = {},
): Promise<SeededWorkflow> {
  const base = await mkdtemp(join(tmpdir(), 'keel-workflow-'))
  const repo = join(base, 'repo')
  const worktreeRoot = join(base, 'worktrees')
  await run('git', ['init', '-b', 'main', repo])
  await git(repo, 'config', 'user.name', 'Keel Test')
  await git(repo, 'config', 'user.email', 'keel@example.test')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'src', 'README.md'), '# fixture\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'initial')
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
       VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${repo}`, repo],
    ),
  )
  const routePackagePath = join(base, 'route-package.json')
  await writeFile(
    routePackagePath,
    JSON.stringify(
      fixtureRoutePackage(
        options.completionTarget === undefined
          ? {}
          : { completionTarget: options.completionTarget },
      ),
    ),
  )
  const created = await createManagedWorkflow(repoId, routePackagePath, 'deliver fixture', {
    scopePaths: ['src'],
    worktreeRoot,
    ...(options.externalIssue === undefined ? {} : { externalIssue: options.externalIssue }),
  })
  if (!created.ok) throw new Error(created.error.detail)
  const committed = await commitManagedWorkflowPlan(created.value, plan)
  if (!committed.ok) throw new Error(committed.error.detail)
  return { workflowId: created.value, repoId, repo, worktreeRoot }
}

async function tickUntil(
  workflowId: string,
  worker: ManagedTicketWorker,
  predicate: (result: ManagedWorkflowTickResult) => boolean,
  maxTicks = 40,
): Promise<ManagedWorkflowTickResult[]> {
  const results: ManagedWorkflowTickResult[] = []
  for (let index = 0; index < maxTicks; index += 1) {
    const ticked = await tickManagedWorkflow(worker, workflowId)
    if (!ticked.ok) throw new Error(ticked.error.detail)
    if (ticked.value === null) break
    results.push(ticked.value)
    if (predicate(ticked.value)) break
  }
  return results
}

async function nodeRow(
  workflowId: string,
  nodeKey: string,
): Promise<{
  id: string
  status: string
  ticket_task_id: string
  scope_paths: string[]
  acceptance: string[]
}> {
  const row = await asRole('keel_control', (c) =>
    c.query(
      `SELECT id,status,ticket_task_id,scope_paths,acceptance
       FROM managed_workflow_node WHERE workflow_id=$1 AND node_key=$2`,
      [workflowId, nodeKey],
    ),
  )
  return row.rows[0] as never
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

describe('managed workflow runtime', () => {
  it('materializes and completes a dependent multi-ticket graph', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('M', 2), {
      completionTarget: 'branch_ready',
    })
    const results = await tickUntil(
      seeded.workflowId,
      happyWorker(),
      (result) => result.status === 'DONE',
    )
    expect(results.some((result) => result.action === 'materialized')).toBe(true)
    expect(results.at(-1)?.status).toBe('DONE')

    const projection = await getManagedWorkflowProjection(seeded.workflowId)
    if (!projection.ok) throw new Error(projection.error.detail)
    expect(projection.value.nodes).toHaveLength(2)
    expect(projection.value.nodes.every((node) => node.status === 'ARCHIVED')).toBe(true)
    const stages = projection.value.evidence.reduce<Record<string, string[]>>((acc, evidence) => {
      const key = evidence.node_id
      acc[key] = [...(acc[key] ?? []), evidence.stage]
      return acc
    }, {})
    for (const node of projection.value.nodes) {
      expect(stages[node.id]).toEqual(
        expect.arrayContaining(['execute', 'verify', 'review', 'land', 'archive']),
      )
    }
    const completed = await asRole('keel_control', (c) =>
      c.query<{ status: string; handoff: Record<string, unknown> | null }>(
        'SELECT status,handoff FROM managed_ticket_task WHERE id=$1',
        [projection.value.nodes[0]?.ticket_task_id],
      ),
    )
    expect(completed.rows[0]?.status).toBe('DONE')
    expect(completed.rows[0]?.handoff).toMatchObject({
      action: 'branch_ready',
      completion_target: 'branch_ready',
    })
    const outbox = await asRole('keel_control', (c) =>
      c.query(
        `SELECT o.id FROM managed_action_outbox o
         JOIN managed_action_intent i ON i.id=o.action_intent_id
         WHERE i.task_id=$1`,
        [projection.value.nodes[0]?.ticket_task_id],
      ),
    )
    expect(outbox.rowCount).toBe(0)
  })

  it('keeps independent tickets moving while one waits for a human', async () => {
    const plan = fixtureRoutePlan('M', 2)
    ;(plan.tickets[1] as { depends_on: string[] }).depends_on = []
    const seeded = await seedWorkflow(plan, { completionTarget: 'branch_ready' })
    let blocked = false
    const worker = workerWith(async (input) => {
      if (input.package.ticket.id === 'JT-TEST-1' && input.stage === 'execute' && !blocked) {
        blocked = true
        return {
          schema_version: '1.0',
          stage: 'execute',
          status: 'blocked',
          summary: '需要人工选择',
          decision: {
            decision_key: 'execute.implementation-choice',
            kind: 'preference',
            question: '选择实现方式？',
            options: ['方案 A', '方案 B'],
            action_category: 'ticket_stage',
            impact: {
              environment: 'local',
              reversibility: 'reversible',
              affected_resources: [input.workspace_path],
            },
          },
        }
      }
      return happyWorker()
        .run(input)
        .then((result) => {
          if (!result.ok) throw new Error(result.error.detail)
          return result.value.output as unknown as Record<string, unknown>
        })
    })

    const first = await tickUntil(
      seeded.workflowId,
      worker,
      (result) => result.action === 'ticketed',
      8,
    )
    expect(first.length).toBeGreaterThan(0)
    let firstNode = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(firstNode.status).toBe('WAITING_HUMAN')

    const second = await tickUntil(
      seeded.workflowId,
      worker,
      (result) => result.action === 'materialized' || result.nodeKey === 'ticket-2',
      8,
    )
    expect(second.some((result) => result.nodeKey === 'ticket-2')).toBe(true)
    const secondNode = await nodeRow(seeded.workflowId, 'ticket-2')
    expect(secondNode.status).not.toBe('PENDING')
    firstNode = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(firstNode.status).toBe('WAITING_HUMAN')
  })

  it('resumes the workflow after a human answers the ticket decision', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    let blocked = false
    const worker = workerWith(async (input) => {
      if (input.stage === 'execute' && !blocked) {
        blocked = true
        return {
          schema_version: '1.0',
          stage: 'execute',
          status: 'blocked',
          summary: '需要人工选择',
          decision: {
            decision_key: 'execute.resume-check',
            kind: 'preference',
            question: '继续使用方案 A？',
            options: ['使用方案 A', '使用方案 B'],
            action_category: 'ticket_stage',
            impact: {
              environment: 'local',
              reversibility: 'reversible',
              affected_resources: [input.workspace_path],
            },
          },
        }
      }
      const result = await happyWorker().run(input)
      if (!result.ok) throw new Error(result.error.detail)
      return result.value.output as unknown as Record<string, unknown>
    })

    const waiting = await tickUntil(
      seeded.workflowId,
      worker,
      (result) => result.status === 'WAITING_HUMAN',
    )
    expect(waiting.at(-1)?.status).toBe('WAITING_HUMAN')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(node.status).toBe('WAITING_HUMAN')

    const idle = await tickManagedWorkflow(worker, seeded.workflowId)
    expect(idle.ok).toBe(true)
    if (!idle.ok) throw new Error(idle.error.detail)
    expect(idle.value).toBeNull()

    const request = await asRole('keel_control', (c) =>
      c.query<{ id: string; revision: number }>(
        `SELECT id,revision FROM managed_decision_request
         WHERE managed_ticket_task_id=$1 ORDER BY revision DESC LIMIT 1`,
        [node.ticket_task_id],
      ),
    )
    const pending = request.rows[0]
    if (pending === undefined) throw new Error('缺少 ticket decision request')
    const answered = await answerManagedTicketDecision(
      pending.id,
      pending.revision,
      'option-1',
      new Date().toISOString(),
    )
    if (!answered.ok) throw new Error(answered.error.detail)
    expect(answered.value.taskStatus).toBe('READY')

    const resumed = await tickUntil(
      seeded.workflowId,
      worker,
      (result) => result.status === 'DONE',
      60,
    )
    expect(resumed.at(-1)?.status).toBe('DONE')
    const archived = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(archived.status).toBe('ARCHIVED')
  })

  it('retries a paused node after operator repair', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    await tickUntil(seeded.workflowId, happyWorker(), (result) => result.action === 'materialized')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    await asOwner(async (c) => {
      await c.query(
        `UPDATE managed_ticket_task SET status='PAUSED',last_error='EVIDENCE_DIGEST_MISMATCH'
         WHERE id=$1`,
        [node.ticket_task_id],
      )
      await c.query(
        `UPDATE managed_workflow_node SET status='FAILED',last_error='EVIDENCE_DIGEST_MISMATCH'
         WHERE id=$1`,
        [node.id],
      )
      await c.query(`UPDATE managed_workflow SET status='PAUSED',last_error=$2 WHERE id=$1`, [
        seeded.workflowId,
        'EVIDENCE_DIGEST_MISMATCH',
      ])
    })

    const retried = await retryManagedWorkflow(seeded.workflowId, 'ticket-1')
    if (!retried.ok) throw new Error(retried.error.detail)
    expect(retried.value).toMatchObject({ status: 'READY', retriedNodes: ['ticket-1'] })
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('READY')

    const resumed = await tickUntil(
      seeded.workflowId,
      happyWorker(),
      (result) => result.status === 'DONE',
      40,
    )
    expect(resumed.at(-1)?.status).toBe('DONE')
  })

  it('reuses valid verify evidence for the same node binding and input', async () => {
    const plan = fixtureRoutePlan('S', 1)
    const seeded = await seedWorkflow(plan, { completionTarget: 'branch_ready' })
    const worker = workerWith(async (input) => {
      if (input.stage === 'execute') {
        const commit = await commitFile(input.workspace_path, 'src/feature.txt', 'feature\n')
        return success('execute', { commit, worktree_head: commit })
      }
      throw new Error(`stage ${input.stage} should have been reused`)
    })

    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'materialized')
    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'ticketed')

    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    const ticket = await asRole('keel_control', (c) =>
      c.query<{ baseline_commit: string; current_stage: string }>(
        'SELECT baseline_commit,current_stage FROM managed_ticket_task WHERE id=$1',
        [node.ticket_task_id],
      ),
    )
    const task = ticket.rows[0]
    if (task === undefined) throw new Error('缺少 ticket task')
    expect(task.current_stage).toBe('verify')
    const worktree = join(seeded.worktreeRoot, `${seeded.workflowId.slice(0, 8)}-ticket-1`)
    const current = await head(worktree)
    const diff = await diffDigest(worktree, task.baseline_commit, current)
    if (!diff.ok) throw new Error(diff.error.detail)
    const routePackage = fixtureRoutePackage({ completionTarget: 'branch_ready' })
    const verifyDefinition = routePackage.stage_templates.find((entry) => entry.stage === 'verify')
    if (verifyDefinition === undefined) throw new Error('缺少 verify stage')
    const stageDigest = sha256CanonicalJson({
      content_digest: verifyDefinition.content_digest,
      gate: sha256Text(verifyDefinition.gate),
      tool_profile: verifyDefinition.tool_profile,
    })
    const nodeBinding = sha256CanonicalJson({
      ticket_id: 'JT-TEST-1',
      scope_paths: node.scope_paths,
      acceptance: node.acceptance,
    })
    const targetDigest = sha256CanonicalJson({
      stage: 'verify',
      node_binding: nodeBinding,
      stage_digest: stageDigest,
      input_commit: current,
      diff_digest: diff.value,
      branch: '',
    })
    const evidenceResult = await asRole('keel_control', (c) =>
      insertWorkflowEvidence(c, {
        workflow_id: seeded.workflowId,
        graph_version: 1,
        node_id: node.id,
        stage: 'verify',
        input_commit: current,
        diff_digest: diff.value,
        stage_digest: stageDigest,
        branch: '',
        target_digest: targetDigest,
        result_digest: sha256CanonicalJson({ reused: true }),
        evidence_digest: sha256CanonicalJson({ fixture: true }),
        result: { status: 'completed', stage: 'verify' },
        evidence: { reused: true },
      }),
    )
    expect(evidenceResult.id).toBeTruthy()

    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'ticketed')
    const stages = await asRole('keel_control', (c) =>
      c.query<{ stage: string; status: string; reused_from_evidence_id: string | null }>(
        'SELECT stage,status,reused_from_evidence_id FROM managed_ticket_stage WHERE task_id=$1 ORDER BY started_at',
        [node.ticket_task_id],
      ),
    )
    const verify = stages.rows.find((record) => record.stage === 'verify')
    expect(verify?.status).toBe('REUSED')
    expect(verify?.reused_from_evidence_id).toBe(evidenceResult.id)
  })

  it('allows replanning only before nodes execute and preserves graph versions', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('M', 2), {
      completionTarget: 'branch_ready',
    })
    const replanned = await commitManagedWorkflowPlan(
      seeded.workflowId,
      fixtureRoutePlan('M', 3),
      true,
    )
    expect(replanned.ok).toBe(true)
    const projection = await getManagedWorkflowProjection(seeded.workflowId)
    if (!projection.ok) throw new Error(projection.error.detail)
    expect(projection.value.workflow.current_graph_version).toBe(2)
    expect(projection.value.graph?.version).toBe(2)
    expect(
      await asRole('keel_control', (c) =>
        c.query<{ status: string }>(
          'SELECT status FROM managed_workflow_graph WHERE workflow_id=$1 AND version=1',
          [seeded.workflowId],
        ),
      ),
    ).toMatchObject({ rows: [{ status: 'SUPERSEDED' }] })

    const worker = happyWorker()
    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'materialized')
    const late = await commitManagedWorkflowPlan(seeded.workflowId, fixtureRoutePlan('M', 2), true)
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error.detail).toContain('不能替换图')
  })

  it('rejects a second managed workflow claiming the same issue', async () => {
    const first = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
      externalIssue: 'jionpz/keel#92',
    })
    expect(first.workflowId).toBeTruthy()

    const base = await mkdtemp(join(tmpdir(), 'keel-workflow-'))
    const packagePath = join(base, 'route-package.json')
    await writeFile(
      packagePath,
      JSON.stringify(fixtureRoutePackage({ completionTarget: 'branch_ready' })),
    )
    const second = await createManagedWorkflow(first.repoId, packagePath, 'duplicate issue', {
      scopePaths: ['src'],
      worktreeRoot: join(base, 'worktrees'),
      externalIssue: 'jionpz/keel#92',
    })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe('CONFLICT')
  })

  it('refuses archive when stage evidence is missing', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    const worker = workerWith(async (input) => {
      if (input.stage !== 'execute') throw new Error('only execute should run')
      const commit = await commitFile(input.workspace_path, 'src/feature.txt', 'feature\n')
      return success('execute', { commit, worktree_head: commit })
    })
    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'materialized')
    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'ticketed')

    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    const ticket = await asRole('keel_control', (c) =>
      c.query<{ baseline_commit: string; current_stage: string }>(
        'SELECT baseline_commit,current_stage FROM managed_ticket_task WHERE id=$1',
        [node.ticket_task_id],
      ),
    )
    const task = ticket.rows[0]
    if (task === undefined) throw new Error('缺少 ticket task')
    const worktree = join(seeded.worktreeRoot, `${seeded.workflowId.slice(0, 8)}-ticket-1`)
    const current = await head(worktree)
    await asOwner((c) =>
      c.query(
        `UPDATE managed_ticket_task
         SET status='PR_READY',handoff=$2::jsonb,lease_token=NULL,lease_until=NULL
         WHERE id=$1`,
        [
          node.ticket_task_id,
          JSON.stringify({
            head_sha: current,
            diff_digest: 'fixture',
            check_gate: { status: 'READY', evidence_digest: 'fixture' },
          }),
        ],
      ),
    )
    void task

    const result = await tickManagedWorkflow(worker, seeded.workflowId)
    expect(result.ok).toBe(true)
    const projection = await getManagedWorkflowProjection(seeded.workflowId)
    if (!projection.ok) throw new Error(projection.error.detail)
    expect(projection.value.workflow.status).not.toBe('DONE')
    expect(projection.value.nodes[0]?.status).toBe('PR_READY')
    expect(projection.value.evidence.some((evidence) => evidence.stage === 'archive')).toBe(false)
  })

  it('rejects execute changes outside the node scope', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    const worker = workerWith(async (input) => {
      if (input.stage !== 'execute') throw new Error('only execute should run')
      const commit = await commitFile(input.workspace_path, 'README.md', 'outside scope\n')
      return success('execute', { commit, worktree_head: commit })
    })
    await tickUntil(seeded.workflowId, worker, (result) => result.action === 'materialized')
    const result = await tickManagedWorkflow(worker, seeded.workflowId)
    expect(result.ok).toBe(true)

    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(node.status).toBe('FAILED')
    const ticket = await asRole('keel_control', (c) =>
      c.query<{ last_error: string }>('SELECT last_error FROM managed_ticket_task WHERE id=$1', [
        node.ticket_task_id,
      ]),
    )
    expect(ticket.rows[0]?.last_error).toBe('SCOPE_VIOLATION')
  })
})
