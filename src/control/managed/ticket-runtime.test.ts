import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { makeError } from '../../contracts/errors.js'
import type { ManagedTicketStageRunner } from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type { ManagedTicketStageResult } from '../../generated/managed.js'
import { sha256Text } from '../../shared/canonical-json.js'
import { MANAGED_STAGE_CLEANUP_MS, MANAGED_STAGE_TIMEOUT_MS } from '../../shared/managed-limits.js'
import {
  answerManagedTicketDecision,
  recordDelegationPolicy,
  recordProjectDecision,
} from './decision-store.js'
import {
  createManagedTicketTask,
  getManagedTicket,
  type ManagedTicketWorker,
  tickManagedTicket,
} from './ticket-runtime.js'
import { listManagedTicketStages } from './ticket-store.js'
import { fixtureTicketPackage } from './ticket-test-utils.js'
import { diffDigest } from './ticket-workspace.js'

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

async function commitFile(cwd: string, name: string, body: string): Promise<string> {
  await writeFile(join(cwd, name), body)
  await git(cwd, 'add', name)
  await git(cwd, 'commit', '-m', `update ${name}`)
  return head(cwd)
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
  handler: (input: Parameters<ManagedTicketStageRunner>[0]) => Promise<ManagedTicketStageResult>,
): ManagedTicketWorker {
  return {
    harness: 'pi',
    toolInventory: workerTools,
    run: async (input) => ({
      ok: true,
      value: { output: await handler(input), usage: ZERO_USAGE },
    }),
  }
}

function success(
  stage: ManagedTicketStageResult['stage'],
  extra: Partial<ManagedTicketStageResult> = {},
): ManagedTicketStageResult {
  return {
    schema_version: '1.0',
    stage,
    status: 'completed',
    summary: `${stage} completed`,
    ...extra,
  }
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

async function seed(): Promise<{
  repoId: string
  root: string
  base: string
  packagePath: string
  taskId: string
}> {
  const base = await mkdtemp(join(tmpdir(), 'keel-ticket-'))
  const root = join(base, 'repo')
  await run('git', ['init', '-b', 'main', root])
  await git(root, 'config', 'user.name', 'Keel Test')
  await git(root, 'config', 'user.email', 'keel@example.test')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'initial')
  await git(root, 'checkout', '-b', 'ai/ticket-test')
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
       VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${root}`, root],
    ),
  )
  const packagePath = join(base, 'ticket-package.json')
  await writeFile(packagePath, JSON.stringify(fixtureTicketPackage()))
  const created = await createManagedTicketTask(repoId, packagePath, root)
  if (!created.ok) throw new Error(created.error.detail)
  return { repoId, root, base, packagePath, taskId: created.value }
}

function happyWorker(root: string): ManagedTicketWorker {
  return workerWith(async (input) => {
    if (input.stage === 'execute') {
      const commit = await commitFile(root, 'feature.txt', 'implemented\n')
      return success('execute', { commit, worktree_head: commit })
    }
    const current = await head(root)
    if (input.stage === 'verify') {
      return success('verify', {
        worktree_head: current,
        checks: [
          {
            command: 'git status --porcelain',
            exit_code: 0,
            passed: true,
            output_digest: '0'.repeat(64),
            output_excerpt: 'clean',
          },
        ],
      })
    }
    if (input.stage === 'review') {
      const digest = await diffDigest(root, input.baseline_commit, current)
      if (!digest.ok) throw new Error(digest.error.detail)
      return success('review', {
        review: {
          reviewed_commit: current,
          diff_digest: digest.value,
          findings: [
            {
              id: 'f-1',
              severity: 'low',
              summary: 'fixture finding',
              disposition: 'dismissed',
              reason: 'fixture is intentional',
            },
          ],
        },
      })
    }
    return success('land', {
      land: {
        branch: 'ai/ticket-test',
        commit: current,
        action_intent: {
          kind: 'push_and_pr',
          remote: 'origin',
          pr_title: 'fixture ticket',
          pr_body: 'fixture body',
        },
      },
    })
  })
}

describe('managed ticket runtime', () => {
  it('租约覆盖阶段超时及清理，失去租约时不谎报失败状态已落库', async () => {
    const { taskId } = await seed()
    const worker: ManagedTicketWorker = {
      harness: 'pi',
      toolInventory: workerTools,
      run: async () => {
        await asRole('keel_control', async (client) => {
          const remaining = await client.query<{ seconds: number }>(
            `SELECT EXTRACT(EPOCH FROM (lease_until-clock_timestamp()))::float8 AS seconds
             FROM managed_ticket_task WHERE id=$1`,
            [taskId],
          )
          expect(remaining.rows[0]?.seconds).toBeGreaterThan(
            (MANAGED_STAGE_TIMEOUT_MS + MANAGED_STAGE_CLEANUP_MS) / 1000,
          )
          await client.query(
            `UPDATE managed_ticket_task SET lease_until=clock_timestamp()-interval '1 second'
             WHERE id=$1`,
            [taskId],
          )
        })
        return { ok: false, error: makeError('RUN_TIMEOUT', 'expired claim'), usage: ZERO_USAGE }
      },
    }
    const result = await tickManagedTicket(worker, taskId)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('过期租约不应报告成功')
    expect(result.error.kind).toBe('CONFLICT')
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('RUNNING')
  })

  it('天问按项目决定解决偏好问题后把 ticket 放回 READY', async () => {
    const { repoId, taskId } = await seed()
    const decisionId = randomUUID()
    let observedMemory: unknown = null
    const recorded = await recordProjectDecision({
      schema_version: '1.0',
      id: decisionId,
      project_id: repoId,
      decision_key: 'ticket.e2e.style',
      version: 1,
      statement: 'E2E 文档使用中文',
      selected_option_id: 'option-1',
      options: [
        { id: 'option-1', text: '使用中文' },
        { id: 'option-2', text: '使用英文' },
      ],
      scope: {
        decision_kinds: ['preference'],
        actions: ['ticket_stage'],
        resource_selectors: ['*'],
        environments: ['local'],
        reversibilities: ['reversible'],
      },
      source_type: 'owner_confirmed',
      source_ref: 'e2e-fixture',
      created_by: 'owner:test',
      valid_from: new Date(Date.now() - 60_000).toISOString(),
      created_at: new Date().toISOString(),
    })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) throw new Error(recorded.error.detail)

    const worker: ManagedTicketWorker = {
      ...workerWith(async () => ({
        schema_version: '1.0',
        stage: 'execute',
        status: 'blocked',
        summary: '需要确认文档语言',
        decision: {
          decision_key: 'ticket.e2e.style',
          kind: 'preference',
          question: 'E2E 文档使用哪种语言？',
          options: ['使用中文', '使用英文'],
          action_category: 'ticket_stage',
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: ['fixture'],
          },
        },
      })),
      decide: async (input) => {
        const facts = input.context.sections.find((section) => section.id === 'facts')
        if (facts !== undefined) {
          const snapshot = JSON.parse(facts.content) as { project_memory?: unknown }
          observedMemory = snapshot.project_memory
        }
        return {
          ok: true,
          value: {
            output: {
              recommendation: 'answer',
              answer_option_id: 'option-1',
              rationale: '项目决定要求使用中文',
              basis_refs: [{ kind: 'project_decision', id: decisionId, version: 1 }],
              assumptions: [],
              alternatives: [],
              unresolved_conflicts: [],
              missing_authority: [],
            },
            usage: ZERO_USAGE,
          },
        }
      },
    }
    const paused = await tickManagedTicket(worker, taskId)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.ok).toBe(true)
    expect(paused.value?.status).toBe('READY')
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('READY')
    expect(task.value.pending_decision_id).toBeNull()
    const request = (
      await asRole('keel_control', (c) =>
        c.query<{ id: string; status: string; options: unknown }>(
          'SELECT id,status,options FROM managed_decision_request WHERE managed_ticket_task_id=$1',
          [taskId],
        ),
      )
    ).rows[0]
    expect(request?.status).toBe('RESOLVED')
    expect(request?.options).toMatchObject([
      { id: 'option-1', text: '使用中文' },
      { id: 'option-2', text: '使用英文' },
      { id: 'option-3', text: '停止并等待人工处理' },
    ])
    const resolution = (
      await asRole('keel_control', (c) =>
        c.query<{ disposition: string; answer: string }>(
          `SELECT disposition,answer FROM managed_decision_resolution
           WHERE request_id=$1`,
          [request?.id],
        ),
      )
    ).rows[0]
    expect(resolution?.disposition).toBe('delegated')
    expect(resolution?.answer).toBe('使用中文')
    expect(observedMemory).toMatchObject({
      referenced_decision_ids: [decisionId],
      entries: [{ decision_id: decisionId }],
    })
    const stages = await listManagedTicketStages(taskId)
    expect(stages[0]?.status).toBe('MUST_STOP')
    expect(stages[0]?.result).toMatchObject({ decision: { decision_key: 'ticket.e2e.style' } })
  })

  it('按固定包执行 execute→verify→review→land，并持久化证据链', async () => {
    const { root, taskId } = await seed()
    const worker = happyWorker(root)
    for (let index = 0; index < 4; index++) {
      const tick = await tickManagedTicket(worker, taskId)
      expect(tick.ok).toBe(true)
      if (!tick.ok) throw new Error(tick.error.detail)
      expect(tick.value?.status).toBe(index === 3 ? 'WAITING_GATEWAY' : 'READY')
    }
    const task = await getManagedTicket(taskId)
    expect(task.ok).toBe(true)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('WAITING_GATEWAY')
    expect(task.value.handoff).toMatchObject({ head_branch: 'ai/ticket-test' })
    const stages = await listManagedTicketStages(taskId)
    expect(stages.map((stage) => stage.stage)).toEqual(['execute', 'verify', 'review', 'land'])
    expect(stages.every((stage) => stage.status === 'SUCCEEDED')).toBe(true)
    expect(stages.every((stage) => stage.output_digest !== null)).toBe(true)
    expect(stages.every((stage) => stage.evidence_digest !== null)).toBe(true)
    const review = stages.find((stage) => stage.stage === 'review')
    expect(review?.evidence).toMatchObject({
      review: { reviewed_commit: review?.output_commit },
    })
  })

  it('verify 没有真实命令证据时暂停，不把模型自报当完成', async () => {
    const { root, taskId } = await seed()
    const execute = happyWorker(root)
    await tickManagedTicket(execute, taskId)
    const verify = workerWith(async () => success('verify'))
    const tick = await tickManagedTicket(verify, taskId)
    expect(tick.ok).toBe(true)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('PAUSED')
    const stages = await listManagedTicketStages(taskId)
    const failed = stages.find((stage) => stage.stage === 'verify' && stage.status === 'FAILED')
    expect(failed?.error).toBe('VERIFICATION_EVIDENCE_MISSING')
    expect(failed?.result).toMatchObject({ stage: 'verify', status: 'completed' })
  })

  it('验证失败保留命令与输出，失败证据不成为成功证明', async () => {
    const { root, taskId } = await seed()
    await tickManagedTicket(happyWorker(root), taskId)
    const verify = workerWith(async () =>
      success('verify', {
        worktree_head: await head(root),
        checks: [
          {
            command: 'node --test',
            exit_code: 1,
            passed: false,
            output_digest: '0'.repeat(64),
            output_excerpt: 'listen EPERM',
          },
        ],
      }),
    )
    const tick = await tickManagedTicket(verify, taskId)
    expect(tick.ok && tick.value?.status).toBe('PAUSED')
    const stages = await listManagedTicketStages(taskId)
    const failed = stages.find((stage) => stage.stage === 'verify' && stage.status === 'FAILED')
    expect(failed?.error).toBe('VERIFICATION_FAILED')
    expect(failed?.result).toMatchObject({
      checks: [
        {
          command: 'node --test',
          passed: false,
          exit_code: 1,
          output_digest: sha256Text('listen EPERM'),
        },
      ],
    })
    expect(failed?.evidence).toMatchObject({
      checks: [{ output_excerpt: 'listen EPERM' }],
    })
    expect(failed?.output_digest).toBeNull()
    expect(failed?.evidence_digest).toBeNull()
  })

  it('review 复用旧 diff 摘要时拒绝', async () => {
    const { root, taskId } = await seed()
    const happy = happyWorker(root)
    await tickManagedTicket(happy, taskId)
    await tickManagedTicket(happy, taskId)
    const stale = workerWith(async (_input) =>
      success('review', {
        review: {
          reviewed_commit: await head(root),
          diff_digest: sha256Text('old evidence'),
          findings: [],
        },
      }),
    )
    const tick = await tickManagedTicket(stale, taskId)
    expect(tick.ok).toBe(true)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('PAUSED')
    const stages = await listManagedTicketStages(taskId)
    expect(stages.find((stage) => stage.stage === 'review')?.error).toBe('STALE_EVIDENCE')
  })

  it('must-stop 暂停并生成统一 DecisionRequest，人工选择后才可继续', async () => {
    const { root, taskId } = await seed()
    const mustStop = workerWith(async () =>
      success('execute', {
        status: 'must_stop',
        requested_action: { action: 'sudo apt-get update', reason: 'fixture' },
        decision: {
          decision_key: 'ticket.sudo',
          kind: 'approval',
          question: '允许 sudo 吗？',
          options: ['停止并等待人工处理（推荐）', '批准本次继续（仅一次）'],
          action_category: 'sudo',
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: ['fixture'],
          },
        },
      }),
    )
    const paused = await tickManagedTicket(mustStop, taskId)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.ok).toBe(true)
    expect(paused.value?.status).toBe('WAITING_HUMAN')
    const request = (
      await asRole('keel_control', (c) =>
        c.query<{ id: string; revision: number; status: string; managed_ticket_task_id: string }>(
          'SELECT id,revision,status,managed_ticket_task_id FROM managed_decision_request WHERE managed_ticket_task_id=$1',
          [taskId],
        ),
      )
    ).rows[0]
    expect(request?.status).toBe('WAITING_HUMAN')
    if (request === undefined) throw new Error('missing request')
    expect(request.managed_ticket_task_id).toBe(taskId)
    const answer = await answerManagedTicketDecision(
      request.id,
      request.revision,
      'option-2',
      new Date().toISOString(),
    )
    expect(answer.ok).toBe(true)
    if (!answer.ok) throw new Error(answer.error.detail)
    expect(answer.value.taskStatus).toBe('READY')
    const resumed = await tickManagedTicket(happyWorker(root), taskId)
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) throw new Error(resumed.error.detail)
    expect(resumed.value?.status).toBe('READY')
  })

  it('must-stop 先经过天问；没有匹配授权时升级人工', async () => {
    const { taskId } = await seed()
    let called = 0
    const worker: ManagedTicketWorker = {
      ...workerWith(async () =>
        success('execute', {
          status: 'must_stop',
          requested_action: { action: 'sudo apt-get update', reason: 'fixture' },
        }),
      ),
      decide: async () => {
        called++
        return { ok: false, error: makeError('RUN_TIMEOUT', 'must not run'), usage: ZERO_USAGE }
      },
    }
    const paused = await tickManagedTicket(worker, taskId)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.value?.status).toBe('WAITING_HUMAN')
    expect(called).toBe(1)
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.last_error).toBe('MUST_STOP')
  })

  it('must-stop 在精确委托默认范围内由天问代批并恢复 READY', async () => {
    const { repoId, root, taskId } = await seed()
    const policyId = randomUUID()
    const now = new Date().toISOString()
    const recorded = await recordDelegationPolicy({
      schema_version: '1.0',
      id: policyId,
      policy_id: 'ticket-must-stop',
      version: 1,
      project_id: repoId,
      approved_by_owner: 'owner',
      approved_at: now,
      valid_from: now,
      rules: [
        {
          id: 'allow-sudo-once',
          decision_kinds: ['approval'],
          actions: ['sudo'],
          resource_selectors: ['fixture'],
          environments: ['local'],
          reversibility: 'reversible',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['reversible'],
            max_affected_resources: 1,
          },
          budget_limits: {},
          required_evidence: [],
          required_checks: [],
          mode: 'delegated',
          default_option_id: 'option-2',
        },
      ],
      created_at: now,
    })
    if (!recorded.ok) throw new Error(recorded.error.detail)
    const worker: ManagedTicketWorker = {
      ...workerWith(async () => ({
        schema_version: '1.0',
        stage: 'execute',
        status: 'must_stop',
        summary: '需要 sudo',
        decision: {
          decision_key: 'ticket.sudo.delegated',
          kind: 'approval',
          question: '允许 sudo 吗？',
          options: ['停止并等待人工处理（推荐）', '批准本次继续（仅一次）'],
          action_category: 'sudo',
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: ['fixture'],
          },
        },
        requested_action: { action: 'sudo apt-get update', reason: 'fixture' },
      })),
      decide: async () => ({
        ok: true,
        value: {
          output: {
            recommendation: 'answer',
            answer_option_id: 'option-2',
            rationale: `命中 ${policyId}`,
            basis_refs: [{ kind: 'delegation_policy', id: policyId, version: 1 }],
            assumptions: [],
            alternatives: [],
            unresolved_conflicts: [],
            missing_authority: [],
          },
          usage: ZERO_USAGE,
        },
      }),
    }
    const tick = await tickManagedTicket(worker, taskId)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('READY')
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('READY')
    const request = (
      await asRole('keel_control', (c) =>
        c.query<{ id: string; status: string }>(
          'SELECT id,status FROM managed_decision_request WHERE managed_ticket_task_id=$1',
          [taskId],
        ),
      )
    ).rows[0]
    expect(request?.status).toBe('RESOLVED')
    const resolution = (
      await asRole('keel_control', (c) =>
        c.query<{ disposition: string; delegation_policy_id: string }>(
          'SELECT disposition,delegation_policy_id FROM managed_decision_resolution WHERE request_id=$1',
          [request?.id],
        ),
      )
    ).rows[0]
    expect(resolution).toMatchObject({ disposition: 'delegated', delegation_policy_id: policyId })
    const resumed = await tickManagedTicket(happyWorker(root), taskId)
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.value?.status).toBe('READY')
  })

  it('must-stop 天问委派到停止选项时任务转为 CANCELLED，不能恢复执行', async () => {
    const { repoId, taskId } = await seed()
    const policyId = randomUUID()
    const now = new Date().toISOString()
    const recorded = await recordDelegationPolicy({
      schema_version: '1.0',
      id: policyId,
      policy_id: 'ticket-must-stop-stop',
      version: 1,
      project_id: repoId,
      approved_by_owner: 'owner',
      approved_at: now,
      valid_from: now,
      rules: [
        {
          id: 'stop-sudo',
          decision_kinds: ['approval'],
          actions: ['sudo'],
          resource_selectors: ['fixture'],
          environments: ['local'],
          reversibility: 'reversible',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['reversible'],
            max_affected_resources: 1,
          },
          budget_limits: {},
          required_evidence: [],
          required_checks: [],
          mode: 'delegated',
          default_option_id: 'option-1',
        },
      ],
      created_at: now,
    })
    if (!recorded.ok) throw new Error(recorded.error.detail)
    const worker: ManagedTicketWorker = {
      ...workerWith(async () => ({
        schema_version: '1.0',
        stage: 'execute',
        status: 'must_stop',
        summary: '需要 sudo',
        decision: {
          decision_key: 'ticket.sudo.stop',
          kind: 'approval',
          question: '允许 sudo 吗？',
          options: ['停止并等待人工处理（推荐）', '批准本次继续（仅一次）'],
          action_category: 'sudo',
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: ['fixture'],
          },
        },
        requested_action: { action: 'sudo apt-get update', reason: 'fixture' },
      })),
      decide: async () => ({
        ok: true,
        value: {
          output: {
            recommendation: 'answer',
            answer_option_id: 'option-1',
            rationale: `命中 ${policyId}`,
            basis_refs: [{ kind: 'delegation_policy', id: policyId, version: 1 }],
            assumptions: [],
            alternatives: [],
            unresolved_conflicts: [],
            missing_authority: [],
          },
          usage: ZERO_USAGE,
        },
      }),
    }
    const tick = await tickManagedTicket(worker, taskId)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('CANCELLED')
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('CANCELLED')
    expect(task.value.last_error).toBe('STOPPED_BY_DECISION')
  })

  it('天问不可用时升级人工并保留 owner_required 决议', async () => {
    const { taskId } = await seed()
    const worker: ManagedTicketWorker = {
      ...workerWith(async () => ({
        schema_version: '1.0',
        stage: 'execute',
        status: 'blocked',
        summary: '需要偏好决定',
        decision: {
          decision_key: 'ticket.e2e.unavailable',
          kind: 'preference',
          question: '选哪个？',
          options: ['A', 'B'],
          action_category: 'ticket_stage',
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: ['fixture'],
          },
        },
      })),
      decide: async () => ({
        ok: false,
        error: makeError('RUN_TIMEOUT', 'fixture timeout'),
        usage: ZERO_USAGE,
      }),
    }
    const paused = await tickManagedTicket(worker, taskId)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.value?.status).toBe('WAITING_HUMAN')
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    expect(task.value.status).toBe('WAITING_HUMAN')
    const request = (
      await asRole('keel_control', (c) =>
        c.query<{ id: string; revision: number; status: string }>(
          'SELECT id,revision,status FROM managed_decision_request WHERE managed_ticket_task_id=$1',
          [taskId],
        ),
      )
    ).rows[0]
    expect(request?.status).toBe('WAITING_HUMAN')
    const resolution = (
      await asRole('keel_control', (c) =>
        c.query<{ disposition: string }>(
          'SELECT disposition FROM managed_decision_resolution WHERE request_id=$1',
          [request?.id],
        ),
      )
    ).rows[0]
    expect(resolution?.disposition).toBe('owner_required')
    if (request === undefined) throw new Error('missing request')
    const answered = await answerManagedTicketDecision(
      request.id,
      request.revision,
      'option-2',
      new Date().toISOString(),
    )
    if (!answered.ok) throw new Error(answered.error.detail)
    expect(answered.value.taskStatus).toBe('READY')
    expect(answered.value.resolution.request_revision).toBe(2)
    const after = await getManagedTicket(taskId)
    if (!after.ok) throw new Error(after.error.detail)
    expect(after.value.status).toBe('READY')
  })

  it('工作流升级不影响已绑定任务，任务仍使用固定包摘要', async () => {
    const { root, taskId } = await seed()
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    const upgraded = fixtureTicketPackage({ execute: 'upgraded execute instructions\n' })
    await asOwner((c) =>
      c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [
        upgraded.content_digest,
        JSON.stringify(upgraded),
      ]),
    )
    let observed = ''
    const worker = workerWith(async (input) => {
      observed = input.package.stages[0]?.instructions ?? ''
      const commit = await commitFile(root, 'upgrade.txt', 'bound package\n')
      return success('execute', { commit })
    })
    await tickManagedTicket(worker, taskId)
    expect(observed).toBe('execute instructions\n')
    const after = await getManagedTicket(taskId)
    if (!after.ok) throw new Error(after.error.detail)
    expect(after.value.package_digest).toBe(task.value.package_digest)
  })

  it('包内容不兼容时明确暂停', async () => {
    const { taskId } = await seed()
    const task = await getManagedTicket(taskId)
    if (!task.ok) throw new Error(task.error.detail)
    await asOwner((c) =>
      c.query('UPDATE managed_package SET body=$2::jsonb WHERE digest=$1', [
        task.value.package_digest,
        JSON.stringify({ mode: 'investigation', protocol_version: '1.0' }),
      ]),
    )
    const tick = await tickManagedTicket(happyWorker('/tmp'), taskId)
    expect(tick.ok).toBe(true)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('PAUSED')
    const after = await getManagedTicket(taskId)
    if (!after.ok) throw new Error(after.error.detail)
    expect(after.value.last_error).toContain('PROTOCOL_ERROR')
  })

  it('tool profile 在 harness inventory 中缺失时暂停而不是降级', async () => {
    const { taskId } = await seed()
    const worker: ManagedTicketWorker = {
      harness: 'pi',
      toolInventory: ['read'],
      run: async () => {
        throw new Error('runner must not be called')
      },
    }
    const tick = await tickManagedTicket(worker, taskId)
    expect(tick.ok).toBe(true)
    if (!tick.ok) throw new Error(tick.error.detail)
    expect(tick.value?.status).toBe('PAUSED')
    const after = await getManagedTicket(taskId)
    if (!after.ok) throw new Error(after.error.detail)
    expect(after.value.last_error).toContain('TOOL_PROFILE_MISSING')
  })

  it('基线 commit 必须等于绑定工作树 HEAD，脏工作树拒绝绑定', async () => {
    const { repoId, root, base } = await seed()
    const packagePath = join(base, 'second.json')
    await writeFile(packagePath, JSON.stringify(fixtureTicketPackage({ ticketId: 'JT-2' })))
    const wrong = await createManagedTicketTask(repoId, packagePath, root, {
      baselineCommit: '0'.repeat(40),
    })
    expect(wrong.ok).toBe(false)
    await writeFile(join(root, 'dirty.txt'), 'dirty\n')
    const dirty = await createManagedTicketTask(repoId, packagePath, root)
    expect(dirty.ok).toBe(false)
  })
})
