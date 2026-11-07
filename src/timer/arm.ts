/**
 * 补齐存量 S-HUMAN_REVIEW 的人工裁决 TTL（issue #75）。
 *
 * `human_review_ttl` 只在**进入** `S-HUMAN_REVIEW` 的转移里武装
 * （T-013 / T-020 / T-023 / T-026 / T-031）。功能上线前就停在该状态的任务
 * 没有进门转移可走，永远不会被武装，T-028 的到期弃单对它们不生效。
 *
 * 这里做**运行期对账**，不是第二套进门逻辑：
 *   - 只补 `control_mode='auto'`：`paused` / `human` 下 T-028 不会转移，
 *     补了也只会被 claim 后跳过；
 *   - `ttlMs = null`（`KEEL_HUMAN_REVIEW_TTL_H=0`）时不补；
 *   - 已有 pending 行不改 `due_at`，重复 drain 不重复插入；
 *   - `FOR UPDATE OF k` 与改变 `task.status` 的转移串行，避免在批准/驳回/回炉
 *     提交后留下一条 pending 行，挡住下一次进门转移的 `StartTimer`
 *     （`timer_pending_key` 会让它静默 `skipped`）。
 *
 * 期限来源与 `StartTimer` 同源：由调用方传入**生效 TTL** —— 本模块不读 env、
 * 不读时钟（`now` 由参数注入）。
 */

import { randomUUID } from 'node:crypto'
import { asRole } from '../fact/db.js'

/**
 * 为缺失人工裁决 TTL 的存量任务补齐一条 pending timer。
 *
 * @param now 注入时间（控制平面不读系统时钟）。
 * @param ttlMs 生效 TTL 毫秒；`null` 表示关闭调度，直接返回 0（不连库）。
 * @returns 实际插入的 pending 行数。
 */
export async function armMissingHumanReviewTimers(
  now: string,
  ttlMs: number | null,
): Promise<number> {
  if (ttlMs === null) return 0

  // 本轮补齐行共用同一个期限：从首次对账的 now 起算，给存量任务一个完整窗口。
  const due = new Date(new Date(now).getTime() + ttlMs).toISOString()

  return asRole('keel_control', async (c) => {
    // 只查 pending：fired / cancelled 行不阻止新的 pending
    // （部分唯一索引也只约束 pending）。
    const tasks = await c.query<{ id: string }>(
      `SELECT k.id
       FROM task k
       WHERE k.status = 'S-HUMAN_REVIEW'
         AND k.control_mode = 'auto'
         AND NOT EXISTS (
           SELECT 1 FROM timer t
           WHERE t.task_id = k.id
             AND t.kind = 'human_review_ttl'
             AND t.state = 'pending'
         )
       FOR UPDATE OF k`,
    )

    let inserted = 0
    for (const row of tasks.rows) {
      // SQL 与 effects.ts 的 StartTimer 保持一致；ON CONFLICT 是第二道防线，
      // 即使有并发插入也不重复、不改已有期限。
      const ins = await c.query(
        `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
         VALUES ($1,$2,NULL,'human_review_ttl',$3,'pending')
         ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING`,
        [randomUUID(), row.id, due],
      )
      inserted += ins.rowCount ?? 0
    }
    return inserted
  })
}
