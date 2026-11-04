/**
 * keel CLI 分发层生命周期单测。
 *
 * 这里只测 `runCli` 的收口行为:**任何出口都关连接池**,且关池本身失败
 * 不会把成功的命令变成失败。不 spawn 进程、不连 DB。
 */

import { describe, expect, it, vi } from 'vitest'
import { runCli } from './run.js'

describe('runCli(退出前关连接池)', () => {
  it('成功路径也关闭连接池', async () => {
    const closeDb = vi.fn(async () => undefined)
    await runCli(['--version'], { closeDb })
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('未知命令(只置 exitCode)后仍关闭连接池', async () => {
    const closeDb = vi.fn(async () => undefined)
    const previous = process.exitCode
    try {
      await runCli(['no-such-command'], { closeDb })
      expect(process.exitCode).toBe(2)
    } finally {
      process.exitCode = previous
    }
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('子命令抛错时关闭连接池,并继续把原始异常抛给入口', async () => {
    const closeDb = vi.fn(async () => undefined)
    const boom = new Error('boom')
    await expect(
      runCli(['status', 'task-1'], {
        closeDb,
        dispatch: async () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('关池失败不改变子命令的成败', async () => {
    await expect(
      runCli(['--version'], {
        closeDb: async () => {
          throw new Error('pool already closed')
        },
      }),
    ).resolves.toBeUndefined()
  })
})
