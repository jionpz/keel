/**
 * 人工闸门命令的行为测试。
 *
 * 覆盖 PRD 的 AC1-AC5、AC7：
 *   - 预检不满足时**零写入**（事件数、run 数、status 都不动）；
 *   - 四种决定各自发出的 event 与落到的状态；
 *   - `answer` 的 feedback 落库 + 关联 + timer 取消 + 新 run；
 *   - `--note` 透传到 `advance` 的第 4 参。
 *
 * 用真实 Postgres + 真实 driver（与 driver.test.ts 同一套装置），
 * 只有「不需要验证副作用、只想验证事件映射」的用例才注入假 advancer。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type { AdvanceOptions, AdvanceOutcome } from '../control/driver/driver.js'
import type { TransitionEvent } from '../control/transition/types.js'
import { asOwner, closePool } from '../fact/db.js'
import type { TaskStatus } from '../shared/ids.js'
import { type Advancer, answerTask, decideTask } from './decide.js'

const NOW = '2026-11-04T10:00:00Z'

class FakeAdvancer implements Advancer {
  readonly calls: { event: TransitionEvent; opts: AdvanceOptions | undefined }[] = []
  constructor(
    private readonly outcome: Partial<AdvanceOutcome> = {},
    private readonly failure?: Error,
  ) {}

  async advance(
    _taskId: string,
    event: TransitionEvent,
    _now: string,
    opts?: AdvanceOptions,
  ): Promise<Result<AdvanceOutcome>> {
    this.calls.push({ event, opts })
    if (this.failure !== undefined) throw this.failure
    return ok({
      advanced: true,
      from: 'S-HUMAN_REVIEW',
      to: 'S-DEVELOPING',
      transition_id: 'T-014',
      effects: [],
      reason: null,
      ...this.outcome,
    })
  }
}

let repoId: string

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    ),
  )
})

afterAll(closePool)

async function seedTask(status: TaskStatus, controlMode: 'auto' | 'paused' | 'human' = 'auto') {
  const taskId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO task (id, status, control_mode, title, repo_id, base_branch, work_branch)
       VALUES ($1,$2,$3,'人工闸门',$4,'main','ai/t')`,
      [taskId, status, controlMode, repoId],
    ),
  )
  return taskId
}

async function seedClarificationTask(controlMode: 'auto' | 'paused' = 'auto') {
  const taskId = await seedTask('S-NEED_CLARIFICATION', controlMode)
  await asOwner((c) =>
    c.query(
      `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
       VALUES ($1,$2,NULL,'clarification_ttl',$3,'pending')`,
      [randomUUID(), taskId, NOW],
    ),
  )
  return taskId
}

async function counts(taskId: string) {
  const r = await asOwner((c) =>
    c.query<{ events: string; runs: string; status: string; timers: string }>(
      `SELECT (SELECT count(*) FROM event WHERE task_id=$1) AS events,
              (SELECT count(*) FROM run WHERE task_id=$1) AS runs,
              (SELECT status FROM task WHERE id=$1) AS status,
              (SELECT count(*) FROM timer WHERE task_id=$1 AND state='pending') AS timers`,
      [taskId],
    ),
  )
  const row = r.rows[0]
  return {
    events: Number(row?.events ?? 0),
    runs: Number(row?.runs ?? 0),
    status: row?.status ?? '',
    pendingTimers: Number(row?.timers ?? 0),
  }
}

async function feedbackRows(taskId: string) {
  const r = await asOwner((c) =>
    c.query<{ id: string; source: string; body: string }>(
      `SELECT f.id, f.source, f.body
       FROM task_feedback tf JOIN feedback f ON f.id = tf.feedback_id
       WHERE tf.task_id = $1`,
      [taskId],
    ),
  )
  return r.rows
}

// ────────────────────────── decide · 预检 ──────────────────────────

describe('decide · 预检不满足时零写入', () => {
  it('终态任务：拒绝，且不产生任何事件', async () => {
    const taskId = await seedTask('S-DONE')
    const before = await counts(taskId)

    const r = await decideTask(taskId, 'approve', { now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CONFLICT')
    expect(r.error.detail).toContain('S-DONE')
    expect(r.error.detail).toContain('终态')

    expect(await counts(taskId)).toEqual(before)
  })

  it('control_mode=paused：拒绝且根本不调用 driver', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW', 'paused')
    const before = await counts(taskId)
    const fake = new FakeAdvancer()

    const r = await decideTask(taskId, 'approve', { now: NOW, driver: fake })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CONFLICT')
    expect(r.error.detail).toContain('paused')

    expect(fake.calls).toEqual([])
    expect(await counts(taskId)).toEqual(before)
  })

  it('任务不存在：NOT_FOUND', async () => {
    const r = await decideTask(randomUUID(), 'reject', { now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
  })
})

// ────────────────────────── decide · 事件映射 ──────────────────────────

describe('decide · 三种决定发出的 event', () => {
  it('approve → HumanApproved，并透传 --note', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const fake = new FakeAdvancer()

    const r = await decideTask(taskId, 'approve', { now: NOW, note: 'RFC 通过', driver: fake })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.transitionId).toBe('T-014')
    expect(fake.calls).toEqual([{ event: { type: 'HumanApproved' }, opts: { note: 'RFC 通过' } }])
  })

  it('reject → HumanRejected（不带 note 时 advane 第 4 参为空对象）', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const fake = new FakeAdvancer({ to: 'S-REJECTED', transition_id: 'T-015' })

    const r = await decideTask(taskId, 'reject', { now: NOW, driver: fake })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.to).toBe('S-REJECTED')
    expect(fake.calls).toEqual([{ event: { type: 'HumanRejected' }, opts: {} }])
  })

  it('rework → HumanRequestedRework', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const fake = new FakeAdvancer({ to: 'S-BRAINSTORM', transition_id: 'T-016' })

    const r = await decideTask(taskId, 'rework', { now: NOW, driver: fake })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(fake.calls.map((c) => c.event.type)).toEqual(['HumanRequestedRework'])
  })
})

// ────────────────────────── decide · 真实驱动 ──────────────────────────

describe('decide · 真实 driver 落库', () => {
  it('reject → T-015，任务成 S-REJECTED 终态', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')

    const r = await decideTask(taskId, 'reject', { now: NOW, note: '方案方向不对' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.transitionId).toBe('T-015')

    const after = await counts(taskId)
    expect(after.status).toBe('S-REJECTED')
    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: Record<string, unknown> }>(
        'SELECT type, payload FROM event WHERE task_id=$1 ORDER BY seq',
        [taskId],
      ),
    )
    const types = evs.rows.map((e) => e.type)
    expect(types).toContain('TaskStatusChanged')
    expect(types).toContain('HumanDecision')
    expect(evs.rows.find((e) => e.type === 'HumanDecision')?.payload).toEqual({
      decision: 'HumanRejected',
      note: '方案方向不对',
    })
  })

  it('rework → T-016，回 S-BRAINSTORM 并派发新一轮 brainstorm', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')

    const r = await decideTask(taskId, 'rework', { now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.transitionId).toBe('T-016')

    const after = await counts(taskId)
    expect(after.status).toBe('S-BRAINSTORM')
    expect(after.runs).toBe(1)
    const run = await asOwner((c) =>
      c.query<{ stage: string; status: string }>('SELECT stage, status FROM run WHERE task_id=$1', [
        taskId,
      ]),
    )
    expect(run.rows[0]).toMatchObject({ stage: 'brainstorm', status: 'PENDING' })
  })
})

// ────────────────────────── answer ──────────────────────────

describe('answer', () => {
  it('空白答复：拒绝且零写入', async () => {
    const taskId = await seedClarificationTask()
    const before = await counts(taskId)

    const r = await answerTask(taskId, '   ', { now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(await counts(taskId)).toEqual(before)
  })

  it('状态不对：拒绝且零写入（不会留下 feedback）', async () => {
    const taskId = await seedTask('S-PM_ANALYZING')
    const before = await counts(taskId)

    const r = await answerTask(taskId, '补充说明', { now: NOW })
    expect(r.ok).toBe(false)

    expect(await counts(taskId)).toEqual(before)
    expect(await feedbackRows(taskId)).toEqual([])
  })

  it('正常：feedback(manual) 落库并关联、timer 取消、状态回 S-PM_ANALYZING、派发 pm', async () => {
    const taskId = await seedClarificationTask()

    const r = await answerTask(taskId, '  目标用户是内部运维  ', { now: NOW })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.transitionId).toBe('T-007')

    const after = await counts(taskId)
    expect(after.status).toBe('S-PM_ANALYZING')
    expect(after.pendingTimers).toBe(0)
    expect(after.runs).toBe(1)

    const feedback = await feedbackRows(taskId)
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.id).toBe(r.value.feedbackId)
    expect(feedback[0]?.source).toBe('manual')
    expect(feedback[0]?.body).toBe('目标用户是内部运维')

    const run = await asOwner((c) =>
      c.query<{ stage: string; status: string }>('SELECT stage, status FROM run WHERE task_id=$1', [
        taskId,
      ]),
    )
    expect(run.rows[0]).toMatchObject({ stage: 'pm', status: 'PENDING' })

    // 事件流里 LinkFeedback 必须是真落地，而不是「已记录意图」
    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: Record<string, unknown> }>(
        'SELECT type, payload FROM event WHERE task_id=$1',
        [taskId],
      ),
    )
    expect(
      evs.rows.filter((e) => e.type === 'SideEffectApplied' && e.payload.kind === 'LinkFeedback'),
    ).toHaveLength(1)
    expect(
      evs.rows.filter((e) => e.type === 'SideEffectIntent' && e.payload.kind === 'LinkFeedback'),
    ).toEqual([])
  })

  it('advance 未推进：错误里必须带出未关联 feedback 的 id', async () => {
    const taskId = await seedClarificationTask()
    const fake = new FakeAdvancer({
      advanced: false,
      transition_id: null,
      reason: 'optimistic lock',
    })

    const r = await answerTask(taskId, '补充说明', { now: NOW, driver: fake })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('optimistic lock')
    expect(r.error.detail).toMatch(/feedback [0-9a-f-]{36}/)
  })
})
