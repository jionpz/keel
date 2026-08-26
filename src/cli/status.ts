/**
 * keel status —— 查 task / run / 事件摘要(issue #27)。
 */

import { asOwner } from '../fact/db.js'
import { parseArgs } from './argv.js'

export async function statusMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel status <taskId> [--events N]

查 task 状态 / run 明细 / 最近事件(N 缺省 20)。`)
    return
  }
  const taskId = positionals[0]
  const eventsN =
    typeof flags.events === 'number'
      ? flags.events
      : typeof flags.events === 'string'
        ? Number(flags.events)
        : 20

  const task = await asOwner((c) =>
    c.query<{
      status: string
      control_mode: string
      created_at: string
      updated_at: string
      terminal_at: string | null
    }>(
      `SELECT status, control_mode, created_at, updated_at, terminal_at
       FROM task WHERE id = $1`,
      [taskId],
    ),
  )
  const row = task.rows[0]
  if (row === undefined) {
    console.error(`status: 找不到 task ${taskId}`)
    process.exitCode = 1
    return
  }
  console.log(`task ${taskId}: ${row.status} [${row.control_mode}]`)
  console.log(
    `  created=${row.created_at} updated=${row.updated_at} terminal_at=${row.terminal_at ?? '(未终态)'}`,
  )

  const runs = await asOwner((c) =>
    c.query<{ stage: string; attempt: number; status: string; error_kind: string | null }>(
      `SELECT stage, attempt, status, error_kind FROM run WHERE task_id = $1 ORDER BY attempt`,
      [taskId],
    ),
  )
  if (runs.rows.length > 0) {
    console.log('runs:')
    for (const r of runs.rows) {
      console.log(
        `  ${r.stage} #${r.attempt}: ${r.status}${r.error_kind !== null ? ` (${r.error_kind})` : ''}`,
      )
    }
  }

  const events = await asOwner((c) =>
    c.query<{ seq: string; type: string; payload: Record<string, unknown> }>(
      `SELECT seq, type, payload FROM event WHERE task_id = $1 ORDER BY seq DESC LIMIT $2`,
      [taskId, eventsN],
    ),
  )
  if (events.rows.length > 0) {
    console.log(`events (最近 ${events.rows.length}):`)
    for (const e of [...events.rows].reverse()) {
      const payload = JSON.stringify(e.payload).slice(0, 80)
      console.log(`  #${e.seq} ${e.type} ${payload}`)
    }
  }
}
