/**
 * claimDueTimers —— 到期 Task 级 TTL 的候选收割(issue #24 方案 A,
 * 11-05-human-review-ttl 扩到两类)。
 *
 * **只锁定/列出仍 pending 的到期行,不改 state** —— 置 fired 属于对应转移
 * (T-008 / T-028 的 ConsumeTimer)在同一 advance 事务内,崩溃则仍 pending,
 * 可重投(方案 A 第 3 条)。
 *
 * `JOIN task` 限定目标状态:澄清只收割 `S-NEED_CLARIFICATION`、人工裁决只收割
 * `S-HUMAN_REVIEW`。这样即使某条终态转移漏了 CancelTimer,残留行也只是
 * 「一行不动的数据」,而不是每轮都被唤醒一次。
 *
 * FOR UPDATE OF t SKIP LOCKED:并发 drain 时跳过已被锁的 timer 行,防双投;
 * 只锁 timer,不锁 task —— 后者属于 advance 的事务。
 */

import { asRole } from '../fact/db.js'
import type { TransitionTimerKind } from '../shared/timers.js'

export interface DueTimer {
  readonly id: string
  readonly taskId: string
  readonly kind: TransitionTimerKind
}

export interface ClaimOptions {
  /** 只取该 task 的到期 timer(loop 在等待态用它) */
  readonly taskId?: string
  readonly limit?: number
  /** 默认 clarification_ttl —— 既有调用一行都不用改 */
  readonly kind?: TransitionTimerKind
}

/** 每个 TTL 只在对应状态里收割 */
const KIND_STATUS: Readonly<Record<TransitionTimerKind, string>> = {
  clarification_ttl: 'S-NEED_CLARIFICATION',
  human_review_ttl: 'S-HUMAN_REVIEW',
}

/**
 * 列出到期且仍 pending 的指定 timer。
 *
 * @param now 时间注入 —— 控制平面不读系统时钟。
 */
export async function claimDueTimers(now: string, opts: ClaimOptions = {}): Promise<DueTimer[]> {
  const kind = opts.kind ?? 'clarification_ttl'
  return asRole('keel_control', async (c) => {
    const params: unknown[] = [kind, now, KIND_STATUS[kind]]
    let sql = `SELECT t.id, t.task_id FROM timer t
               JOIN task k ON k.id = t.task_id
               WHERE t.kind = $1 AND t.state = 'pending' AND t.due_at <= $2
                 AND k.status = $3`
    if (opts.taskId !== undefined) {
      params.push(opts.taskId)
      sql += ` AND t.task_id = $${params.length}`
    }
    sql += ' ORDER BY t.due_at LIMIT '
    sql += String(opts.limit ?? 50)
    sql += ' FOR UPDATE OF t SKIP LOCKED'
    const r = await c.query<{ id: string; task_id: string }>(sql, params)
    return r.rows.map((row) => ({ id: row.id, taskId: row.task_id, kind }))
  })
}
