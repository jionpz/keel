/**
 * timer-worker 的单实例锁接线单测 —— 全部注入，不碰数据库。
 *
 * 锁的真实语义（会话级 advisory lock、崩溃自动释放）由
 * `src/fact/resident-lock.test.ts` 用真实 Postgres 覆盖；这里只确认 CLI
 * 在正确时机取锁、拿不到就退出、结束（含抛错）后恰好释放一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResidentLock } from '../fact/resident-lock.js'
import { EMPTY_PATROL_STATS } from '../timer/patrol.js'
import type { ReapStats, WorkerDeps } from '../timer/worker.js'
import { timerWorkerMain } from './timer-worker.js'

const STATS: ReapStats = {
  clarificationFired: 0,
  humanReviewFired: 0,
  humanReviewArmed: 0,
  runTimeout: 0,
  skipped: 0,
  patrol: { ...EMPTY_PATROL_STATS },
}

interface FakeLock {
  readonly lock: ResidentLock
  readonly release: ReturnType<typeof vi.fn>
}

function fakeLock(): FakeLock {
  const release = vi.fn(async () => undefined)
  return { lock: { role: 'timer-worker', release }, release }
}

beforeEach(() => {
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('timerWorkerMain · 单实例锁', () => {
  it('--help 不获取锁', async () => {
    const acquireLock = vi.fn(async () => fakeLock().lock)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await timerWorkerMain(['--help'], { acquireLock })

    expect(process.exitCode).toBeUndefined()
    expect(acquireLock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('keel timer-worker')
  })

  it('已有实例（锁为 null）→ 退出码 1，不创建 store、不 drain', async () => {
    const drain = vi.fn(async () => STATS)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await timerWorkerMain([], { acquireLock: async () => null, drain })

    expect(process.exitCode).toBe(1)
    expect(drain).not.toHaveBeenCalled()
    const text = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('已有实例在运行')
    expect(text).toContain('单次收割也持锁')
  })

  it('单次模式 → drain 调用一次，release 恰好一次，日志带 humanReviewArmed', async () => {
    const { lock, release } = fakeLock()
    const drain = vi.fn(async (_deps: WorkerDeps) => STATS)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await timerWorkerMain([], { acquireLock: async () => lock, drain })

    expect(process.exitCode).toBeUndefined()
    expect(drain).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    const text = logSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('humanReviewFired=0')
    expect(text).toContain('humanReviewArmed=0')
  })

  it('解析后的 humanReviewTtlMs 传给 WorkerDeps（与 driver 同源，不二次解析）', async () => {
    const previous = process.env.KEEL_HUMAN_REVIEW_TTL_H
    process.env.KEEL_HUMAN_REVIEW_TTL_H = '2'
    try {
      const { lock } = fakeLock()
      const drain = vi.fn(async (_deps: WorkerDeps) => STATS)
      vi.spyOn(console, 'log').mockImplementation(() => undefined)

      await timerWorkerMain([], { acquireLock: async () => lock, drain })

      expect(drain.mock.calls[0]?.[0].humanReviewTtlMs).toBe(2 * 3600 * 1000)
    } finally {
      if (previous === undefined) delete process.env.KEEL_HUMAN_REVIEW_TTL_H
      else process.env.KEEL_HUMAN_REVIEW_TTL_H = previous
    }
  })

  it('--interval 5 → 常驻循环收到 intervalMs，release 恰好一次', async () => {
    const { lock, release } = fakeLock()
    const run = vi.fn(async (_deps: WorkerDeps, _opts: { intervalMs: number }) => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await timerWorkerMain(['--interval', '5'], {
      acquireLock: async () => lock,
      drain: async () => {
        throw new Error('常驻模式不应调用 drain 注入点')
      },
      run,
    })

    expect(process.exitCode).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toEqual({ intervalMs: 5 })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('drain 抛错 → 异常冒泡且 release 仍恰好一次', async () => {
    const { lock, release } = fakeLock()

    await expect(
      timerWorkerMain([], {
        acquireLock: async () => lock,
        drain: async () => {
          throw new Error('boom')
        },
      }),
    ).rejects.toThrow('boom')

    expect(release).toHaveBeenCalledTimes(1)
  })
})
