import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type { HarnessAdapter, RunResult } from '../contracts/harness-adapter.js'
import { fixtureTicketPackage } from '../control/managed/ticket-test-utils.js'
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
    const result = await ticketWorkerFromAdapter(adapter).decide({
      attempt_id: 'a',
      task_id: 't',
      repo_id: 'r',
      workspace_path: '/tmp/workspace',
      context: emptyContext,
    })
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
    const pkg = fixtureTicketPackage()
    const definition = pkg.stages[0]
    if (definition === undefined) throw new Error('fixture 缺 execute 阶段')
    const onProgress = vi.fn()
    await ticketWorkerFromAdapter(adapter).run({
      attempt_id: 'a',
      task_id: 't',
      repo_id: 'r',
      stage: 'execute',
      context: emptyContext,
      workspace_path: '/tmp/workspace',
      package: pkg,
      stage_definition: definition,
      tool_plan: {
        harness: 'pi',
        stage: 'execute',
        role: 'developer',
        profile: 'developer',
        native_tools: ['read'],
        degradations: [],
        missing_optional: [],
      },
      baseline_commit: 'a'.repeat(40),
      input_commit: 'a'.repeat(40),
      rework_notes: [],
      human_decisions: [],
      onProgress,
    })
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

const emptyContext = {
  context_id: 'fixture',
  recipe_id: 'fixture',
  recipe_version: '1.0',
  sections: [],
  total_tokens: 0,
  dropped: [],
}

function recordingAdapter(result: RunResult) {
  return {
    describe: () => ({
      harness_id: 'pi',
      version: 'fixture',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }),
    startRun: vi.fn(async () => ok(handle)),
    awaitResult: async () => ok(result),
    interrupt: async () => ok(undefined),
    collectChanges: async () => ok({ files_changed: [], patch: '', commits: [], is_dirty: false }),
    dispose: vi.fn(async () => ok({ session_ref_retained: false, workspace_cleaned: true })),
  } satisfies HarnessAdapter
}
