/**
 * 存量 S-HUMAN_REVIEW 的人工裁决 TTL 对账补齐（issue #75）。
 *
 * 忠实于真实驱动路径：真实 Postgres + `asRole` 真实权限，不用 mock。
 *
 * 覆盖：
 *   - 补齐一条 pending，`due_at = now + 生效 TTL`
 *   - 幂等：重复调用不新增、不改 `due_at`
 *   - `ttlMs = null`（KEEL_HUMAN_REVIEW_TTL_H=0）→ 不补
 *   - 自定义 TTL
 *   - 非目标状态 / `control_mode != 'auto'` → 不补
 *   - 已有 pending 行不动；已有 cancelled 行允许补新的 pending
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../fact/db.js'
import type { ControlMode, TaskStatus } from '../shared/ids.js'
import { armMissingHumanReviewTimers } from './arm.js'

const NOW = '2026-11-07T10:00:00Z'
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

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

async function seedTask(status: TaskStatus, controlMode: ControlMode = 'auto'): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, control_mode, title, repo_id, base_branch, work_branch)
       VALUES ($1,$2,$3,'TTL 对账',$4,'main','ai/t')`,
      [taskId, status, controlMode, repoId],
    )
  })
  return taskId
}

interface TimerRow {
  id: string
  state: string
  due_at: Date
  run_id: string | null
}

async function timersOf(taskId: string): Promise<TimerRow[]> {
  const r = await asOwner((c) =>
    c.query<TimerRow>(
      `SELECT id, state, due_at, run_id FROM timer
       WHERE task_id=$1 AND kind='human_review_ttl'
       ORDER BY created_at`,
      [taskId],
    ),
  )
  return r.rows
}

async function seedTimer(
  taskId: string,
  state: 'pending' | 'cancelled' | 'fired',
  dueAt: string,
): Promise<string> {
  const id = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO timer (id, task_id, run_id, kind, due_at, state, fired_at)
       VALUES ($1,$2,NULL,'human_review_ttl',$3,$4,$5)`,
      [id, taskId, dueAt, state, state === 'fired' ? dueAt : null],
    ),
  )
  return id
}

describe('armMissingHumanReviewTimers', () => {
  it('S-HUMAN_REVIEW 且无 timer → 补一条 pending，due = now + 24h', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')

    const armed = await armMissingHumanReviewTimers(NOW, DAY_MS)

    expect(armed).toBe(1)
    const rows = await timersOf(taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('pending')
    expect(rows[0]?.run_id).toBeNull() // Task 级 timer 不带 run
    expect(rows[0]?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)
  })

  it('幂等：第二次调用不新增行、不改 due_at', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    expect(await armMissingHumanReviewTimers(NOW, DAY_MS)).toBe(1)
    const before = await timersOf(taskId)

    // 即便注入更晚的时间与不同的 TTL，也不得重置已经武装的期限
    const armed = await armMissingHumanReviewTimers('2026-11-07T11:00:00Z', 2 * DAY_MS)

    expect(armed).toBe(0)
    const after = await timersOf(taskId)
    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(before[0]?.id)
    expect(after[0]?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)
  })

  it('ttlMs = null（关闭调度）→ 不插行、返回 0', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')

    const armed = await armMissingHumanReviewTimers(NOW, null)

    expect(armed).toBe(0)
    expect(await timersOf(taskId)).toHaveLength(0)
  })

  it('自定义 TTL（1h）→ due = now + 1h', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')

    expect(await armMissingHumanReviewTimers(NOW, HOUR_MS)).toBe(1)

    const rows = await timersOf(taskId)
    expect(rows[0]?.due_at.getTime()).toBe(Date.parse(NOW) + HOUR_MS)
  })

  it('非 S-HUMAN_REVIEW 的任务 → 不补', async () => {
    const taskId = await seedTask('S-PM_ANALYZING')

    expect(await armMissingHumanReviewTimers(NOW, DAY_MS)).toBe(0)
    expect(await timersOf(taskId)).toHaveLength(0)
  })

  for (const mode of ['paused', 'human'] as const) {
    it(`control_mode=${mode} → 不补（T-028 在该模式下不会转移）`, async () => {
      const taskId = await seedTask('S-HUMAN_REVIEW', mode)

      expect(await armMissingHumanReviewTimers(NOW, DAY_MS)).toBe(0)
      expect(await timersOf(taskId)).toHaveLength(0)
    })
  }

  it('已有 pending 行 → 不改 due_at、不新增行', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const existingDue = '2026-11-01T00:00:00Z'
    const id = await seedTimer(taskId, 'pending', existingDue)

    expect(await armMissingHumanReviewTimers(NOW, DAY_MS)).toBe(0)

    const rows = await timersOf(taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.state).toBe('pending')
    expect(rows[0]?.due_at.getTime()).toBe(Date.parse(existingDue))
  })

  it('已有 cancelled 行 → 补一条新的 pending（部分唯一索引只约束 pending）', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const cancelledId = await seedTimer(taskId, 'cancelled', '2026-11-01T00:00:00Z')

    expect(await armMissingHumanReviewTimers(NOW, DAY_MS)).toBe(1)

    const rows = await timersOf(taskId)
    expect(rows).toHaveLength(2)
    const cancelled = rows.find((r) => r.id === cancelledId)
    const pending = rows.find((r) => r.id !== cancelledId)
    expect(cancelled?.state).toBe('cancelled')
    expect(pending?.state).toBe('pending')
    expect(pending?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)
  })
})
