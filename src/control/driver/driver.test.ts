/**
 * Workflow driver 的端到端测试。
 *
 * **本文件是本子任务的里程碑**：一条 Task 在真实 Postgres 上
 * 从 S-NEW 走到 S-DONE，且事件流能完整重建这条路径。
 *
 * 这覆盖 v0.1 完成判据的前两个部分；第三部分「无人干预」
 * 需要 Harness 接入后才完整（子任务 4/5）。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Proposal } from '../../contracts/types.js'
import { PgArtifactStore } from '../../fact/artifact-store.js'
import { asOwner, closePool } from '../../fact/db.js'
import { branchFor } from '../../fact/git-workspace.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { WorkflowDriver } from './driver.js'

const NOW = '2026-08-23T12:00:00Z'
const store = new PgArtifactStore()
const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))

const verdict = { accepted: true, artifact_ref: null, violations: [] } as const
const ctx = { run_id: null, verdict, emit_event: true } as const

async function seedTask(): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','Excel 日期筛选',$2,'main',$3)`,
      [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
    )
  })
  return taskId
}

/** 提交一条 A-StageOutcome —— 守卫读的 verdict 来自这里 */
async function stageOutcome(
  taskId: string,
  stage: string,
  v: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const p: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'stage_outcome',
    key: stage,
    body: {
      schema_version: '1.0',
      run_id: `run-${stage}`,
      stage,
      verdict: v,
      reason: '测试',
      ...(details === undefined ? {} : { details }),
    },
    supersedes: null,
    produced_by_run: `run-${stage}`,
  }
  const r = await store.commit(p, ctx)
  expect(r.ok, `提交 ${stage} 的 StageOutcome 应成功`).toBe(true)
}

/** 提交一条 A-RFC —— rfc_ready 的 Policy 求值需要它的 policy_facts */
async function commitRfc(taskId: string, policyFacts: Record<string, unknown>): Promise<void> {
  const p: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'rfc',
    key: '',
    body: {
      schema_version: '1.0',
      title: 'Excel 导出支持日期区间筛选',
      problem: '企业用户导出全量数据后需自行筛选',
      goals: ['导出接口支持 date_from / date_to'],
      non_goals: ['不改动导出文件格式'],
      proposed_change: {
        summary: '增加可选日期区间参数',
        affected_areas: ['ExportService'],
        approach: '新增可选参数，缺省行为不变',
      },
      acceptance_criteria: [{ id: 'AC1', text: '按区间导出', verifiable_by: '集成测试' }],
      policy_facts: policyFacts,
    },
    supersedes: null,
    produced_by_run: 'run-rfc',
  }
  const r = await store.commit(p, ctx)
  expect(r.ok, '提交 RFC 应成功').toBe(true)
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

// ────────────────────────── T-001 intake ──────────────────────────

describe('intake · T-001 真实化', () => {
  async function seedRepoAndFeedback(): Promise<{ repoId: string; feedbackId: string }> {
    const repoId = randomUUID()
    const feedbackId = randomUUID()
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
         VALUES ($1, 'github', 'https://github.com/acme/widget.git', 'main')`,
        [repoId],
      )
      await c.query(
        `INSERT INTO feedback (id, source, external_ref, body)
         VALUES ($1, 'github', 'acme/widget#42', 'Fix the bug')`,
        [feedbackId],
      )
    })
    return { repoId, feedbackId }
  }

  it('首次 intake 建 S-NEW task + T-001 事件 + SideEffectApplied', async () => {
    const { repoId, feedbackId } = await seedRepoAndFeedback()
    const r = await driver.intake(
      { feedbackId, title: 'Fix the bug', repoId, baseBranch: 'main' },
      NOW,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.created).toBe(true)

    const task = await asOwner((c) =>
      c.query<{ status: string; work_branch: string; title: string }>(
        'SELECT status, work_branch, title FROM task WHERE id = $1',
        [r.value.taskId],
      ),
    )
    expect(task.rows[0]?.status).toBe('S-NEW')
    expect(task.rows[0]?.work_branch).toBe(branchFor(r.value.taskId))
    expect(task.rows[0]?.title).toBe('Fix the bug')

    const link = await asOwner((c) =>
      c.query('SELECT 1 FROM task_feedback WHERE task_id = $1 AND feedback_id = $2', [
        r.value.taskId,
        feedbackId,
      ]),
    )
    expect(link.rowCount).toBe(1)

    const evs = await store.readEvents(r.value.taskId, 0, 50)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const types = evs.value.map((e) => e.type)
    expect(types).toContain('TaskStatusChanged')
    expect(types.filter((t) => t === 'SideEffectApplied').length).toBe(2)
    expect(types).not.toContain('SideEffectIntent')

    const statusChange = evs.value.find((e) => e.type === 'TaskStatusChanged')
    expect(statusChange).toBeDefined()
    if (statusChange === undefined) return
    expect((statusChange.payload as { transition: string }).transition).toBe('T-001')

    // O2：intake 段所有事件共享非 null trace_id（含 ensureTraceId 宿主 TaskCreated）
    const traces = [...new Set(evs.value.map((e) => e.trace_id))]
    expect(traces.length, '全部事件应共享同一个 trace_id').toBe(1)
    expect(traces[0]).toBeTruthy()
    // pg timestamptz → toISOString 会补毫秒；与注入 now 语义相等即可
    const norm = (s: string) => new Date(s).toISOString()
    expect(evs.value.every((e) => norm(e.occurred_at) === norm(NOW))).toBe(true)
  })

  it('重复 intake 同一 feedback 返回既有 taskId', async () => {
    const { repoId, feedbackId } = await seedRepoAndFeedback()
    const first = await driver.intake(
      { feedbackId, title: 'Fix the bug', repoId, baseBranch: 'main' },
      NOW,
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await driver.intake(
      { feedbackId, title: 'Fix the bug', repoId, baseBranch: 'main' },
      NOW,
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.created).toBe(false)
    expect(second.value.taskId).toBe(first.value.taskId)

    const tasks = await asOwner((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM task'))
    expect(Number(tasks.rows[0]?.n)).toBe(1)
  })
})

// ────────────────────────── 里程碑：走通闭环 ──────────────────────────

describe('里程碑：S-NEW → S-DONE', () => {
  it('一条 Task 在真实数据库上走完全程，事件流可完整重建', async () => {
    const taskId = await seedTask()
    const path: string[] = []

    const step = async (event: Parameters<typeof driver.advance>[1], expected: string) => {
      const r = await driver.advance(taskId, event, NOW)
      expect(r.ok, `${event.type} 应成功`).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.value.advanced, `${event.type} 应推进（当前 ${await statusOf(taskId)}）`).toBe(true)
      expect(r.value.to).toBe(expected)
      if (r.value.transition_id !== null) path.push(r.value.transition_id)
    }

    await step({ type: 'Dispatch' }, 'S-PM_ANALYZING')

    await stageOutcome(taskId, 'pm', 'actionable', { needs_design: true })
    await step({ type: 'RunSucceeded', stage: 'pm' }, 'S-BRAINSTORM')

    await stageOutcome(taskId, 'brainstorm', 'converged')
    await step({ type: 'RunSucceeded', stage: 'brainstorm' }, 'S-RFC_DRAFT')

    await commitRfc(taskId, {
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 4,
      security_related: false,
    })
    await step({ type: 'ArtifactCommitted', kind: 'rfc' }, 'S-RFC_READY')

    await step({ type: 'PolicyEvaluated', decision: 'auto_develop' }, 'S-DEVELOPING')

    await stageOutcome(taskId, 'develop', 'implemented', { files_changed: 4 })
    await step({ type: 'RunSucceeded', stage: 'develop' }, 'S-QA')

    await stageOutcome(taskId, 'qa', 'pass')
    await step({ type: 'RunSucceeded', stage: 'qa' }, 'S-REVIEW')

    await stageOutcome(taskId, 'review', 'pass')
    await step({ type: 'RunSucceeded', stage: 'review' }, 'S-PR_OPEN')

    await step({ type: 'CIPassed' }, 'S-DONE')

    // 1. 终态与 terminal_at
    expect(await statusOf(taskId)).toBe('S-DONE')
    const t = await asOwner((c) =>
      c.query<{ terminal_at: Date | null }>('SELECT terminal_at FROM task WHERE id = $1', [taskId]),
    )
    expect(t.rows[0]?.terminal_at).not.toBeNull()

    // 2. 走过的转移与文档一致
    expect(path).toEqual([
      'T-002',
      'T-003',
      'T-010',
      'T-011',
      'T-012',
      'T-017',
      'T-018',
      'T-021',
      'T-024',
    ])

    // 3. 事件流能完整重建这条路径 —— 这是 v0.1 判据的第三部分
    const evs = await store.readEvents(taskId, 0, 500)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const statusChanges = evs.value
      .filter((e) => e.type === 'TaskStatusChanged')
      .map((e) => (e.payload as { transition: string }).transition)
    expect(statusChanges).toEqual(path)

    // 每条状态变更都带 transition ID，可直接对照转移表核验
    for (const e of evs.value.filter((x) => x.type === 'TaskStatusChanged')) {
      const p = e.payload as { from: string; to: string; transition: string }
      expect(p.transition).toMatch(/^T-\d{3}$/)
      expect(p.from).toMatch(/^S-/)
      expect(p.to).toMatch(/^S-/)
    }

    // 4. Policy 裁决被落成产物
    const decision = await store.latest(taskId, 'policy_decision', 'rfc_ready')
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect((decision.value.body as { decision: string }).decision).toBe('auto_develop')
  })
})

// ────────────────────────── 失败路径 ──────────────────────────

describe('失败路径：QA 失败 → 返工 → 重试耗尽 → 人工', () => {
  async function toDeveloping(taskId: string): Promise<void> {
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    await stageOutcome(taskId, 'pm', 'actionable', { needs_design: false })
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, NOW)
    await commitRfc(taskId, {
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 2,
      security_related: false,
    })
    await driver.advance(taskId, { type: 'ArtifactCommitted', kind: 'rfc' }, NOW)
    await driver.advance(taskId, { type: 'PolicyEvaluated', decision: 'auto_develop' }, NOW)
  }

  it('QA 失败且未达上限 → 走 T-019 回到 S-DEVELOPING', async () => {
    const taskId = await seedTask()
    await toDeveloping(taskId)
    await stageOutcome(taskId, 'develop', 'implemented')
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'develop' }, NOW)
    expect(await statusOf(taskId)).toBe('S-QA')

    await stageOutcome(taskId, 'qa', 'fail')
    const r = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'qa' }, NOW)
    expect(r.ok && r.value.transition_id).toBe('T-019')
    expect(await statusOf(taskId)).toBe('S-DEVELOPING')
  })

  it('Run 失败反复直到上限 → 走 T-031 升人工', async () => {
    const taskId = await seedTask()
    await toDeveloping(taskId)

    // develop 已有 1 次 run（T-012 建的）。再失败到达上限
    for (let i = 0; i < 3; i++) {
      await driver.advance(taskId, { type: 'RunFailed', stage: 'develop' }, NOW)
    }
    expect(await statusOf(taskId)).toBe('S-HUMAN_REVIEW')
  })
})

// ────────────────────────── control_mode ──────────────────────────

describe('control_mode 与状态正交', () => {
  it('paused 时不推进，但如实记 NoTransition 事件', async () => {
    const taskId = await seedTask()
    await asOwner((c) => c.query("UPDATE task SET control_mode = 'paused' WHERE id = $1", [taskId]))

    const r = await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 不推进不是错误，是暂停该有的行为
    expect(r.value.advanced).toBe(false)
    expect(await statusOf(taskId)).toBe('S-NEW')

    const evs = await store.readEvents(taskId, 0, 100)
    expect(evs.ok && evs.value.some((e) => e.type === 'NoTransition')).toBe(true)
  })

  it('paused 时 Cancelled 仍然生效（T-040 无视 control_mode）', async () => {
    const taskId = await seedTask()
    await asOwner((c) => c.query("UPDATE task SET control_mode = 'paused' WHERE id = $1", [taskId]))
    const r = await driver.advance(taskId, { type: 'Cancelled' }, NOW)
    expect(r.ok && r.value.transition_id).toBe('T-040')
    expect(await statusOf(taskId)).toBe('S-ABANDONED')
  })
})

// ────────────────────────── 重放安全 ──────────────────────────

describe('幂等：同一事件投递两次，副作用只发生一次', () => {
  it('重复 Dispatch 不会创建第二个 run', async () => {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)

    const before = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM run WHERE task_id = $1', [taskId]),
    )
    expect(Number(before.rows[0]?.n)).toBe(1)

    // 再投一次同样的事件。此时 status 已是 S-PM_ANALYZING，
    // Dispatch 在该状态下无转移 —— 但即便有，CreateRun 也会被幂等键挡住
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)

    const after = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM run WHERE task_id = $1', [taskId]),
    )
    expect(Number(after.rows[0]?.n)).toBe(1)
  })

  it('幂等键命中时记 SideEffectSkipped', async () => {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    // 回到 S-NEW 再投一次，强制重跑 T-002 的 CreateRun
    await asOwner((c) => c.query("UPDATE task SET status = 'S-NEW' WHERE id = $1", [taskId]))
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)

    const evs = await store.readEvents(taskId, 0, 200)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const skipped = evs.value.filter((e) => e.type === 'SideEffectSkipped')
    expect(skipped.length).toBeGreaterThan(0)
    expect((skipped[0]?.payload as { kind?: string } | undefined)?.kind).toBe('CreateRun')

    const runs = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM run WHERE task_id = $1', [taskId]),
    )
    expect(Number(runs.rows[0]?.n)).toBe(1)
  })

  it('终态 Task 再收事件 → 无转移，状态不变', async () => {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Cancelled' }, NOW)
    expect(await statusOf(taskId)).toBe('S-ABANDONED')

    const r = await driver.advance(taskId, { type: 'CIPassed' }, NOW)
    expect(r.ok && r.value.advanced).toBe(false)
    expect(await statusOf(taskId)).toBe('S-ABANDONED')
  })
})

// ────────────────────────── 未落地副作用 ──────────────────────────

describe('未落地的副作用记录为意图，不静默跳过', () => {
  it('CreateBranch 在 v0.1 记 SideEffectIntent', async () => {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    await stageOutcome(taskId, 'pm', 'actionable', { needs_design: false })
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, NOW)
    await commitRfc(taskId, {
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 2,
      security_related: false,
    })
    await driver.advance(taskId, { type: 'ArtifactCommitted', kind: 'rfc' }, NOW)
    await driver.advance(taskId, { type: 'PolicyEvaluated', decision: 'auto_develop' }, NOW)

    const evs = await store.readEvents(taskId, 0, 200)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const intents = evs.value
      .filter((e) => e.type === 'SideEffectIntent')
      .map((e) => (e.payload as { kind: string }).kind)
    // 事件流如实说明「建分支这件事还没真的做」，而不是假装做过了
    expect(intents).toContain('CreateBranch')
  })
})

// ────────────────────────── Policy 与安全 ──────────────────────────

describe('安全相关的 RFC 不会被自动放行', () => {
  it('低复杂度的安全修复在 rfc_ready 被裁为 security_review', async () => {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    await stageOutcome(taskId, 'pm', 'actionable', { needs_design: false })
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, NOW)
    await commitRfc(taskId, {
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 2,
      security_related: true,
    })
    await driver.advance(taskId, { type: 'ArtifactCommitted', kind: 'rfc' }, NOW)

    const d = await store.latest(taskId, 'policy_decision', 'rfc_ready')
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect((d.value.body as { decision: string }).decision).toBe('security_review')

    // 于是 T-013 走人工，而不是 T-012 自动开发
    const r = await driver.advance(
      taskId,
      { type: 'PolicyEvaluated', decision: 'security_review' },
      NOW,
    )
    expect(r.ok && r.value.transition_id).toBe('T-013')
    expect(await statusOf(taskId)).toBe('S-HUMAN_REVIEW')
  })
})

// ────────────────────────── #1-02 · capability 授权 ──────────────────────────

describe('CapabilityRequested · 缺裁决不放行(#1-02)', () => {
  /** 铺到 S-BRAINSTORM：T-009 的前置状态 */
  async function seedToBrainstorm(): Promise<string> {
    const taskId = await seedTask()
    await driver.advance(taskId, { type: 'Dispatch' }, NOW)
    await stageOutcome(taskId, 'pm', 'actionable', { needs_design: true })
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, NOW)
    expect(await statusOf(taskId)).toBe('S-BRAINSTORM')
    return taskId
  }

  it('未接线的 capability(human_input)→ 默认 deny → T-009 不推进', async () => {
    const taskId = await seedToBrainstorm()
    const r = await driver.advance(
      taskId,
      { type: 'CapabilityRequested', capability: 'human_input' },
      NOW,
    )
    // 缺规则 = 缺裁决 = 不放行:NoTransition,状态不动
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.advanced).toBe(false)
    expect(await statusOf(taskId)).toBe('S-BRAINSTORM')
  })

  it('critic_review 经 DEFAULT_RULES 的 P-ALLOW-CRITIC 放行 → T-009(#1-15)', async () => {
    const taskId = await seedToBrainstorm()
    const r = await driver.advance(
      taskId,
      { type: 'CapabilityRequested', capability: 'critic_review' },
      NOW,
    )
    expect(r.ok && r.value.advanced).toBe(true)
    if (!r.ok || !r.value.advanced) return
    expect(r.value.transition_id).toBe('T-009')
    // 自环:S-BRAINSTORM 仍在
    expect(r.value.to).toBe('S-BRAINSTORM')

    // T-009 effects 落了可重放的裁决记录(EvaluatePolicy)
    const d = await store.latest(taskId, 'policy_decision', 'capability_request')
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect((d.value.body as { decision: string }).decision).toBe('auto_develop')
  })

  it('capability 值不匹配规则 → 裁决仍为默认 deny → 不推进', async () => {
    const taskId = await seedToBrainstorm()
    const r = await driver.advance(
      taskId,
      { type: 'CapabilityRequested', capability: 'additional_context' },
      NOW,
    )
    expect(r.ok && r.value.advanced).toBe(false)
  })
})
