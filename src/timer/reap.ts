/**
 * run 超时收割 —— 独立 timer worker 用(issue #26,进程崩溃恢复)。
 *
 * 方案 B 的 watchdog 是 loop 进程内 setTimeout;进程死则 in-flight run
 * 无人收割,卡 RUNNING。本模块由独立 worker(drainAllDueTimers)调用,
 * 让收割不依赖编排进程存活。
 *
 * 语义与 `loop.failRunAndAdvance` 的 RUN_TIMEOUT 分支等值(独立实现,不重构):
 *   - 标 run TIMEOUT + cancel 墙钟 timer + advance(RunTimeout) → T-030/T-031。
 * 差异:仅对 `RUNNING` 的 run 标 TIMEOUT(RUNNING guard 保守)——
 *   并发双 worker / 与 loop 竞态时,后到者 rowCount=0 → 跳过,不发 RunTimeout。
 */

import type { PoolClient } from 'pg'
import { ok, type Result } from '../contracts/errors.js'
import type { WorkflowDriver } from '../control/driver/driver.js'
import { asRole } from '../fact/db.js'
import type { Stage } from '../shared/ids.js'

export type ReapRunOutcome = 'timeout' | 'skipped-not-running'

/**
 * 收割一个 run 的超时:标 TIMEOUT(仅 RUNNING)→ cancel timer → RunTimeout → T-030/T-031。
 *
 * 事务化标状态 + cancel(同事务);advance 在标成功后调用。
 */
export async function reapTimeoutRun(
  taskId: string,
  stage: Stage,
  runId: string,
  driver: WorkflowDriver,
  now: string,
): Promise<Result<ReapRunOutcome>> {
  const marked = await asRole('keel_control', async (c): Promise<'marked' | 'not-running'> => {
    const up = await c.query(
      `UPDATE run SET status='TIMEOUT', ended_at=$2, error_kind='RUN_TIMEOUT',
              error_detail='timer worker 收割'
       WHERE id=$1 AND status='RUNNING'`,
      [runId, now],
    )
    await cancelWallClock(c, runId)
    return up.rowCount === 0 ? 'not-running' : 'marked'
  })

  if (marked === 'not-running') {
    return ok('skipped-not-running' as const)
  }

  // 标 TIMEOUT 成功 → 发 RunTimeout → T-030 重试 / T-031 升人工
  const adv = await driver.advance(taskId, { type: 'RunTimeout', stage }, now)
  if (!adv.ok) {
    return { ok: false, error: adv.error }
  }
  return ok('timeout' as const)
}

/** timer 置 cancelled(幂等:仅 pending 行) */
async function cancelWallClock(c: PoolClient, runId: string): Promise<void> {
  await c.query(
    `UPDATE timer SET state='cancelled'
     WHERE run_id=$1 AND kind='wall_clock' AND state='pending'`,
    [runId],
  )
}
