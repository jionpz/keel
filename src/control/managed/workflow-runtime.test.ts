import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  ManagedTicketStageRunner,
  ManagedWorkflowTickResult,
} from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool, getPool } from '../../fact/db.js'
import type { DelegationPolicyVersion, JstackRoutePlan } from '../../generated/managed.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'
import { claimActionOutbox, enqueueActionIntent, issuePermit, retryAction } from './action-store.js'
import { answerManagedTicketDecision, recordDelegationPolicy } from './decision-store.js'
import { fixtureRoutePackage, fixtureRoutePlan } from './route-test-utils.js'
import { cancelManagedTicket, pauseManagedTicket } from './ticket-control.js'
import { type ManagedTicketWorker, tickManagedTicket } from './ticket-runtime.js'
import { claimManagedTicketTask, withManagedTicketClaim } from './ticket-store.js'
import { diffDigest } from './ticket-workspace.js'
import { cancelManagedWorkflow } from './workflow-control.js'
import {
  commitManagedWorkflowPlan,
  createManagedWorkflow,
  getManagedWorkflowProjection,
  retryManagedWorkflow,
  tickManagedWorkflow,
} from './workflow-runtime.js'
import {
  claimManagedWorkflow,
  insertWorkflowEvidence,
  withManagedWorkflowClaim,
} from './workflow-store.js'

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
    readonly importPlan?: boolean
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
  if (options.importPlan !== false) {
    const committed = await commitManagedWorkflowPlan(created.value, plan)
    if (!committed.ok) throw new Error(committed.error.detail)
  }
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

describe('managed workflow cancellation', () => {
  const now = () => new Date().toISOString()
  const reason = 'owner confirmed replacement workflow'

  function issuePlan(): JstackRoutePlan {
    const plan = fixtureRoutePlan('M', 2)
    return {
      ...plan,
      tickets: plan.tickets.map((ticket, index) => ({
        ...ticket,
        external_issue: `fixture/repo#${index + 1}`,
      })),
    } as JstackRoutePlan
  }

  async function materialized() {
    const seeded = await seedWorkflow(issuePlan(), { externalIssue: 'fixture/repo#parent' })
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    return { ...seeded, node: await nodeRow(seeded.workflowId, 'ticket-1') }
  }

  async function actionFor(taskId: string, repoId: string) {
    return asRole('keel_control', (c) =>
      enqueueActionIntent(c, {
        task_id: taskId,
        project_id: repoId,
        repo_id: repoId,
        remote_url: 'https://github.com/fixture/repo.git',
        base_branch: 'main',
        head_branch: 'ai/fixture',
        head_sha: 'a'.repeat(40),
        diff_digest: 'b'.repeat(64),
        environment: 'local',
        reversibility: 'reversible',
        affected_resources: ['fixture branch'],
        pr_title: 'fixture',
        pr_body: 'fixture',
        created_at: now(),
      }),
    )
  }

  it('取消待答和依赖节点，保留失败证据，交接全部 claim，重复取消不释放新 owner', async () => {
    const seeded = await materialized()
    const stopWorker = workerWith(async (input) =>
      success(input.stage, { status: 'must_stop', summary: 'verify environment requires owner' }),
    )
    await tickManagedWorkflow(stopWorker, seeded.workflowId)
    const before = await asRole('keel_control', async (c) => ({
      task: (
        await c.query('SELECT * FROM managed_ticket_task WHERE id=$1', [seeded.node.ticket_task_id])
      ).rows[0],
      stages: (await c.query('SELECT * FROM managed_ticket_stage ORDER BY id')).rows,
    }))
    expect(before.task.status).toBe('WAITING_HUMAN')
    const replacement = await createManagedWorkflow(
      seeded.repoId,
      join(dirname(seeded.repo), 'route-package.json'),
      'replacement',
      { scopePaths: ['src'], worktreeRoot: join(seeded.worktreeRoot, 'replacement') },
    )
    if (!replacement.ok) throw new Error(replacement.error.detail)
    expect((await commitManagedWorkflowPlan(replacement.value, issuePlan())).ok).toBe(false)

    const cancelled = await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())
    if (!cancelled.ok) throw new Error(cancelled.error.detail)
    expect(cancelled.value.cancelledTaskIds).toEqual([seeded.node.ticket_task_id])
    expect(cancelled.value.releasedClaimIds).toHaveLength(3)
    const after = await asRole('keel_control', async (c) => ({
      task: (
        await c.query('SELECT * FROM managed_ticket_task WHERE id=$1', [seeded.node.ticket_task_id])
      ).rows[0],
      request: (
        await c.query('SELECT status FROM managed_decision_request WHERE id=$1', [
          before.task.pending_decision_id,
        ])
      ).rows[0],
      stages: (await c.query('SELECT * FROM managed_ticket_stage ORDER BY id')).rows,
    }))
    expect(after.task).toMatchObject({
      status: 'CANCELLED',
      control_generation: before.task.control_generation + 1,
      baseline_commit: before.task.baseline_commit,
      package_digest: before.task.package_digest,
      attempts: before.task.attempts,
      pending_decision_id: null,
      pending_decision_revision: null,
      lease_token: null,
    })
    expect(after.request.status).toBe('CANCELLED')
    expect(after.stages).toEqual(before.stages)
    expect(await git(before.task.worktree_path, 'status', '--porcelain')).toBe('')
    expect((await commitManagedWorkflowPlan(replacement.value, issuePlan())).ok).toBe(true)
    expect(await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).toMatchObject({
      ok: true,
      value: cancelled.value,
    })
    const active = await asRole('keel_control', (c) =>
      c.query(`SELECT * FROM managed_issue_claim WHERE status='ACTIVE'`),
    )
    expect(active.rows).toHaveLength(2)
    const old = await getManagedWorkflowProjection(seeded.workflowId)
    if (!old.ok) throw new Error(old.error.detail)
    expect(old.value.workflow.status).toBe('CANCELLED')
    expect(old.value.nodes.every((node) => node.status === 'CANCELLED')).toBe(true)
    expect((await retryManagedWorkflow(seeded.workflowId)).ok).toBe(false)
    expect(await tickManagedWorkflow(happyWorker(), seeded.workflowId)).toMatchObject({
      ok: true,
      value: null,
    })
  })

  it('拒绝错误图版本、无效参数与不存在流程，不改 claim', async () => {
    const seeded = await materialized()
    expect(await cancelManagedWorkflow(seeded.workflowId, 2, reason, now())).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
    expect((await cancelManagedWorkflow(seeded.workflowId, -1, reason, now())).ok).toBe(false)
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, '', now())).ok).toBe(false)
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, 'bad')).ok).toBe(false)
    expect(await cancelManagedWorkflow(randomUUID(), 1, reason, now())).toMatchObject({
      ok: false,
      error: { kind: 'NOT_FOUND' },
    })
    const claims = await asRole('keel_control', (c) =>
      c.query(`SELECT id FROM managed_issue_claim WHERE status='ACTIVE'`),
    )
    expect(claims.rowCount).toBe(3)
  })

  it('拒绝正在执行的 workflow 或 ticket，保留原租约', async () => {
    const seeded = await materialized()
    const workflowClaim = await claimManagedWorkflow(now(), seeded.workflowId)
    if (workflowClaim === null) throw new Error('missing workflow claim')
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(false)
    expect((await withManagedWorkflowClaim(workflowClaim, async () => true)).ok).toBe(true)
    await asRole('keel_control', (c) =>
      c.query(`UPDATE managed_workflow SET status='READY',lease_token=NULL WHERE id=$1`, [
        seeded.workflowId,
      ]),
    )
    const ticketClaim = await claimManagedTicketTask(now(), seeded.node.ticket_task_id)
    if (ticketClaim === null) throw new Error('missing ticket claim')
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(false)
    expect((await withManagedTicketClaim(ticketClaim, async () => true)).ok).toBe(true)
  })

  it('完成静止交接后拒绝旧 ticket 和 workflow 的迟到结果', async () => {
    const seeded = await materialized()
    const workflowClaim = await claimManagedWorkflow(now(), seeded.workflowId)
    const ticketClaim = await claimManagedTicketTask(now(), seeded.node.ticket_task_id)
    if (workflowClaim === null || ticketClaim === null) throw new Error('missing claim')
    await pauseManagedTicket(seeded.node.ticket_task_id, 'quiesce', now())
    await asRole('keel_control', (c) =>
      c.query(
        `UPDATE managed_workflow SET status='PAUSED',lease_token=NULL,lease_until=NULL WHERE id=$1`,
        [seeded.workflowId],
      ),
    )
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(true)
    expect((await withManagedTicketClaim(ticketClaim, async () => true)).ok).toBe(false)
    expect((await withManagedWorkflowClaim(workflowClaim, async () => true)).ok).toBe(false)
  })

  it('保留 FAILED 节点原状态，取消父流程后不可重试', async () => {
    const seeded = await materialized()
    await pauseManagedTicket(seeded.node.ticket_task_id, 'failed verification', now())
    await tickManagedWorkflow(happyWorker(), seeded.workflowId)
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('FAILED')
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(true)
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('FAILED')
    expect((await retryManagedWorkflow(seeded.workflowId, 'ticket-1')).ok).toBe(false)
  })

  it('保留已归档前驱及其 claim，只释放未完成后继', async () => {
    const seeded = await seedWorkflow(issuePlan(), { completionTarget: 'branch_ready' })
    for (let tick = 0; tick < 10; tick += 1) {
      await tickManagedWorkflow(happyWorker(), seeded.workflowId)
      if ((await nodeRow(seeded.workflowId, 'ticket-1')).status === 'ARCHIVED') break
    }
    const first = await nodeRow(seeded.workflowId, 'ticket-1')
    expect(first.status).toBe('ARCHIVED')
    const cancelled = await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())
    if (!cancelled.ok) throw new Error(cancelled.error.detail)
    expect(cancelled.value.releasedClaimIds).toHaveLength(1)
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('ARCHIVED')
    const active = await asRole('keel_control', (c) =>
      c.query(`SELECT owner_id FROM managed_issue_claim WHERE status='ACTIVE'`),
    )
    expect(active.rows).toEqual([{ owner_id: first.id }])
  })

  it('并发持有 ticket 锁时快速返回冲突，事务没有部分取消', async () => {
    const seeded = await materialized()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM managed_ticket_task WHERE id=$1 FOR UPDATE', [
        seeded.node.ticket_task_id,
      ])
      expect(await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).toMatchObject({
        ok: false,
        error: { kind: 'CONFLICT' },
      })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(true)
  })

  it('阻断尚未执行的 outbox，重试不能复活动作', async () => {
    const seeded = await materialized()
    const action = await actionFor(seeded.node.ticket_task_id, seeded.repoId)
    const cancelled = await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())
    if (!cancelled.ok) throw new Error(cancelled.error.detail)
    expect(cancelled.value.blockedOutboxIds).toEqual([action.outboxId])
    const outbox = await asRole('keel_control', (c) =>
      c.query('SELECT status FROM managed_action_outbox WHERE id=$1', [action.outboxId]),
    )
    expect(outbox.rows[0].status).toBe('BLOCKED')
    await expect(retryAction(action.outboxId, now())).rejects.toThrow(
      'managed ticket terminal record is immutable',
    )
    const after = await asRole('keel_control', (c) =>
      c.query('SELECT status FROM managed_action_outbox WHERE id=$1', [action.outboxId]),
    )
    expect(after.rows[0].status).toBe('BLOCKED')
  })

  it('许可被 gateway 共享锁定时立即冲突且零副作用，释放锁后撤销许可并完成交接', async () => {
    const seeded = await materialized()
    const action = await actionFor(seeded.node.ticket_task_id, seeded.repoId)
    const at = now()
    const policy: DelegationPolicyVersion = {
      schema_version: '1.0',
      id: randomUUID(),
      policy_id: 'fixture-delivery',
      version: 1,
      project_id: seeded.repoId,
      approved_by_owner: 'owner',
      approved_at: at,
      valid_from: at,
      created_at: at,
      rules: [
        {
          id: 'push-pr',
          decision_kinds: ['approval'],
          actions: ['push_and_pr'],
          resource_selectors: ['*'],
          environments: ['local'],
          reversibility: 'reversible',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['reversible'],
            max_affected_resources: 8,
          },
          budget_limits: {},
          required_evidence: [],
          required_checks: [],
          mode: 'delegated',
        },
      ],
    }
    const recorded = await recordDelegationPolicy(policy)
    if (!recorded.ok) throw new Error(recorded.error.detail)
    const claim = await claimActionOutbox(at)
    if (claim === null) throw new Error('missing action claim')
    const permit = await issuePermit(
      claim,
      {
        ok: true,
        kind: 'delegation_policy',
        policy_id: policy.id,
        policy_version: 1,
        rule_id: 'push-pr',
        digest: 'a'.repeat(64),
        required_checks: [],
        budget: {},
      },
      at,
    )
    const snapshot = () =>
      asRole('keel_control', async (c) => ({
        workflow: (await c.query('SELECT * FROM managed_workflow')).rows,
        tasks: (await c.query('SELECT * FROM managed_ticket_task')).rows,
        outbox: (await c.query('SELECT * FROM managed_action_outbox')).rows,
        permits: (await c.query('SELECT * FROM managed_execution_permit')).rows,
        claims: (await c.query('SELECT * FROM managed_issue_claim ORDER BY id')).rows,
        events: (await c.query('SELECT * FROM managed_workflow_event ORDER BY seq')).rows,
      }))
    const before = await snapshot()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM managed_execution_permit WHERE id=$1 FOR SHARE', [
        permit.id,
      ])
      await expect(
        cancelManagedWorkflow(seeded.workflowId, 1, reason, now()),
      ).resolves.toMatchObject({ ok: false, error: { kind: 'CONFLICT' } })
      expect(await snapshot()).toEqual(before)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    const cancelled = await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())
    expect(cancelled).toMatchObject({
      ok: true,
      value: { blockedOutboxIds: [action.outboxId] },
    })
    const after = await snapshot()
    expect(after.permits[0].status).toBe('REVOKED')
    expect(after.outbox[0].status).toBe('BLOCKED')
  })

  it('并发人工答复持有 decision 锁时不死锁，也不留下部分取消', async () => {
    const seeded = await materialized()
    await tickManagedWorkflow(
      workerWith(async (input) => success(input.stage, { status: 'must_stop' })),
      seeded.workflowId,
    )
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'SELECT id FROM managed_decision_request WHERE managed_ticket_task_id=$1 FOR UPDATE',
        [seeded.node.ticket_task_id],
      )
      expect(await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).toMatchObject({
        ok: false,
        error: { kind: 'CONFLICT' },
      })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('WAITING_HUMAN')
    expect((await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).ok).toBe(true)
  })

  it.each(['EXECUTING', 'UNCERTAIN', 'SUCCEEDED'])(
    '%s 外部动作阻止所有权交接，原状态和 claim 不变',
    async (status) => {
      const seeded = await materialized()
      const action = await actionFor(seeded.node.ticket_task_id, seeded.repoId)
      await asRole('keel_control', async (c) => {
        await c.query(`UPDATE managed_action_outbox SET status='LEASED' WHERE id=$1`, [
          action.outboxId,
        ])
        await c.query(`UPDATE managed_action_outbox SET status='EXECUTING' WHERE id=$1`, [
          action.outboxId,
        ])
        if (status !== 'EXECUTING') {
          await c.query(`UPDATE managed_action_outbox SET status=$2 WHERE id=$1`, [
            action.outboxId,
            status,
          ])
        }
      })
      expect(await cancelManagedWorkflow(seeded.workflowId, 1, reason, now())).toMatchObject({
        ok: false,
        error: { kind: 'CONFLICT' },
      })
      const active = await asRole('keel_control', (c) =>
        c.query(`SELECT id FROM managed_issue_claim WHERE status='ACTIVE'`),
      )
      expect(active.rowCount).toBe(3)
    },
  )
})

describe('managed workflow runtime', () => {
  it('does not materialize a dependent ticket before its predecessor passes archive', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('M', 2), {
      completionTarget: 'branch_ready',
    })
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    for (let index = 0; index < 4; index += 1) {
      const ticked = await tickManagedTicket(happyWorker(), node.ticket_task_id)
      if (!ticked.ok) throw new Error(ticked.error.detail)
    }
    await asRole('keel_control', (c) =>
      c.query(
        `UPDATE managed_workflow_evidence SET status='INVALIDATED',
           invalidated_at=now(),invalidated_reason='invalid predecessor evidence'
         WHERE node_id=$1 AND stage='verify'`,
        [node.id],
      ),
    )
    const result = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value?.status).toBe('PAUSED')
    expect((await nodeRow(seeded.workflowId, 'ticket-2')).status).toBe('PENDING')
  })

  it.each(['invalidated_verify', 'dirty_worktree', 'wrong_check_head'] as const)(
    'refuses archive with %s even when all four stages succeeded',
    async (problem) => {
      const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
        completionTarget: problem === 'wrong_check_head' ? 'pr_ready' : 'branch_ready',
      })
      await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
      const node = await nodeRow(seeded.workflowId, 'ticket-1')
      const worker = workerWith(async (input) => {
        const result = await happyWorker().run(input)
        if (!result.ok) throw new Error(result.error.detail)
        const output = { ...result.value.output } as Record<string, unknown>
        delete output.requested_action
        return output
      })
      for (let index = 0; index < 4; index += 1) {
        const ticked = await tickManagedTicket(worker, node.ticket_task_id)
        if (!ticked.ok) throw new Error(ticked.error.detail)
      }
      const worktree = join(seeded.worktreeRoot, `${seeded.workflowId.slice(0, 8)}-ticket-1`)
      if (problem === 'invalidated_verify') {
        await asRole('keel_control', (c) =>
          c.query(
            `UPDATE managed_workflow_evidence SET status='INVALIDATED',
               invalidated_at=now(),invalidated_reason='operator invalidated proof'
             WHERE node_id=$1 AND stage='verify'`,
            [node.id],
          ),
        )
      } else if (problem === 'dirty_worktree') {
        await writeFile(join(worktree, 'src', 'unverified.txt'), 'drift\n')
      } else {
        const current = await head(worktree)
        const baseline = await git(seeded.repo, 'rev-parse', 'HEAD')
        const diff = await diffDigest(worktree, baseline, current)
        if (!diff.ok) throw new Error(diff.error.detail)
        await asOwner((c) =>
          c.query(
            `UPDATE managed_ticket_task SET status='PR_READY',handoff=$2::jsonb WHERE id=$1`,
            [
              node.ticket_task_id,
              JSON.stringify({
                head_sha: current,
                diff_digest: diff.value,
                check_gate: {
                  status: 'READY',
                  head_sha: '0'.repeat(40),
                  evidence_digest: sha256Text('stale checks'),
                },
              }),
            ],
          ),
        )
      }
      const result = await tickManagedWorkflow(worker, seeded.workflowId)
      if (!result.ok) throw new Error(result.error.detail)
      expect(result.value?.status).toBe('PAUSED')
      const projection = await getManagedWorkflowProjection(seeded.workflowId)
      if (!projection.ok) throw new Error(projection.error.detail)
      expect(projection.value.workflow.last_error).toContain('archive')
      expect(projection.value.evidence.some((e) => e.stage === 'archive')).toBe(false)
      const idle = await tickManagedWorkflow(worker, seeded.workflowId)
      expect(idle).toEqual({ ok: true, value: null })
      if (problem === 'dirty_worktree') {
        await unlink(join(worktree, 'src', 'unverified.txt'))
        const retried = await retryManagedWorkflow(seeded.workflowId, 'ticket-1')
        expect(retried.ok).toBe(true)
        const archived = await tickManagedWorkflow(worker, seeded.workflowId)
        if (!archived.ok) throw new Error(archived.error.detail)
        expect(archived.value?.status).toBe('DONE')
        const attempts = await asRole('keel_control', (c) =>
          c.query('SELECT id FROM managed_ticket_stage WHERE task_id=$1', [node.ticket_task_id]),
        )
        expect(attempts.rowCount).toBe(4)
      }
    },
  )

  it('persists planning workspace failures before reporting PAUSED', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), { importPlan: false })
    await asOwner((c) =>
      c.query('UPDATE repo SET local_path=$2 WHERE id=$1', [
        seeded.repoId,
        join(seeded.repo, 'missing'),
      ]),
    )
    const result = await tickManagedWorkflow(
      {
        ...happyWorker(),
        plan: async () => {
          throw new Error('planner must not run')
        },
      },
      seeded.workflowId,
    )
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value).toMatchObject({ status: 'PAUSED', action: 'workspace_error' })
    const projection = await getManagedWorkflowProjection(seeded.workflowId)
    if (!projection.ok) throw new Error(projection.error.detail)
    expect(projection.value.workflow).toMatchObject({
      status: 'PAUSED',
      lease_token: null,
      lease_until: null,
      last_error: result.value?.error,
    })
  })

  it('holds its workflow lease while a ticket stage is executing', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    const worker = workerWith(async (input) => {
      const concurrent = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
      expect(concurrent).toEqual({ ok: true, value: null })
      const result = await happyWorker().run(input)
      if (!result.ok) throw new Error(result.error.detail)
      return result.value.output as unknown as Record<string, unknown>
    })
    const ticked = await tickManagedWorkflow(worker, seeded.workflowId)
    if (!ticked.ok) throw new Error(ticked.error.detail)
    expect(ticked.value?.action).toBe('ticketed')
  })

  it.each(['execute', 'land'] as const)(
    'returns CONFLICT when its workflow lease expires during %s',
    async (stage) => {
      const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
        completionTarget: 'branch_ready',
      })
      await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
      if (stage === 'land') {
        for (let index = 0; index < 3; index += 1) {
          const advanced = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
          if (!advanced.ok) throw new Error(advanced.error.detail)
        }
      }
      const worker = workerWith(async (input) => {
        await asOwner((c) =>
          c.query(`UPDATE managed_workflow SET lease_until=now()-interval '1 second' WHERE id=$1`, [
            seeded.workflowId,
          ]),
        )
        const result = await happyWorker().run(input)
        if (!result.ok) throw new Error(result.error.detail)
        return result.value.output as unknown as Record<string, unknown>
      })
      const result = await tickManagedWorkflow(worker, seeded.workflowId)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('CONFLICT')
      const projection = await getManagedWorkflowProjection(seeded.workflowId)
      if (!projection.ok) throw new Error(projection.error.detail)
      expect(projection.value.evidence.some((e) => e.stage === 'archive')).toBe(false)
    },
  )

  it('reports cancellation instead of completion when a dependency is cancelled', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('M', 2), {
      completionTarget: 'branch_ready',
    })
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    const cancelled = await cancelManagedTicket(
      node.ticket_task_id,
      'operator cancelled',
      new Date().toISOString(),
    )
    expect(cancelled.ok).toBe(true)

    const result = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value?.status).toBe('CANCELLED')
    expect((await nodeRow(seeded.workflowId, 'ticket-2')).status).toBe('PENDING')
  })

  it('synchronizes a resumed ticket before choosing the next stage', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1), {
      completionTarget: 'branch_ready',
    })
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    await asOwner((c) =>
      c.query(`UPDATE managed_workflow_node SET status='WAITING_HUMAN' WHERE id=$1`, [node.id]),
    )
    const result = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value?.action).toBe('ticketed')
    const stages = await asRole('keel_control', (c) =>
      c.query('SELECT stage,status FROM managed_ticket_stage WHERE task_id=$1', [
        node.ticket_task_id,
      ]),
    )
    expect(stages.rows).toEqual([{ stage: 'execute', status: 'SUCCEEDED' }])
  })

  it('does not keep an old PR_READY node after its ticket is paused', async () => {
    const seeded = await seedWorkflow(fixtureRoutePlan('S', 1))
    await tickUntil(seeded.workflowId, happyWorker(), (r) => r.action === 'materialized')
    const node = await nodeRow(seeded.workflowId, 'ticket-1')
    await asOwner((c) =>
      c.query(`UPDATE managed_workflow_node SET status='PR_READY' WHERE id=$1`, [node.id]),
    )
    const paused = await pauseManagedTicket(
      node.ticket_task_id,
      'operator paused',
      new Date().toISOString(),
    )
    expect(paused.ok).toBe(true)

    const result = await tickManagedWorkflow(happyWorker(), seeded.workflowId)
    if (!result.ok) throw new Error(result.error.detail)
    expect(result.value?.status).toBe('PAUSED')
    expect((await nodeRow(seeded.workflowId, 'ticket-1')).status).toBe('FAILED')
  })

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
    // 私有提交只存在于各节点副本，串行后继无需先污染宿主对象库或 refs。
    const [first, second] = projection.value.nodes
    expect(second?.base_commit).toBe(first?.output_commit)
    for (const node of projection.value.nodes) {
      expect(await git(node.worktree_path as string, 'rev-parse', '--git-common-dir')).toBe('.git')
      await expect(
        git(seeded.repo, 'cat-file', '-e', `${node.output_commit}^{commit}`),
      ).rejects.toThrow()
    }
    expect(
      (await git(seeded.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).split('\n'),
    ).toEqual(['refs/heads/main'])
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
    const completed = await tickUntil(
      seeded.workflowId,
      worker,
      (result) => result.status === 'WAITING_HUMAN',
    )
    expect(completed.at(-1)?.status).toBe('WAITING_HUMAN')
    expect((await nodeRow(seeded.workflowId, 'ticket-2')).status).toBe('ARCHIVED')
    const idle = await tickManagedWorkflow(worker, seeded.workflowId)
    expect(idle).toEqual({ ok: true, value: null })
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
    expect(projection.value.workflow.status).toBe('PAUSED')
    expect(projection.value.workflow.last_error).toContain('archive')
    expect(projection.value.nodes[0]?.status).toBe('FAILED')
    expect(projection.value.nodes[0]?.last_error).toContain('archive')
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
