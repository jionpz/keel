/**
 * 人工裁决 TTL —— S-HUMAN_REVIEW 超时自动收尾(11-05-human-review-ttl)。
 *
 * 覆盖 PRD 的 AC：
 *   - 5 条进入 S-HUMAN_REVIEW 的转移都武装 `human_review_ttl`（due = now + 24h）
 *   - 到期后 advance(TimerFired) → T-028 → S-ABANDONED，timer 置 fired
 *   - T-014 / T-015 / T-016 离开时取消 pending timer
 *   - T-040 / T-041 清掉两类 Task 级 timer（终态不留 pending 行）
 *   - `humanReviewTtlMs = null`（KEEL_HUMAN_REVIEW_TTL_H=0）时 StartTimer skipped、不插行
 *   - 回炉后重进 S-HUMAN_REVIEW 能重新武装 —— 防「旧 pending 行挡住新 StartTimer」
 *
 * 忠实于真实驱动路径：真实 Postgres + 真实 WorkflowDriver，不用 mock。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Proposal } from '../contracts/types.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import type { TransitionEvent } from '../control/transition/types.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor } from '../fact/git-workspace.js'
import type { TaskStatus } from '../shared/ids.js'

const NOW = '2026-11-05T10:00:00Z'
const DAY_MS = 24 * 3600 * 1000

const store = new PgArtifactStore()
const commitCtx = {
  run_id: null,
  verdict: { accepted: true, artifact_ref: null, violations: [] },
  emit_event: true,
} as const

function driver(humanReviewTtlMs?: number | null): WorkflowDriver {
  return new WorkflowDriver(
    new RuleBasedPolicyEngine(DEFAULT_RULESET),
    undefined,
    undefined,
    humanReviewTtlMs,
  )
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo, timer RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  await closePool()
})

async function seedTask(status: TaskStatus): Promise<string> {
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
       VALUES ($1,$2,'人工裁决 TTL',$3,'main',$4)`,
      [taskId, status, repoId, branchFor(taskId)],
    )
  })
  return taskId
}

async function seedRun(taskId: string, stage: string, attempt: number): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,$3,'Developer',$4,'SUCCEEDED',$5)`,
      [randomUUID(), taskId, stage, attempt, `${taskId}/${stage}/${attempt}`],
    ),
  )
}

async function seedStageOutcome(taskId: string, stage: string, verdict: string): Promise<void> {
  const p: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'stage_outcome',
    key: stage,
    body: {
      schema_version: '1.0',
      run_id: `run-${stage}`,
      stage,
      verdict,
      reason: '测试铺垫',
    },
    supersedes: null,
    produced_by_run: `run-${stage}`,
  }
  const r = await store.commit(p, commitCtx)
  expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
}

async function commitRfc(taskId: string): Promise<void> {
  const p: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'rfc',
    key: '',
    body: {
      schema_version: '1.0',
      title: '人工裁决 TTL 回炉回归',
      problem: '回炉后要能重新武装 TTL',
      goals: ['重新武装'],
      non_goals: ['不改动其他行为'],
      proposed_change: {
        summary: '回炉',
        affected_areas: ['timer'],
        approach: '重新进入人工闸门',
      },
      acceptance_criteria: [{ id: 'AC1', text: 'TTL 重新武装', verifiable_by: '测试' }],
      policy_facts: {
        risk: 'medium',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
      },
    },
    supersedes: null,
    produced_by_run: 'run-rfc',
  }
  const r = await store.commit(p, commitCtx)
  expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
}

async function pendingHumanReviewTimer(
  taskId: string,
): Promise<{ state: string; due_at: string; fired_at: string | null } | null> {
  const r = await asOwner((c) =>
    c.query<{ state: string; due_at: string; fired_at: string | null }>(
      `SELECT state, due_at, fired_at FROM timer
       WHERE task_id=$1 AND kind='human_review_ttl'
       ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0] ?? null
}

async function pendingTimerCount(taskId: string): Promise<number> {
  const r = await asOwner((c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM timer WHERE task_id=$1 AND state='pending'`, [
      taskId,
    ]),
  )
  return Number(r.rows[0]?.n ?? 0)
}

async function seedPendingTimer(taskId: string, kind: string): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
       VALUES ($1,$2,NULL,$3,$4,'pending')`,
      [randomUUID(), taskId, kind, NOW],
    ),
  )
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

/** 断言进入人工闸门后 TTL 被武装：pending、due = now + 默认 24h */
async function expectArmed(taskId: string): Promise<void> {
  const t = await pendingHumanReviewTimer(taskId)
  expect(t, '应有 human_review_ttl 行').not.toBeNull()
  expect(t?.state).toBe('pending')
  expect(new Date(t?.due_at ?? '').getTime() - new Date(NOW).getTime()).toBe(DAY_MS)
}

async function advance(
  d: WorkflowDriver,
  taskId: string,
  event: TransitionEvent,
  transitionId: string,
  to: TaskStatus,
): Promise<void> {
  const r = await d.advance(taskId, event, NOW)
  expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
  if (!r.ok) return
  expect(r.value.advanced, `期望命中 ${transitionId}`).toBe(true)
  expect(r.value.transition_id).toBe(transitionId)
  expect(r.value.to).toBe(to)
}

// ─────────────────── 5 条入边都武装 TTL ───────────────────

describe('进入 S-HUMAN_REVIEW 的 5 条转移都武装 human_review_ttl', () => {
  it('T-013：Policy 判非 auto_develop', async () => {
    const taskId = await seedTask('S-RFC_READY')
    await advance(
      driver(),
      taskId,
      { type: 'PolicyEvaluated', decision: 'human_review' },
      'T-013',
      'S-HUMAN_REVIEW',
    )
    await expectArmed(taskId)
  })

  it('T-020：QA 重试耗尽', async () => {
    const taskId = await seedTask('S-QA')
    await seedStageOutcome(taskId, 'qa', 'fail')
    for (let attempt = 1; attempt <= 3; attempt++) await seedRun(taskId, 'develop', attempt)

    await advance(
      driver(),
      taskId,
      { type: 'RunSucceeded', stage: 'qa' },
      'T-020',
      'S-HUMAN_REVIEW',
    )
    await expectArmed(taskId)
  })

  it('T-023：评审判 fail 且开发重试耗尽', async () => {
    const taskId = await seedTask('S-REVIEW')
    await seedStageOutcome(taskId, 'review', 'fail')
    for (let attempt = 1; attempt <= 3; attempt++) await seedRun(taskId, 'develop', attempt)

    await advance(
      driver(),
      taskId,
      { type: 'RunSucceeded', stage: 'review' },
      'T-023',
      'S-HUMAN_REVIEW',
    )
    await expectArmed(taskId)
  })

  it('T-026：CI 失败且开发重试耗尽', async () => {
    const taskId = await seedTask('S-PR_OPEN')
    for (let attempt = 1; attempt <= 3; attempt++) await seedRun(taskId, 'develop', attempt)

    await advance(
      driver(),
      taskId,
      { type: 'CIFailed', source: 'simulated' },
      'T-026',
      'S-HUMAN_REVIEW',
    )
    await expectArmed(taskId)
  })

  it('T-031：阶段重试耗尽', async () => {
    const taskId = await seedTask('S-DEVELOPING')
    for (let attempt = 1; attempt <= 3; attempt++) await seedRun(taskId, 'develop', attempt)

    await advance(
      driver(),
      taskId,
      { type: 'RunFailed', stage: 'develop' },
      'T-031',
      'S-HUMAN_REVIEW',
    )
    await expectArmed(taskId)
  })
})

// ─────────────────── 到期 → T-028 ───────────────────

describe('T-028：到期自动弃单', () => {
  it('TimerFired(human_review_ttl) → S-ABANDONED，timer 置 fired（I9 带 fired_at）', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    await seedPendingTimer(taskId, 'human_review_ttl')

    const r = await driver().advance(taskId, { type: 'TimerFired', timer: 'human_review_ttl' }, NOW)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.transition_id).toBe('T-028')
    expect(r.value.to).toBe('S-ABANDONED')
    // 只收割 timer，不清理工作区：终态证据（事件流、分支、提交历史）完整保留
    expect(r.value.effects.map((e) => `${e.kind}:${e.outcome}`)).toEqual(['ConsumeTimer:applied'])

    expect(await statusOf(taskId)).toBe('S-ABANDONED')
    const t = await pendingHumanReviewTimer(taskId)
    expect(t?.state).toBe('fired')
    expect(t?.fired_at).not.toBeNull()
  })

  it('未到期不会误收割（ConsumeTimer 带 due_at <= now）', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    await seedPendingTimer(taskId, 'human_review_ttl')
    // 把到期时间推到未来
    await asOwner((c) =>
      c.query(`UPDATE timer SET due_at=$2 WHERE task_id=$1 AND kind='human_review_ttl'`, [
        taskId,
        '2026-11-06T10:00:00Z',
      ]),
    )

    const r = await driver().advance(taskId, { type: 'TimerFired', timer: 'human_review_ttl' }, NOW)
    expect(r.ok && r.value.advanced).toBe(true)
    if (!r.ok || !r.value.advanced) return
    expect(r.value.effects.map((e) => `${e.kind}:${e.outcome}`)).toEqual(['ConsumeTimer:skipped'])
    expect((await pendingHumanReviewTimer(taskId))?.state).toBe('pending')
  })
})

// ─────────────────── 正常离开取消 TTL ───────────────────

describe('T-014 / T-015 / T-016 离开时取消 pending timer', () => {
  const cases: readonly { decision: string; event: TransitionEvent; to: TaskStatus }[] = [
    { decision: 'approve', event: { type: 'HumanApproved' }, to: 'S-DEVELOPING' },
    { decision: 'reject', event: { type: 'HumanRejected' }, to: 'S-REJECTED' },
    { decision: 'rework', event: { type: 'HumanRequestedRework' }, to: 'S-BRAINSTORM' },
  ]

  for (const { decision, event, to } of cases) {
    it(`${decision} → timer cancelled`, async () => {
      const taskId = await seedTask('S-HUMAN_REVIEW')
      await seedPendingTimer(taskId, 'human_review_ttl')

      const d = driver()
      const r = await d.advance(taskId, event, NOW)
      expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
      if (!r.ok || !r.value.advanced) return
      expect(r.value.to).toBe(to)
      expect(r.value.effects.map((e) => `${e.kind}:${e.outcome}`)).toContain('CancelTimer:applied')

      expect((await pendingHumanReviewTimer(taskId))?.state).toBe('cancelled')
      expect(await pendingTimerCount(taskId)).toBe(0)
    })
  }
})

// ─────────────────── 终态清理两类 timer ───────────────────

describe('T-040 / T-041 清掉两类 Task 级 timer', () => {
  for (const { id, event, to } of [
    { id: 'T-040', event: { type: 'Cancelled' } as const, to: 'S-ABANDONED' as const },
    {
      id: 'T-041',
      event: { type: 'UnrecoverableError' } as const,
      to: 'S-FAILED' as const,
    },
  ]) {
    it(`${id} → ${to} 后无 pending timer（澄清 + 人工裁决）`, async () => {
      const taskId = await seedTask('S-DEVELOPING')
      await seedPendingTimer(taskId, 'clarification_ttl')
      await seedPendingTimer(taskId, 'human_review_ttl')
      expect(await pendingTimerCount(taskId)).toBe(2)

      const d = driver()
      const r = await d.advance(taskId, event, NOW)
      expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
      if (!r.ok || !r.value.advanced) return
      expect(r.value.transition_id).toBe(id)
      expect(r.value.to).toBe(to)
      expect(await pendingTimerCount(taskId)).toBe(0)
    })
  }
})

// ─────────────────── 关闭开关 ───────────────────

describe('humanReviewTtlMs = null（KEEL_HUMAN_REVIEW_TTL_H=0）', () => {
  it('T-013 仍进 S-HUMAN_REVIEW，但 StartTimer skipped、timer 表无新行', async () => {
    const taskId = await seedTask('S-RFC_READY')
    const d = driver(null)

    const r = await d.advance(taskId, { type: 'PolicyEvaluated', decision: 'human_review' }, NOW)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok || !r.value.advanced) return
    expect(r.value.to).toBe('S-HUMAN_REVIEW')
    expect(r.value.effects.find((e) => e.kind === 'StartTimer')).toMatchObject({
      outcome: 'skipped',
      detail: 'human_review_ttl 已关闭',
    })
    expect(await pendingHumanReviewTimer(taskId)).toBeNull()
    expect(await statusOf(taskId)).toBe('S-HUMAN_REVIEW')
  })

  it('自定义 TTL（2h）落进 due_at —— 测试注入不读全局常量', async () => {
    const taskId = await seedTask('S-RFC_READY')
    const d = driver(2 * 3600 * 1000)

    await advance(
      d,
      taskId,
      { type: 'PolicyEvaluated', decision: 'human_review' },
      'T-013',
      'S-HUMAN_REVIEW',
    )

    const t = await pendingHumanReviewTimer(taskId)
    expect(t?.state).toBe('pending')
    expect(new Date(t?.due_at ?? '').getTime() - new Date(NOW).getTime()).toBe(2 * 3600 * 1000)
  })
})

// ─────────────────── 回炉后重进：重新武装 TTL ───────────────────

describe('回炉后再次进入 S-HUMAN_REVIEW 能重新武装 TTL', () => {
  it('T-016 取消旧 timer 后，S-BRAINSTORM → T-010 → T-011 → T-013 又出现一条 pending', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    await seedPendingTimer(taskId, 'human_review_ttl')
    const d = driver()

    // 1) 回炉：旧 pending 必须被取消；否则下面的新 StartTimer 会被唯一索引挡成 skipped
    await advance(d, taskId, { type: 'HumanRequestedRework' }, 'T-016', 'S-BRAINSTORM')
    expect((await pendingHumanReviewTimer(taskId))?.state).toBe('cancelled')

    // 2) 重新出方案 → 冻结 RFC → 回到人工闸门
    await advance(d, taskId, { type: 'RunSucceeded', stage: 'brainstorm' }, 'T-010', 'S-RFC_DRAFT')
    await commitRfc(taskId)
    await advance(d, taskId, { type: 'ArtifactCommitted', kind: 'rfc' }, 'T-011', 'S-RFC_READY')
    await advance(
      d,
      taskId,
      { type: 'PolicyEvaluated', decision: 'human_review' },
      'T-013',
      'S-HUMAN_REVIEW',
    )

    const t = await pendingHumanReviewTimer(taskId)
    expect(t?.state, '回炉后必须重新武装，而不是静默失去 TTL').toBe('pending')
    expect(new Date(t?.due_at ?? '').getTime() - new Date(NOW).getTime()).toBe(DAY_MS)
  })
})
