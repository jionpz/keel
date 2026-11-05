import { describe, expect, it, vi } from 'vitest'
import type { ProgressEvent } from '../../contracts/harness-adapter.js'
import type { SessionHandle } from '../../execution/session/manager.js'
import type { LivenessStore } from './store.js'
import { StallSupervisor } from './supervisor.js'

const HANDLE: SessionHandle = {
  session_id: 's1',
  run_id: '00000000-0000-0000-0000-000000000001',
  harness_id: 'omp',
}

function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const setIntervalFn = (fn: () => void, ms: number) => {
    const timer = { fn, ms, cleared: false }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setInterval>
  }
  const clearIntervalFn = (timer: ReturnType<typeof setInterval>) => {
    ;(timer as unknown as { cleared: boolean }).cleared = true
  }
  return { timers, setIntervalFn, clearIntervalFn }
}

function fakeStore() {
  const recordProgress = vi.fn()
  const recordHarnessProcess = vi.fn()
  const heartbeatOwner = vi.fn()
  const recordSilencePolicy = vi.fn()
  return {
    store: {
      recordProgress,
      recordHarnessProcess,
      heartbeatOwner,
      recordSilencePolicy,
    } as unknown as LivenessStore,
    recordProgress,
    recordHarnessProcess,
    heartbeatOwner,
    recordSilencePolicy,
  }
}

function sessionsStub() {
  const calls: Array<{ run_id: string; reason: string }> = []
  return {
    calls,
    sessions: {
      interrupt: async (handle: SessionHandle, reason: string) => {
        calls.push({ run_id: handle.run_id, reason })
        return { ok: true as const, value: undefined }
      },
    },
  }
}

describe('StallSupervisor', () => {
  it('持续有进展时，3× 阈值仍不中断', () => {
    let clock = 0
    const { sessions, calls } = sessionsStub()
    const supervisor = new StallSupervisor({
      sessions,
      policy: { silenceMs: 100, hardCapS: 600 },
      now: () => clock,
      wallNow: () => '2026-11-05T00:00:00Z',
    })
    supervisor.start(HANDLE)

    for (const at of [90, 180, 270]) {
      clock = at
      supervisor.noteProgress({ kind: 'turn_start', at })
      supervisor.checkSilence()
    }
    expect(calls).toHaveLength(0)
    supervisor.stop()
  })

  it('静默到阈值立即 interrupt("stalled")，且只中断一次', () => {
    let clock = 0
    const { sessions, calls } = sessionsStub()
    const stalls: unknown[] = []
    const supervisor = new StallSupervisor({
      sessions,
      policy: { silenceMs: 100, hardCapS: 600 },
      now: () => clock,
      wallNow: () => '2026-11-05T00:00:00Z',
      onStall: (evidence) => stalls.push(evidence),
    })
    supervisor.start(HANDLE)

    clock = 99
    supervisor.checkSilence()
    expect(calls).toHaveLength(0)

    clock = 100
    supervisor.checkSilence()
    expect(calls).toEqual([{ run_id: HANDLE.run_id, reason: 'stalled' }])
    expect(stalls[0]).toMatchObject({
      silenceMs: 100,
      lastKind: null,
      source: 'supervisor',
      orphanKilled: null,
    })
    expect(supervisor.interruptedByStalled).toBe(true)

    clock = 500
    supervisor.checkSilence()
    expect(calls).toHaveLength(1)
    supervisor.stop()
  })

  it('progressSource = none（silenceMs null）不挂沉默检查，但 owner 心跳仍续', () => {
    const { timers, setIntervalFn, clearIntervalFn } = fakeTimers()
    const { store, heartbeatOwner, recordSilencePolicy } = fakeStore()
    const supervisor = new StallSupervisor({
      sessions: sessionsStub().sessions,
      policy: { silenceMs: null, hardCapS: 600 },
      now: () => 0,
      wallNow: () => '2026-11-05T00:00:00Z',
      store,
      setIntervalFn,
      clearIntervalFn,
    })
    supervisor.start(HANDLE)

    // 巡检需要知道本 run 不做沉默判定
    expect(recordSilencePolicy).toHaveBeenCalledWith(HANDLE.run_id, null)

    // 只有 owner 心跳一个定时器
    expect(timers).toHaveLength(1)
    expect(heartbeatOwner).toHaveBeenCalledTimes(1)
    timers[0]?.fn()
    expect(heartbeatOwner).toHaveBeenCalledTimes(2)

    supervisor.stop()
    expect(timers[0]?.cleared).toBe(true)
  })

  it('noteProgress 写入进展与孤儿清理线索（进程信息只记一次）', () => {
    const { store, recordProgress, recordHarnessProcess } = fakeStore()
    const clock = 0
    const supervisor = new StallSupervisor({
      sessions: sessionsStub().sessions,
      policy: { silenceMs: 10_000, hardCapS: 600 },
      now: () => clock,
      wallNow: () => '2026-11-05T00:00:00Z',
      store,
    })
    supervisor.start(HANDLE)

    const first: ProgressEvent = {
      kind: 'session',
      at: 10,
      pid: 4321,
      pgid: 4321,
      startedAt: '2026-11-05T00:00:00.000Z',
    }
    supervisor.noteProgress(first)
    supervisor.noteProgress({ kind: 'turn_start', at: 20 })

    expect(recordProgress).toHaveBeenCalledTimes(2)
    expect(recordHarnessProcess).toHaveBeenCalledTimes(1)
    expect(recordHarnessProcess).toHaveBeenCalledWith(
      HANDLE.run_id,
      4321,
      4321,
      '2026-11-05T00:00:00.000Z',
    )
    supervisor.stop()
  })

  it('stop() 清理沉默检查与心跳两个定时器', () => {
    const { timers, setIntervalFn, clearIntervalFn } = fakeTimers()
    const { store } = fakeStore()
    const supervisor = new StallSupervisor({
      sessions: sessionsStub().sessions,
      policy: { silenceMs: 1_000, hardCapS: 600 },
      now: () => 0,
      wallNow: () => '2026-11-05T00:00:00Z',
      store,
      setIntervalFn,
      clearIntervalFn,
    })
    supervisor.start(HANDLE)
    expect(timers).toHaveLength(2)

    supervisor.stop()
    expect(timers.every((t) => t.cleared)).toBe(true)
  })
})
