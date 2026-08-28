/**
 * 预算熔断（C-002）—— docs/08-cross-cutting.md §3.3、docs/04-state-machine.md §3.1。
 *
 * 熔断改的是 `control_mode`，**不改 `status`**：预算耗尽与业务进展无关，
 * 改 status 会丢失「当时做到哪了」这个事实。暂停后 driver.advance 会因
 * `control_mode_not_auto` 拒绝一切转移（`T-040`/`T-041` 除外），不再派发新 Run ——
 * 这就是「超预算不静默继续」（C3）的全部机制，无需动转移表。
 *
 * 无 CAP-STREAM 的固有缺陷（§3.5）：熔断在 Run 结束后核算时触发，
 * 超支已经发生。这不是实现缺陷，是能力缺失的必然结果。
 */

import type { PoolClient } from 'pg'
import { ensureTraceId } from '../../fact/trace.js'
import type { ControlMode } from '../../shared/ids.js'

/**
 * 全局默认预算（C2）：Task 未显式设 `budget_usd` 时生效。
 * 见 docs/08-cross-cutting.md §3.2 —— 每个 Task 必须有预算上限，可用全局默认。
 */
export const DEFAULT_TASK_BUDGET_USD = 10

export interface BudgetFuseOutcome {
  /** 本次检查是否触发了熔断（已是 paused 的不重复触发） */
  readonly tripped: boolean
  readonly cost_spent_usd: number
  readonly budget_usd: number
}

/**
 * 核算该 Task 的累计成本，超预算则熔断（C-002：auto → paused）。
 *
 * 只计 `billed` / `estimated` 的 Run —— `unavailable` 的 Run cost_usd 为 null，
 * 「不知道花了多少」不能折算成金额参与熔断（禁止用 0 冒充，§3.1），
 * 它们由 C4 的 wall_clock / max_turns 兜底约束。
 *
 * 必须在成本写回 run 行的**同一事务**内调用：否则「写回了成本但熔断没看到」
 * 会在崩溃重启后留下一个本该暂停却继续烧钱的 Task。
 *
 * @param now 时间由外部注入 —— Control Plane 不读时钟（与 driver.advance 同一纪律）
 */
export async function checkBudgetFuse(
  c: PoolClient,
  taskId: string,
  now: string,
): Promise<BudgetFuseOutcome> {
  const spent = await c.query<{ s: string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS s FROM run
     WHERE task_id = $1 AND cost_basis IN ('billed', 'estimated')`,
    [taskId],
  )
  const costSpent = Number(spent.rows[0]?.s ?? 0)

  const t = await c.query<{ budget_usd: string | null; control_mode: ControlMode }>(
    'SELECT budget_usd, control_mode FROM task WHERE id = $1',
    [taskId],
  )
  const task = t.rows[0]
  if (task === undefined) {
    // 编程错误：调用方持有的 taskId 必然存在
    throw new Error(`checkBudgetFuse：找不到 task ${taskId}`)
  }
  const budget = task.budget_usd === null ? DEFAULT_TASK_BUDGET_USD : Number(task.budget_usd)

  if (costSpent <= budget || task.control_mode !== 'auto') {
    return { tripped: false, cost_spent_usd: costSpent, budget_usd: budget }
  }

  const traceId = await ensureTraceId(c, taskId, now)
  await c.query(
    `UPDATE task SET control_mode = 'paused', updated_at = $2::timestamptz WHERE id = $1`,
    [taskId, now],
  )
  await c.query(
    `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
     VALUES ($1,$2,$3::jsonb,$4,$5)`,
    [
      taskId,
      'ControlModeChanged',
      JSON.stringify({ transition: 'C-002', from: 'auto', to: 'paused', reason: 'budget' }),
      traceId,
      now,
    ],
  )
  await c.query(
    `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
     VALUES ($1,$2,$3::jsonb,$4,$5)`,
    [
      taskId,
      'BudgetExceeded',
      JSON.stringify({ cost_spent_usd: costSpent, budget_usd: budget }),
      traceId,
      now,
    ],
  )

  return { tripped: true, cost_spent_usd: costSpent, budget_usd: budget }
}
