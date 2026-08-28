/**
 * trace_id —— O2「trace_id 贯穿 Task 全程」的落点（docs/08-cross-cutting.md §2.5）。
 *
 * 模型（§2.3）：trace = 一个 Task 的完整生命周期。因此 trace_id 与 Task 一一对应，
 * **不新增表列**（PRD 要求优先复用现有 schema）：它的持久化宿主就是事件流本身 ——
 * 第一条携带 trace_id 的事件把它固定下来，之后所有事件写入时读回同一个值。
 *
 * 放在 Fact Plane 是因为 trace_id 是 event 表的列，归事实层管；
 * Control Plane 的各个写事件处（driver / pipeline / builder / fuse）统一调这里。
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

/**
 * 取该 Task 的 trace_id；尚无则生成并固定。
 *
 * 幂等：已有任何携带 trace_id 的事件即复用最早那条的值。
 * 首次生成时补写一条 `TaskCreated` 事件作为宿主 —— 覆盖 seed 直插表创建、
 * 以及历史事件尚未带 trace 的路径。经 `driver.intake`（T-001）创建的 Task
 * 会在同事务内先调本函数，因此 T-001 段事件与后续事件共享同一 trace。
 *
 * @param occurredAt 可选。传入时写入宿主事件的 occurred_at（ADR-0003 注入时钟）；
 *                   省略则回落 DB DEFAULT now()——仅兼容尚未传 now 的旧调用点。
 *
 * 并发注记：两个事务同时首次生成会产生两个 trace_id（无唯一约束兜底）。
 * N2 乐观锁落地后已收紧：driver.advance 的首次生成发生在**赢得 task 行锁之后**
 * （`UPDATE ... WHERE status=期望值` 命中才继续），并发 Dispatch 的败者
 * 会阻塞到胜者提交，随后从事件流读回同一个 trace_id，不会分裂出第二条 trace。
 */
export async function ensureTraceId(
  c: PoolClient,
  taskId: string,
  occurredAt?: string,
): Promise<string> {
  const existing = await c.query<{ trace_id: string }>(
    `SELECT trace_id FROM event
     WHERE task_id = $1 AND trace_id IS NOT NULL
     ORDER BY seq ASC LIMIT 1`,
    [taskId],
  )
  const found = existing.rows[0]?.trace_id
  if (found !== undefined) return found

  const traceId = randomUUID()
  if (occurredAt !== undefined) {
    await c.query(
      `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
       VALUES ($1, 'TaskCreated', $2::jsonb, $3, $4)`,
      [taskId, JSON.stringify({ trace_id: traceId }), traceId, occurredAt],
    )
  } else {
    await c.query(
      `INSERT INTO event (task_id, type, payload, trace_id)
       VALUES ($1, 'TaskCreated', $2::jsonb, $3)`,
      [taskId, JSON.stringify({ trace_id: traceId }), traceId],
    )
  }
  return traceId
}
