/**
 * 进程内沉默监管 —— 属 Control Plane。
 *
 * 只回答一个问题：**这个 Run 多久没有新进展了？** 不负责总时长，
 * 也不负责孤立 run（那是 out-of-process Patrol 的职责）。
 *
 * 设计：`.trellis/tasks/11-04-run-liveness-patrol/design.md` §4.4。
 */

import type { ProgressEvent } from '../../contracts/harness-adapter.js'
import type { HarnessSessionManager, SessionHandle } from '../../execution/session/manager.js'
import type { LivenessPolicy } from './policy.js'
import type { LivenessStore } from './store.js'

export interface StallEvidence {
  readonly silenceMs: number
  readonly lastProgressAt: string
  readonly lastKind: string | null
  readonly ownerHeartbeatAt: string | null
  readonly source: 'supervisor'
  readonly orphanKilled: boolean | null
}

export interface StallSupervisorDeps {
  readonly sessions: Pick<HarnessSessionManager, 'interrupt'>
  readonly policy: LivenessPolicy
  /** 单调时钟；必须与 `ProgressEvent.at` 同源 */
  readonly now: () => number
  /** 持久化 / 证据用的墙钟（ISO） */
  readonly wallNow: () => string
  readonly store?: LivenessStore
  /** 沉默检查间隔；默认 min(15s, silenceMs / 4) */
  readonly checkIntervalMs?: number
  /** owner 心跳间隔；默认 15s */
  readonly ownerHeartbeatMs?: number
  readonly onStall?: (evidence: StallEvidence) => void
  /** 仅测试注入 */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  readonly clearIntervalFn?: (timer: ReturnType<typeof setInterval>) => void
}

export class StallSupervisor {
  private handle: SessionHandle | null = null
  private lastProgressAt = 0
  private lastProgressIso: string
  private lastKind: string | null = null
  private ownerHeartbeatAt: string | null = null
  private silenceTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stalled = false
  private stopped = false
  private processRecorded = false

  constructor(private readonly deps: StallSupervisorDeps) {
    this.lastProgressIso = deps.wallNow()
  }

  /** 开始监管一个 session：记录起点、启动沉默检查与 owner 心跳 */
  start(handle: SessionHandle): void {
    if (this.handle !== null) return
    this.handle = handle
    this.lastProgressAt = this.deps.now()
    this.lastProgressIso = this.deps.wallNow()

    // owner 心跳证明的是「编排进程还活着」，与模型是否在动无关。
    // human / 无进展信号也要续，否则巡检会把它当孤儿 run。
    this.beat()
    if (this.deps.store !== undefined) {
      // 巡检在另一个进程里，只能从 DB 知道本 run 该不该按沉默判定
      this.deps.store.recordSilencePolicy(handle.run_id, this.deps.policy.silenceMs)
      const heartbeatMs = this.deps.ownerHeartbeatMs ?? 15_000
      this.heartbeatTimer = (this.deps.setIntervalFn ?? setInterval)(() => this.beat(), heartbeatMs)
      this.heartbeatTimer.unref?.()
    }

    const silenceMs = this.deps.policy.silenceMs
    if (silenceMs === null) return
    const interval = this.deps.checkIntervalMs ?? Math.min(15_000, Math.max(1, silenceMs / 4))
    this.silenceTimer = (this.deps.setIntervalFn ?? setInterval)(
      () => this.checkSilence(),
      interval,
    )
    this.silenceTimer.unref?.()
  }

  /** 每次进展重置沉默计时，并异步落遥测（不阻塞 stdout 消费） */
  noteProgress(event: ProgressEvent): void {
    if (this.handle === null || this.stopped) return
    this.lastProgressAt = event.at
    this.lastProgressIso = this.deps.wallNow()
    this.lastKind = event.kind

    if (
      !this.processRecorded &&
      event.pid !== undefined &&
      event.pgid !== undefined &&
      event.startedAt !== undefined
    ) {
      this.processRecorded = true
      this.deps.store?.recordHarnessProcess(
        this.handle.run_id,
        event.pid,
        event.pgid,
        event.startedAt,
      )
    }
    this.deps.store?.recordProgress(this.handle.run_id, event.kind, event.at, this.lastProgressIso)
  }

  /** 供定时器与测试调用：达到阈值则中断一次 */
  checkSilence(): void {
    if (this.stopped || this.stalled || this.handle === null) return
    const silenceMs = this.deps.policy.silenceMs
    if (silenceMs === null) return
    const silence = this.deps.now() - this.lastProgressAt
    if (silence < silenceMs) return

    this.stalled = true
    this.stopSilenceTimer()
    const evidence: StallEvidence = {
      silenceMs: silence,
      lastProgressAt: this.lastProgressIso,
      lastKind: this.lastKind,
      ownerHeartbeatAt: this.ownerHeartbeatAt,
      source: 'supervisor',
      orphanKilled: null,
    }
    // 不 await：中断由 adapter 收敛，pipeline 的 advance 会返回 RUN_TIMEOUT
    void this.deps.sessions.interrupt(this.handle, 'stalled')
    this.deps.onStall?.(evidence)
  }

  /** 本次中断是否由沉默监管触发；pipeline 据此映射 RUN_STALLED */
  get interruptedByStalled(): boolean {
    return this.stalled
  }

  stop(): void {
    this.stopped = true
    this.stopSilenceTimer()
    if (this.heartbeatTimer !== null) {
      ;(this.deps.clearIntervalFn ?? clearInterval)(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private beat(): void {
    if (this.deps.store === undefined || this.handle === null) return
    this.ownerHeartbeatAt = this.deps.wallNow()
    this.deps.store.heartbeatOwner(this.handle.run_id, process.pid, this.ownerHeartbeatAt)
  }

  private stopSilenceTimer(): void {
    if (this.silenceTimer === null) return
    ;(this.deps.clearIntervalFn ?? clearInterval)(this.silenceTimer)
    this.silenceTimer = null
  }
}
