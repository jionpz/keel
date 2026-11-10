/**
 * 独立运行巡检 —— 由 timer worker 的常驻 drain 循环调用。
 *
 * 解决 supervisor 解决不了的那一半：**编排进程自己死了**。
 * supervisor 只能监管活着的进程；进程没了，没人推进展，也没人收割。
 *
 * 判据与顺序（design.md §4.5）：
 *   owner 心跳过期（≠ 进展过期）→ 按 run 的 `silence_ms` 判无进展 → 幂等 claim
 *   → best-effort 清孤儿进程 → run 标 TIMEOUT/RUN_STALLED → `RunStalled` 转移。
 *
 * 两处刻意的保守：
 *   - 没有 `silence_ms`（human / 无进展信号）的 run 不被按沉默收割；
 *   - 没有 liveness 行的旧 run 不进入候选，走既有 wall_clock 兜底。
 */

import { execFileSync } from 'node:child_process'
import type { WorkflowDriver } from '../control/driver/driver.js'
import type { LivenessCandidate, LivenessStore } from '../control/liveness/store.js'
import { asRole } from '../fact/db.js'
import { ensureTraceId } from '../fact/trace.js'
import type { Stage } from '../shared/ids.js'

/** 启动时间比对的容差：进程启动时间只精确到秒 */
const START_TIME_TOLERANCE_MS = 2_000
/** SIGTERM 之后等多久再 SIGKILL */
const DEFAULT_KILL_GRACE_MS = 5_000
/** SIGKILL 之后给内核回收进程组的时间 */
const KILL_CONFIRM_MS = 200

export interface ProcessInfo {
  readonly alive: boolean
  /** `ps -o lstart=` 的解析结果；无法读取时为 null（不杀，不假装已清理） */
  readonly startedAt: Date | null
}

export interface PatrolDeps {
  readonly driver: WorkflowDriver
  readonly store: LivenessStore
  readonly now: () => string
  /** owner 心跳超过这个时长才算「进程可能已死」。默认 30s */
  readonly ownerGraceMs?: number
  readonly scanLimit?: number
  readonly killGraceMs?: number
  readonly pruneRetainDays?: number
  /** 测试注入：默认 `ps -o lstart=` + `kill(pid, 0)` */
  readonly inspectProcess?: (pid: number) => ProcessInfo
  /** 测试注入：默认 `process.kill(-pgid, signal)` */
  readonly killProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}

export interface PatrolStats {
  scanned: number
  claimed: number
  reaped: number
  skipped: number
  orphansKilled: number
  orphanAlive: number
  pruned: number
  errors: number
  error: string | null
}

export const EMPTY_PATROL_STATS: PatrolStats = {
  scanned: 0,
  claimed: 0,
  reaped: 0,
  skipped: 0,
  orphansKilled: 0,
  orphanAlive: 0,
  pruned: 0,
  errors: 0,
  error: null,
}

/**
 * 扫描一轮孤儿 run。不抛异常：失败写进 stats + `worker_health('patrol', ...)`，
 * 由调用方决定告警。抛出去会让常驻 drain 循环整轮退出。
 */
export async function patrolStalledRuns(deps: PatrolDeps): Promise<PatrolStats> {
  const stats: PatrolStats = { ...EMPTY_PATROL_STATS }
  const now = deps.now()
  const nowMs = Date.parse(now)

  try {
    const ownerGraceMs = deps.ownerGraceMs ?? 30_000
    const cutoff = new Date(nowMs - ownerGraceMs).toISOString()
    const candidates = await deps.store.readStaleCandidates(cutoff, deps.scanLimit ?? 50)
    stats.scanned = candidates.length

    for (const candidate of candidates) {
      const silenceMs = candidate.silence_ms
      // NULL = 本 run 不做沉默判定（human / 无进展信号）
      if (silenceMs === null) {
        stats.skipped++
        continue
      }
      const lastMs = toEpoch(candidate.last_progress_at ?? candidate.started_at)
      if (lastMs === null) {
        stats.skipped++
        continue
      }
      const silence = nowMs - lastMs
      if (silence < silenceMs) {
        stats.skipped++
        continue
      }

      // 幂等 claim：双 worker 同时巡检，只有一个能继续
      const claimed = await deps.store.markStallReported(candidate.run_id, now)
      if (!claimed) {
        stats.skipped++
        continue
      }
      stats.claimed++

      const orphanKilled = await killOrphan(candidate, deps)
      if (orphanKilled === true) stats.orphansKilled++
      if (orphanKilled === false) {
        stats.orphanAlive++
        // 杀不掉不是静默成功：交给 worker_health 让运维看见
        stats.error ??= `orphan_alive: run=${candidate.run_id} pid=${candidate.harness_pid}`
      }

      const settled = await reapStalledRun(candidate, silence, orphanKilled, now)
      if (!settled) {
        // run 已由 loop / 其他 worker 终结：不再 emit、不再 advance
        stats.skipped++
        continue
      }

      const adv = await deps.driver.advance(
        candidate.task_id,
        { type: 'RunStalled', stage: candidate.stage as Stage },
        now,
      )
      if (!adv.ok) {
        stats.errors++
        stats.error = `advance(${candidate.task_id}) 失败：${adv.error.detail}`
        continue
      }
      if (adv.value.advanced) stats.reaped++
      else stats.skipped++
    }

    stats.pruned = await deps.store.pruneTerminal(now, deps.pruneRetainDays ?? 7)
  } catch (error) {
    stats.errors++
    stats.error = error instanceof Error ? error.message : String(error)
  }

  try {
    await deps.store.recordWorkerHealth('patrol', now, stats.error)
  } catch (error) {
    stats.errors++
    stats.error ??= `worker_health 写入失败：${error instanceof Error ? error.message : String(error)}`
  }
  return stats
}

/**
 * 标终态 + 落带证据的 `RunStalled` 事件（同一事务）。
 *
 * RUNNING guard 与 loop 的围栏同纪律：影响 0 行时什么都不写。
 */
async function reapStalledRun(
  candidate: LivenessCandidate,
  silenceMs: number,
  orphanKilled: boolean | null,
  now: string,
): Promise<boolean> {
  return asRole('keel_control', async (c) => {
    const updated = await c.query(
      `UPDATE run SET status='TIMEOUT', ended_at=$2, error_kind='RUN_STALLED',
              error_detail='巡检：owner 进程失联且无进展'
       WHERE id=$1 AND status='RUNNING'`,
      [candidate.run_id, now],
    )
    if ((updated.rowCount ?? 0) === 0) return false

    const traceId = await ensureTraceId(c, candidate.task_id, now)
    await c.query(
      `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
       VALUES ($1,$2,'RunStalled',$3::jsonb,$4,$5)`,
      [
        candidate.task_id,
        candidate.run_id,
        JSON.stringify({
          silence_ms: silenceMs,
          last_progress_at: isoOf(candidate.last_progress_at),
          last_kind: candidate.last_kind,
          owner_heartbeat_at: isoOf(candidate.owner_heartbeat_at),
          source: 'patrol',
          orphan_killed: orphanKilled,
        }),
        traceId,
        now,
      ],
    )
    return true
  })
}

/**
 * best-effort 清理孤儿进程组。
 *
 * 返回 true = 已确认消失；false = 尝试过但仍活着（记录 orphan_alive）；
 * null = 无法尝试或无法校验（不杀，不假装已清理）。
 *
 * 只在 `pgid === pid` 时动手 —— OMP 以 detached 进程组启动，组号即 leader pid；
 * 其他形态杀 `-pgid` 可能波及无关进程。
 */
async function killOrphan(candidate: LivenessCandidate, deps: PatrolDeps): Promise<boolean | null> {
  const { harness_pid: pid, harness_pgid: pgid, harness_started_at: startedAt } = candidate
  if (pid === null || pgid === null || startedAt === null) return null
  if (pid !== pgid) return null

  const expected = toEpoch(startedAt)
  if (expected === null) return null

  const inspect = deps.inspectProcess ?? inspectProcess
  const info = inspect(pid)
  // 读不到启动时间 = 无法排除 PID 复用：不杀
  if (info.startedAt === null) return null
  // 进程早已不存在：没有孤儿可清，也无需假装杀过
  if (!info.alive) return null
  if (Math.abs(info.startedAt.getTime() - expected) > START_TIME_TOLERANCE_MS) return null

  const kill =
    deps.killProcessGroup ??
    ((group: number, signal: NodeJS.Signals) => {
      process.kill(-group, signal)
    })
  const graceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS

  try {
    kill(pgid, 'SIGTERM')
  } catch {
    // 进程可能在 SIGTERM 前已退出
    return inspect(pid).alive ? null : true
  }

  await wait(graceMs)
  if (!inspect(pid).alive) return true

  try {
    kill(pgid, 'SIGKILL')
  } catch {
    return !inspect(pid).alive
  }
  await wait(KILL_CONFIRM_MS)
  return !inspect(pid).alive
}

/** 默认探针：`ps -o lstart=` 取启动时间（秒级），`kill(pid, 0)` 判存活 */
export function inspectProcess(pid: number): ProcessInfo {
  let alive = true
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM = 进程存在但不属于当前用户
    alive = code === 'EPERM'
  }

  let startedAt: Date | null = null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    if (out !== '') {
      const parsed = new Date(out)
      if (!Number.isNaN(parsed.getTime())) startedAt = parsed
    }
  } catch {
    startedAt = null
  }
  return { alive, startedAt }
}

/** pg 的 timestamptz 既可能是 Date 也可能是 ISO 字符串；统一成 epoch 毫秒 */
function toEpoch(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : ms
  }
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function isoOf(value: unknown): string | null {
  const ms = toEpoch(value)
  return ms === null ? null : new Date(ms).toISOString()
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
