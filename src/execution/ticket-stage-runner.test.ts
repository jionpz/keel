import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type { RunResult } from '../contracts/harness-adapter.js'
import { MANAGED_STAGE_CLEANUP_MS, MANAGED_STAGE_TIMEOUT_MS } from '../shared/managed-limits.js'
import { awaitTicketResult } from './ticket-stage-runner.js'

const handle = { run_id: 'ticket-timeout', harness_id: 'recording' }
const timedOut: RunResult = {
  status: 'TIMEOUT',
  text: null,
  proposals: [],
  session_ref: null,
  usage: { tokens_in: 120, tokens_out: 30, cost_usd: null, cost_basis: 'unavailable' },
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('managed ticket Harness 生命周期', () => {
  it('超时中断实际句柄并等待已上报 usage，再释放计时器', async () => {
    let settle: ((result: Result<RunResult>) => void) | undefined
    const pending = new Promise<Result<RunResult>>((resolve) => {
      settle = resolve
    })
    const adapter = {
      awaitResult: async () => pending,
      interrupt: vi.fn(async () => {
        settle?.(ok(timedOut))
        return ok(undefined)
      }),
    }
    const result = awaitTicketResult(adapter, handle)
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS)
    expect(await result).toEqual(ok(timedOut))
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'timeout')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('中断后仍不响应时，在有界清理等待后返回超时', async () => {
    const adapter = {
      awaitResult: () => new Promise<Result<RunResult>>(() => undefined),
      interrupt: vi.fn(async () => ok(undefined)),
    }
    const result = awaitTicketResult(adapter, handle)
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS + MANAGED_STAGE_CLEANUP_MS)
    expect(await result).toBeNull()
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'timeout')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正常返回时不触发中断，也不留下会在后续阶段触发的计时器', async () => {
    const completed: RunResult = { ...timedOut, status: 'SUCCEEDED', text: '{}' }
    const adapter = {
      awaitResult: async () => ok(completed),
      interrupt: vi.fn(async () => ok(undefined)),
    }
    expect(await awaitTicketResult(adapter, handle)).toEqual(ok(completed))
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS + MANAGED_STAGE_CLEANUP_MS)
    expect(adapter.interrupt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
