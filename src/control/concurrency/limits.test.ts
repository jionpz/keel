/**
 * 并发守卫（N3/N4）的确定性验证 —— docs/08-cross-cutting.md §4.3/§4.4。
 *
 * 反例风格（database-guidelines.md §不变量必须用反例验证）：
 * 多数用例是一次**期望被拒绝的违规尝试**。测试不通过时改约束/实现，不改测试。
 *
 * 钉住的主张：
 * 1. N3（DB 层）：部分唯一索引 run_one_running_per_task 拒绝同 Task 第二个 RUNNING
 * 2. N3（应用层）：认领是 PENDING→RUNNING 乐观锁，重复认领得 CONFLICT（可重试）
 * 3. N3（映射）：索引兜底触发时被映射为 CONFLICT，事务回滚不留半个 RUNNING
 * 4. N4：全局 RUNNING 达上限时认领被拒且不静默；释放后恢复可认领
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import { claimRunForExecution, DEFAULT_MAX_RUNNING_RUNS } from './limits.js'

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

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
       VALUES ($1,'S-PM_ANALYZING','并发守卫验证',$2,'main',$3)`,
      [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
    )
  })
  return taskId
}

/** 直插一条 run —— 测试装置，绕过编排（attempt 区分同 Task 的多条） */
async function seedRun(taskId: string, status: string, attempt = 1): Promise<string> {
  const id = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'pm','PM',$3,$4,$5)`,
      [id, taskId, attempt, status, `${taskId}/pm/${attempt}`],
    ),
  )
  return id
}

async function runRow(
  runId: string,
): Promise<{ status: string; started_at: Date | null } | undefined> {
  const r = await asOwner((c) =>
    c.query<{ status: string; started_at: Date | null }>(
      'SELECT status, started_at FROM run WHERE id=$1',
      [runId],
    ),
  )
  return r.rows[0]
}

describe('N3 · 单 Task 至多一个 RUNNING（数据库强制）', () => {
  it('同 Task 第二个 RUNNING 被部分唯一索引拒绝', async () => {
    const taskId = await seedTask()
    await seedRun(taskId, 'RUNNING', 1)

    // 违规尝试：期望被 run_one_running_per_task 拒绝
    await expect(seedRun(taskId, 'RUNNING', 2)).rejects.toMatchObject({
      code: '23505',
      constraint: 'run_one_running_per_task',
    })

    // 终态不受限：历史尝试可以有任意多条
    await seedRun(taskId, 'FAILED', 3)
    await seedRun(taskId, 'SUCCEEDED', 4)
  })

  it('不同 Task 各自一个 RUNNING 互不影响（索引是 per-task 的）', async () => {
    const a = await seedTask()
    const b = await seedTask()
    await seedRun(a, 'RUNNING')
    await seedRun(b, 'RUNNING')
  })
})

describe('N3 · 认领是 PENDING→RUNNING 乐观锁', () => {
  it('认领成功：status→RUNNING 且 started_at 落盘', async () => {
    const taskId = await seedTask()
    const runId = await seedRun(taskId, 'PENDING')

    const r = await asRole('keel_control', (c) => claimRunForExecution(c, runId))
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)

    const row = await runRow(runId)
    expect(row?.status).toBe('RUNNING')
    expect(row?.started_at, '进入 RUNNING 的时刻必须落盘').not.toBeNull()
  })

  it('重复认领（已不在 PENDING）→ CONFLICT，可重试', async () => {
    const taskId = await seedTask()
    const runId = await seedRun(taskId, 'PENDING')
    await asRole('keel_control', (c) => claimRunForExecution(c, runId))

    const again = await asRole('keel_control', (c) => claimRunForExecution(c, runId))
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error.kind).toBe('CONFLICT')
    expect(again.error.retryable).toBe(true)
  })

  it('同 Task 已有另一个 RUNNING → 索引兜底映射为 CONFLICT，事务回滚', async () => {
    const taskId = await seedTask()
    await seedRun(taskId, 'RUNNING', 1)
    const pendingId = await seedRun(taskId, 'PENDING', 2)

    const r = await asRole('keel_control', (c) => claimRunForExecution(c, pendingId))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CONFLICT')
    expect(r.error.detail).toContain('run_one_running_per_task')

    // 事务已回滚：没有留下半个 RUNNING
    const row = await runRow(pendingId)
    expect(row?.status).toBe('PENDING')
  })
})

describe('N4 · 全局 RUNNING 上限', () => {
  it('默认上限是 3（docs/08-cross-cutting.md §4.3 的保守起步值）', () => {
    expect(DEFAULT_MAX_RUNNING_RUNS).toBe(3)
  })

  it('达上限时认领被拒且不静默；释放一个后恢复可认领', async () => {
    for (let i = 0; i < DEFAULT_MAX_RUNNING_RUNS; i++) {
      await seedRun(await seedTask(), 'RUNNING')
    }
    const taskId = await seedTask()
    const pendingId = await seedRun(taskId, 'PENDING')

    const rejected = await asRole('keel_control', (c) => claimRunForExecution(c, pendingId))
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.kind).toBe('CONFLICT')
    expect(rejected.error.retryable).toBe(true)
    expect(rejected.error.detail).toContain('上限')

    // run 原样留在 PENDING —— 拒绝不是丢弃
    expect((await runRow(pendingId))?.status).toBe('PENDING')

    // 释放一个名额后同一个 run 可以被认领 —— 上限是流控，不是判死
    await asOwner((c) =>
      c.query(
        `UPDATE run SET status='SUCCEEDED', ended_at=now()
         WHERE id = (SELECT id FROM run WHERE status='RUNNING' LIMIT 1)`,
      ),
    )
    const accepted = await asRole('keel_control', (c) => claimRunForExecution(c, pendingId))
    expect(accepted.ok, accepted.ok ? '' : accepted.error.detail).toBe(true)
    expect((await runRow(pendingId))?.status).toBe('RUNNING')
  })
})
