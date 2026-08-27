/**
 * 并发守卫（N3/N4）—— docs/08-cross-cutting.md §4.3/§4.4。
 *
 * 职责单一：把一个 PENDING 的 run **认领**为 RUNNING。
 * 认领 = 上限检查 + 乐观锁更新，两者必须在**同一事务**内 ——
 * 分开就会出现「检查时没超，更新时已超」的窗口。
 *
 * v0.1 单进程同步编排下这些冲突不会自然发生，
 * 但约束的价值在于**被机械化**：多进程调度器（阶段三）接入时，
 * 这里就是它必须通过的门，而不是一段要重新发明的逻辑。
 */

import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'

/**
 * 全局同时 RUNNING 的 Run 数上限（N4）。
 *
 * docs/08-cross-cutting.md §4.3 建议起步 3。v0.1 写死为单处常量，日后从配置读 ——
 * 「可配置」的最低形式是调用方能传 `maxRunningRuns` 覆盖。
 */
export const DEFAULT_MAX_RUNNING_RUNS = 3

/** Postgres unique_violation —— 部分唯一索引 run_one_running_per_task 兜底触发 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'
}

/**
 * 把 run 从 PENDING 认领为 RUNNING。
 *
 * 三层防线，从软到硬：
 *
 * 1. **N4 上限**：先数全局 RUNNING，`>= max` 即拒绝 —— 不静默吞掉，返回可重试 CONFLICT
 * 2. **N3 乐观锁**：`UPDATE ... WHERE status='PENDING'`，影响行数为 0 说明
 *    已被并发认领（或已终结），同样返回 CONFLICT
 * 3. **N3 数据库兜底**：同 Task 已有 RUNNING run 时，部分唯一索引
 *    `run_one_running_per_task` 抛 23505 —— 按 database-guidelines.md 映射为 CONFLICT
 *
 * `started_at` 用 coalesce 保护：重复认领尝试不会覆盖首次进入 RUNNING 的时刻。
 *
 * ⚠️ 第 3 层触发时事务已中止，本函数必须是该事务的最后一个操作
 * （asRole 对中止事务的 COMMIT 会由 Postgres 转为 ROLLBACK，不抛错）。
 */
export async function claimRunForExecution(
  c: PoolClient,
  runId: string,
  maxRunningRuns: number = DEFAULT_MAX_RUNNING_RUNS,
): Promise<Result<void>> {
  const running = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM run WHERE status = 'RUNNING'`,
  )
  const n = Number(running.rows[0]?.n ?? 0)
  if (n >= maxRunningRuns) {
    return err(
      makeError(
        'CONFLICT',
        `全局 RUNNING run 已达上限 ${maxRunningRuns}（当前 ${n}），run ${runId} 暂不认领`,
      ),
    )
  }

  try {
    const upd = await c.query(
      `UPDATE run SET status = 'RUNNING', started_at = coalesce(started_at, now())
       WHERE id = $1 AND status = 'PENDING'`,
      [runId],
    )
    if (upd.rowCount === 0) {
      return err(makeError('CONFLICT', `run ${runId} 不在 PENDING，无法认领为 RUNNING`))
    }
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err(
        makeError(
          'CONFLICT',
          `run ${runId} 所属 Task 已有 RUNNING run（run_one_running_per_task）`,
        ),
      )
    }
    throw e
  }

  return ok(undefined)
}
