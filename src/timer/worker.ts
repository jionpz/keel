/**
 * 独立 timer worker(issue #26,进程崩溃恢复)。
 *
 * 方案 A/B 的收割是 loop 进程内(澄清 branch / watchdog setTimeout);
 * 进程崩溃后无人收割。本模块提供**独立进程**定期 drain:
 *   - 澄清 TTL → advance(TimerFired) → T-008(ConsumeTimer 置 fired)
 *   - run 墙钟 → reapTimeoutRun(RUNNING guard → TIMEOUT → T-030/T-031)
 *
 * 并发安全:claimDueTimers 用 SKIP LOCKED(只锁不标),ConsumeTimer /
 * 标状态在各自 advance 事务内 —— 双 worker 竞争不双投。
 *
 * 库函数;接入层(未来 CLI/daemon)负责监督。scripts/timer-worker.ts 是启动示例。
 */

import type { WorkflowDriver } from '../control/driver/driver.js'
import { asRole } from '../fact/db.js'
import { claimDueTimers } from './drain.js'
import { reapTimeoutRun } from './reap.js'

export interface ReapStats {
  clarificationFired: number
  runTimeout: number
  skipped: number
}

export interface WorkerDeps {
  readonly driver: WorkflowDriver
  readonly now: () => string
}

/** 到期 run 墙钟 + 关联 RUNNING run(批量,供 reapTimeoutRun) */
interface DueWallClock {
  taskId: string
  runId: string
  stage: string
}

async function dueWallClocks(now: string, limit = 50): Promise<DueWallClock[]> {
  return asRole('keel_control', (c) =>
    c
      .query<{ task_id: string; run_id: string; stage: string }>(
        `SELECT t.task_id, t.run_id, r.stage
       FROM timer t
       JOIN run r ON r.id = t.run_id
       WHERE t.kind = 'wall_clock' AND t.state = 'pending' AND t.due_at <= $1
       ORDER BY t.due_at
       LIMIT $2`,
        [now, limit],
      )
      .then((r) =>
        r.rows.map((row) => ({ taskId: row.task_id, runId: row.run_id, stage: row.stage })),
      ),
  )
}

/**
 * 收割所有到期 timer(澄清 + run 墙钟)。
 * 幂等:重复调用不双投(claim SKIP LOCKED;标状态 only RUNNING)。
 */
export async function drainAllDueTimers(deps: WorkerDeps): Promise<ReapStats> {
  const stats: ReapStats = { clarificationFired: 0, runTimeout: 0, skipped: 0 }

  // 1) 澄清 TTL → T-008(ConsumeTimer 在 advance 事务内置 fired)
  const clar = await claimDueTimers(deps.now(), { limit: 50 })
  for (const t of clar) {
    const adv = await deps.driver.advance(
      t.taskId,
      { type: 'TimerFired', timer: 'clarification_ttl' },
      deps.now(),
    )
    if (adv.ok) {
      if (adv.value.advanced) stats.clarificationFired++
      else stats.skipped++ // 已离开澄清态,不 Consume —— 由 T-007 CancelTimer 清
    } else {
      stats.skipped++
    }
  }

  // 2) run 墙钟 → reapTimeoutRun(TIMEOUT → T-030/T-031)
  const wall = await dueWallClocks(deps.now())
  for (const w of wall) {
    const r = await reapTimeoutRun(
      w.taskId,
      w.stage as import('../shared/ids.js').Stage,
      w.runId,
      deps.driver,
      deps.now(),
    )
    if (r.ok) {
      if (r.value === 'timeout') stats.runTimeout++
      else stats.skipped++ // run 非 RUNNING(loop 已处理/已终态)
    } else {
      stats.skipped++
    }
  }

  return stats
}

/**
 * 常驻循环:周期 drain,直到 SIGTERM 优雅退出。
 * intervalMs 缺省 5s。不引入 daemon 监督框架 —— 接入层负责。
 */
export async function runForever(
  deps: WorkerDeps,
  opts: { intervalMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5_000
  const stopped = new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve())
  })

  for (;;) {
    await drainAllDueTimers(deps)
    // race:interval 到点继续,或 SIGTERM 退出
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, intervalMs)
      }),
      stopped,
    ])
    if (timer !== null) clearTimeout(timer)
  }
}
