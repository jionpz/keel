/**
 * timer worker 常驻循环的退出行为单测。
 *
 * 回归的缺陷:SIGTERM 之后不能只是「让 race 的另一臂先完成」。
 * 旧实现把 `process.once('SIGTERM', resolve)` 的 promise 放在循环外,
 * 信号一到它就永久 settle,之后每轮 `Promise.race` 立即返回 ——
 * 进程满速反复 drain 而不退出。这里用可注入的信号源与 drain 断言:
 * 信号之后**扫过的轮数不再增长**,且循环真的 resolve。
 *
 * 不连数据库:driver 由注入的 drain 屏蔽。
 */

import { describe, expect, it } from 'vitest'
import type { WorkflowDriver } from '../control/driver/driver.js'
import { EMPTY_PATROL_STATS } from './patrol.js'
import { type ReapStats, runForever, type TimerSignalSource, type WorkerDeps } from './worker.js'

const ZERO: ReapStats = {
  clarificationFired: 0,
  humanReviewFired: 0,
  runTimeout: 0,
  skipped: 0,
  patrol: { ...EMPTY_PATROL_STATS },
}

/** 不碰库的 deps:测试注入 drain,driver 只是类型占位 */
const deps: WorkerDeps = {
  driver: {} as unknown as WorkflowDriver,
  now: () => '2026-11-04T00:00:00.000Z',
}

interface FakeSignals {
  readonly source: TimerSignalSource
  emit(signal: 'SIGTERM' | 'SIGINT'): void
  /** 当前注册的监听总数 —— 退出后必须为 0 */
  listenerCount(): number
}

function createFakeSignals(): FakeSignals {
  const handlers = new Map<string, Set<() => void>>()
  const slot = (signal: string): Set<() => void> => {
    const existing = handlers.get(signal)
    if (existing !== undefined) return existing
    const created = new Set<() => void>()
    handlers.set(signal, created)
    return created
  }
  return {
    source: {
      on: (signal, handler) => {
        slot(signal).add(handler)
      },
      off: (signal, handler) => {
        slot(signal).delete(handler)
      },
    },
    emit: (signal) => {
      for (const handler of [...slot(signal)]) handler()
    },
    listenerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  }
}

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('runForever(SIGTERM 退出)', () => {
  it('等待期间收到 SIGTERM:立刻退出,不再进入下一轮', async () => {
    const signals = createFakeSignals()
    let drains = 0
    const running = runForever(deps, {
      intervalMs: 10_000,
      signals: signals.source,
      drain: async () => {
        drains += 1
        return ZERO
      },
    })

    await tick(10) // 让它跑完第一轮、进入等待
    expect(drains).toBe(1)

    signals.emit('SIGTERM')
    await running

    expect(drains).toBe(1)
    expect(signals.listenerCount()).toBe(0)
  })

  it('drain 期间收到 SIGTERM:本轮结束后直接退出,不再等待 interval', async () => {
    const signals = createFakeSignals()
    let drains = 0
    await runForever(deps, {
      intervalMs: 10_000,
      signals: signals.source,
      drain: async () => {
        drains += 1
        signals.emit('SIGTERM')
        return ZERO
      },
    })

    expect(drains).toBe(1)
    expect(signals.listenerCount()).toBe(0)
  })

  it('没有信号时按 interval 继续下一轮(退出由信号驱动,不是只跑一轮)', async () => {
    const signals = createFakeSignals()
    let drains = 0
    await runForever(deps, {
      intervalMs: 1,
      signals: signals.source,
      drain: async () => {
        drains += 1
        if (drains === 3) signals.emit('SIGINT')
        return ZERO
      },
    })

    expect(drains).toBe(3)
    expect(signals.listenerCount()).toBe(0)
  })
})
