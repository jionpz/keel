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
import type { HarnessTier } from '../../shared/ids.js'

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
 * 认领时一并写入 run 行的 harness 身份。
 *
 * 为什么必须在 **claim 时**写而不是等结算：编排进程死掉后，run 由 timer worker /
 * patrol 收割 —— 那些进程拿不到 adapter。若只在结算路径写身份，最需要事后追查的
 * 场景（进程已死、日志已消失）反而读到 NULL。认领先落身份，之后任何终态路径
 * （本进程结算、墙钟收割、巡检收割）都能直接回答「谁跑的」。
 */
export interface ClaimIdentity {
  readonly harnessId: string
  readonly harnessTier: HarnessTier
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
 * `harness_id` / `harness_tier` 同样用 coalesce：传了身份就同语句写入，
 * 没传（旧调用点）或已有值时保留原值 —— 身份是「谁认领了」，不该被重试清空。
 * 身份与状态在**同一条 UPDATE**里落库，不追加第二条查询：
 * 第 3 层触发时事务已中止（见下），认领后追加的任何查询都不合法。
 *
 * 拒绝路径（N4 / N3）在 UPDATE 之前或影响 0 行时返回，**不写身份** ——
 * run 原样留在 PENDING，此时它还没有「谁在跑」。
 *
 * ⚠️ 第 3 层触发时事务已中止，本函数必须是该事务的最后一个操作
 * （asRole 对中止事务的 COMMIT 会由 Postgres 转为 ROLLBACK，不抛错）。
 */
export async function claimRunForExecution(
  c: PoolClient,
  runId: string,
  maxRunningRuns: number = DEFAULT_MAX_RUNNING_RUNS,
  identity?: ClaimIdentity,
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
      `UPDATE run SET status = 'RUNNING', started_at = coalesce(started_at, now()),
              harness_id = coalesce($2, harness_id),
              harness_tier = coalesce($3, harness_tier)
       WHERE id = $1 AND status = 'PENDING'`,
      [runId, identity?.harnessId ?? null, identity?.harnessTier ?? null],
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
