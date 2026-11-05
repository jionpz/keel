/**
 * 独立 timer worker(issue #26,进程崩溃恢复)。
 *
 * 方案 A/B 的收割是 loop 进程内(澄清 branch / watchdog setTimeout);
 * 进程崩溃后无人收割。本模块提供**独立进程**定期 drain:
 *   - 澄清 TTL → advance(TimerFired) → T-008(ConsumeTimer 置 fired)
 *   - 人工裁决 TTL → advance(TimerFired) → T-028(ConsumeTimer 置 fired)
 *   - run 墙钟 → reapTimeoutRun(RUNNING guard → TIMEOUT → T-030/T-031)
 *
 * 并发安全:claimDueTimers 用 SKIP LOCKED(只锁不标),ConsumeTimer /
 * 标状态在各自 advance 事务内 —— 双 worker 竞争不双投。
 *
 * 库函数;接入层(未来 CLI/daemon)负责监督。scripts/timer-worker.ts 是启动示例。
 */

import type { WorkflowDriver } from '../control/driver/driver.js'
import { livenessMode } from '../control/liveness/policy.js'
import type { LivenessStore } from '../control/liveness/store.js'
import { asRole } from '../fact/db.js'
import type { TransitionTimerKind } from '../shared/timers.js'
import { claimDueTimers } from './drain.js'
import {
  EMPTY_PATROL_STATS,
  type PatrolDeps,
  type PatrolStats,
  patrolStalledRuns,
} from './patrol.js'
import { reapTimeoutRun } from './reap.js'

export interface ReapStats {
  clarificationFired: number
  humanReviewFired: number
  runTimeout: number
  skipped: number
  /** 本轮巡检（progress 模式下才有） */
  patrol: PatrolStats
}

export interface WorkerDeps {
  readonly driver: WorkflowDriver
  readonly now: () => string
  /**
   * liveness 存储；传入后 timer worker 同时承担 out-of-process 巡检。
   * 缺省不巡检 —— 与旧部署兼容，也不让 timer worker 隐式依赖 liveness 表。
   */
  readonly store?: LivenessStore
  /** 测试注入；缺省 `patrolStalledRuns` */
  readonly patrol?: (deps: PatrolDeps) => Promise<PatrolStats>
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
 * 收割所有到期 timer(澄清 + 人工裁决 + run 墙钟)。
 * 幂等:重复调用不双投(claim SKIP LOCKED;标状态 only RUNNING)。
 */
export async function drainAllDueTimers(deps: WorkerDeps): Promise<ReapStats> {
  const stats: ReapStats = {
    clarificationFired: 0,
    humanReviewFired: 0,
    runTimeout: 0,
    skipped: 0,
    patrol: { ...EMPTY_PATROL_STATS },
  }

  // 1) 两类 Task 级 TTL：到期 → 对应转移(ConsumeTimer 在 advance 事务内置 fired)
  const ttls: readonly TransitionTimerKind[] = ['clarification_ttl', 'human_review_ttl']
  for (const kind of ttls) {
    const due = await claimDueTimers(deps.now(), { kind, limit: 50 })
    for (const t of due) {
      const adv = await deps.driver.advance(
        t.taskId,
        { type: 'TimerFired', timer: kind },
        deps.now(),
      )
      if (adv.ok) {
        if (!adv.value.advanced)
          stats.skipped++ // 状态与 claim 过滤不一致的残留行
        else if (kind === 'clarification_ttl') stats.clarificationFired++
        else stats.humanReviewFired++
      } else {
        stats.skipped++
      }
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

  // 3) 孤儿 run 巡检：owner 心跳过期 + 无进展 → TIMEOUT/RUN_STALLED
  // wallclock 模式整体退回旧路径（design.md §7），不巡检。
  if (deps.store !== undefined && livenessMode() === 'progress') {
    const patrol = deps.patrol ?? patrolStalledRuns
    stats.patrol = await patrol({
      driver: deps.driver,
      store: deps.store,
      now: deps.now,
    })
  }

  return stats
}

/** 信号源抽象 —— 测试注入假实现,生产默认 process */
export interface TimerSignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
}

const processSignals: TimerSignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler)
  },
  off: (signal, handler) => {
    process.off(signal, handler)
  },
}

export interface RunForeverOptions {
  readonly intervalMs?: number
  readonly signals?: TimerSignalSource
  /** 注入 drain(测试用);缺省 `drainAllDueTimers` */
  readonly drain?: (deps: WorkerDeps) => Promise<ReapStats>
}

/**
 * 常驻循环:周期 drain,直到 SIGTERM / SIGINT 优雅退出。
 * intervalMs 缺省 5s。不引入 daemon 监督框架 —— 接入层负责。
 *
 * 退出必须是**跳出循环**,不能只是「让 race 的另一臂先完成」:
 * 旧写法把 `new Promise(r => process.once('SIGTERM', r))` 放在循环外,
 * 信号一到这个 promise 就永久 settle,之后每轮 `Promise.race` 立即返回 ——
 * 进程不再等待 interval,而是**满速反复 drain**(实测每秒数千轮),直到被 SIGKILL。
 * 所以这里用显式的 `stopRequested` 控制 while,信号同时叫醒当前这一轮等待。
 */
export async function runForever(deps: WorkerDeps, opts: RunForeverOptions = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5_000
  const signals = opts.signals ?? processSignals
  const drain = opts.drain ?? drainAllDueTimers

  let stopRequested = false
  /** 当前这一轮等待的唤醒函数(只有 sleep 期间存在) */
  let wake: (() => void) | undefined

  const onSignal = (): void => {
    stopRequested = true
    wake?.()
  }

  signals.on('SIGTERM', onSignal)
  signals.on('SIGINT', onSignal)
  try {
    while (!stopRequested) {
      await drain(deps)
      // drain 期间可能收到信号:此时不再等 interval,直接退出
      if (stopRequested) break

      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          wake = undefined
          resolve()
        }
        timer = setTimeout(finish, intervalMs)
        wake = finish
      })
    }
  } finally {
    signals.off('SIGTERM', onSignal)
    signals.off('SIGINT', onSignal)
  }
}
