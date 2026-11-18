import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type { HarnessAdapter, RunResult } from '../contracts/harness-adapter.js'
import { fixtureRoutePackage } from '../control/managed/route-test-utils.js'
import { fixtureStageInput as stageInput } from '../control/managed/ticket-test-utils.js'
import { MANAGED_STAGE_CLEANUP_MS, MANAGED_STAGE_TIMEOUT_MS } from '../shared/managed-limits.js'
import { awaitTicketResult, ticketWorkerFromAdapter } from './ticket-stage-runner.js'

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
  it.each([
    { status: 'SUCCEEDED' as const, text: '{"recommendation":"escalate"}', kind: null },
    { status: 'SUCCEEDED' as const, text: 'invalid', kind: 'PROTOCOL_ERROR' },
    { status: 'TIMEOUT' as const, text: null, kind: 'RUN_TIMEOUT' },
    { status: 'FAILED' as const, text: null, kind: 'PROTOCOL_ERROR' },
  ])('$status / $text 保留 usage 并释放真实句柄', async ({ status, text, kind }) => {
    const adapter = recordingAdapter({ ...timedOut, status, text })
    const result = await ticketWorkerFromAdapter(adapter).decide(decisionInput)
    expect(adapter.dispose).toHaveBeenCalledExactlyOnceWith(handle)
    if (kind === null) {
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.usage).toEqual(timedOut.usage)
    } else {
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.kind).toBe(kind)
        expect(result.usage).toEqual(timedOut.usage)
      }
    }
  })

  it('阶段执行传递进展钩子，同时保留工具白名单', async () => {
    const adapter = recordingAdapter({ ...timedOut, status: 'SUCCEEDED', text: '{}' })
    const onProgress = vi.fn()
    await ticketWorkerFromAdapter(adapter).run({ ...stageInput('execute'), onProgress })
    expect(adapter.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { allowed_tools: ['read'], mode: 'deny_unlisted' },
      }),
      { onProgress },
    )
  })
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
    const result = awaitTicketResult(adapter, handle, MANAGED_STAGE_TIMEOUT_MS)
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
    const result = awaitTicketResult(adapter, handle, MANAGED_STAGE_TIMEOUT_MS)
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS + MANAGED_STAGE_CLEANUP_MS)
    expect(await result).toBeNull()
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'timeout')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('控制层撤回时中断同一实际句柄，等待回收后释放计时器', async () => {
    let settle: ((result: Result<RunResult>) => void) | undefined
    const controller = new AbortController()
    const pending = new Promise<Result<RunResult>>((resolve) => {
      settle = resolve
    })
    const cancelled: RunResult = { ...timedOut, status: 'CANCELLED' }
    const adapter = {
      awaitResult: () => pending,
      interrupt: vi.fn(async () => {
        settle?.(ok(cancelled))
        return ok(undefined)
      }),
    }
    const result = awaitTicketResult(adapter, handle, MANAGED_STAGE_TIMEOUT_MS, controller.signal)
    controller.abort()
    expect(await result).toEqual(ok(cancelled))
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'cancelled')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('正常返回时不触发中断，也不留下会在后续阶段触发的计时器', async () => {
    const completed: RunResult = { ...timedOut, status: 'SUCCEEDED', text: '{}' }
    const adapter = {
      awaitResult: async () => ok(completed),
      interrupt: vi.fn(async () => ok(undefined)),
    }
    expect(await awaitTicketResult(adapter, handle, MANAGED_STAGE_TIMEOUT_MS)).toEqual(
      ok(completed),
    )
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS + MANAGED_STAGE_CLEANUP_MS)
    expect(adapter.interrupt).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('managed 阶段墙钟上限', () => {
  it('未提供阶段上限时，阶段、路线规划与天问都用缺省上限', async () => {
    const adapter = recordingAdapter({ ...timedOut, status: 'SUCCEEDED', text: '{}' }, PLAN_TOOLS)
    const worker = ticketWorkerFromAdapter(adapter)
    await worker.run(stageInput('execute'))
    await worker.plan(planInput())
    await worker.decide(decisionInput)
    expect(wallClocks(adapter)).toEqual([900, 900, 900])
  })

  it('阶段上限同时决定交给 Harness 的 wall_clock_s 与本进程的中断时刻', async () => {
    const adapter = hangingAdapter()
    const worker = ticketWorkerFromAdapter(adapter, (stage) =>
      stage === 'execute' ? 2 * MANAGED_STAGE_TIMEOUT_MS : MANAGED_STAGE_TIMEOUT_MS,
    )
    const result = worker.run(stageInput('execute'))
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS)
    expect(adapter.interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(MANAGED_STAGE_TIMEOUT_MS)
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'timeout')
    const settled = await result
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error.kind).toBe('RUN_TIMEOUT')
    expect(wallClocks(adapter)).toEqual([1800])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('上限短于缺省值时按配置提前中断，不取两者的较大值', async () => {
    const adapter = hangingAdapter()
    const result = ticketWorkerFromAdapter(adapter, () => 60_000).run(stageInput('verify'))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(adapter.interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(adapter.interrupt).toHaveBeenCalledExactlyOnceWith(handle, 'timeout')
    expect((await result).ok).toBe(false)
    expect(wallClocks(adapter)).toEqual([60])
  })

  it('每个阶段按自己的键取上限；天问不受阶段上限影响', async () => {
    const adapter = recordingAdapter({ ...timedOut, status: 'SUCCEEDED', text: '{}' }, PLAN_TOOLS)
    const seconds = { plan: 1200, execute: 1800, verify: 2400, review: 600, land: 300 }
    const worker = ticketWorkerFromAdapter(adapter, (stage) => seconds[stage] * 1000)
    for (const stage of ['execute', 'verify', 'review', 'land'] as const) {
      await worker.run(stageInput(stage))
    }
    await worker.plan(planInput())
    await worker.decide(decisionInput)
    expect(wallClocks(adapter)).toEqual([1800, 2400, 600, 300, 1200, 900])
  })
})

const PLAN_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'Agent']

const emptyContext = {
  context_id: 'fixture',
  recipe_id: 'fixture',
  recipe_version: '1.0',
  sections: [],
  total_tokens: 0,
  dropped: [],
}

const decisionInput = {
  attempt_id: 'a',
  task_id: 't',
  repo_id: 'r',
  workspace_path: '/tmp/workspace',
  context: emptyContext,
}

function planInput() {
  return {
    attempt_id: 'a',
    workflow_id: 'w',
    repo_id: 'r',
    request: 'fixture',
    context: emptyContext,
    workspace_path: '/tmp/workspace',
    scope_paths: ['src'],
    package: fixtureRoutePackage(),
  }
}

/** 每次 startRun 交给 Harness 的墙钟上限（秒），按调用顺序。 */
function wallClocks(adapter: { startRun: { mock: { calls: readonly unknown[][] } } }): number[] {
  return adapter.startRun.mock.calls.map(
    (call) => (call[0] as { limits: { wall_clock_s: number } }).limits.wall_clock_s,
  )
}

/** awaitResult 一直不返回，直到被中断才以 TIMEOUT 收敛。 */
function hangingAdapter() {
  let settle: ((result: Result<RunResult>) => void) | undefined
  const pending = new Promise<Result<RunResult>>((resolve) => {
    settle = resolve
  })
  return {
    ...recordingAdapter(timedOut),
    awaitResult: () => pending,
    interrupt: vi.fn(async () => {
      settle?.(ok(timedOut))
      return ok(undefined)
    }),
  } satisfies HarnessAdapter
}

function recordingAdapter(result: RunResult, toolInventory: readonly string[] = []) {
  return {
    describe: () => ({
      harness_id: 'pi',
      version: 'fixture',
      tier: 'L0',
      capabilities: [],
      tool_inventory: toolInventory,
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }),
    startRun: vi.fn(async (..._args: Parameters<HarnessAdapter['startRun']>) => ok(handle)),
    awaitResult: async () => ok(result),
    interrupt: async () => ok(undefined),
    collectChanges: async () => ok({ files_changed: [], patch: '', commits: [], is_dirty: false }),
    dispose: vi.fn(async () => ok({ session_ref_retained: false, workspace_cleaned: true })),
  } satisfies HarnessAdapter
}
