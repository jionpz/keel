/**
 * claimDueTimers —— 到期澄清 timer 的候选收割(issue #24,方案 A)。
 *
 * 与 CI 外部事件源对齐,但只在澄清态用。**只锁定/列出仍 pending 的到期行,
 * 不改 state** —— 置 fired 属于 T-008(ConsumeTimer)在同一 advance 事务内,
 * 崩溃则仍 pending,可重投(方案 A 第 3 条)。
 *
 * FOR UPDATE SKIP LOCKED:并发 drain 时跳过已被锁的行,防双投。
 */

import { asRole } from '../fact/db.js'

export interface DueTimer {
  readonly id: string
  readonly taskId: string
  readonly kind: 'clarification_ttl'
}

export interface ClaimOptions {
  /** 只取该 task 的到期澄清 timer(loop 在 S-NEED_CLARIFICATION 用它) */
  readonly taskId?: string
  readonly limit?: number
}

/**
 * 列出到期且仍 pending 的澄清 timer。
 *
 * @param now 时间注入 —— 控制平面不读系统时钟。
 */
export async function claimDueTimers(now: string, opts: ClaimOptions = {}): Promise<DueTimer[]> {
  return asRole('keel_control', async (c) => {
    let sql = `SELECT id, task_id FROM timer
               WHERE kind = 'clarification_ttl' AND state = 'pending' AND due_at <= $1`
    const params: unknown[] = [now]
    if (opts.taskId !== undefined) {
      params.push(opts.taskId)
      sql += ` AND task_id = $${params.length}`
    }
    sql += ' ORDER BY due_at LIMIT '
    sql += String(opts.limit ?? 50)
    sql += ' FOR UPDATE SKIP LOCKED'
    const r = await c.query<{ id: string; task_id: string }>(sql, params)
    return r.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      kind: 'clarification_ttl' as const,
    }))
  })
}
