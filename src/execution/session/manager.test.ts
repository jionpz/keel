/**
 * SessionManager.advance 的错误映射 —— #1-03。
 *
 * 非 SUCCEEDED 的 Run 必须按 status 映射 ErrorKind:
 *   CANCELLED → RUN_CANCELLED(retryable=false,人工撤回不重试)
 *   TIMEOUT   → RUN_TIMEOUT
 *   FAILED    → PROTOCOL_ERROR
 * 不能一律打成 PROTOCOL_ERROR —— 否则人工撤回会被 T-030 白白重试。
 *
 * 纯单测:fake adapter,不连 DB。
 */

import { describe, expect, it } from 'vitest'
import type { Result } from '../../contracts/errors.js'
import type {
  HarnessAdapter,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import { HarnessSessionManager } from './manager.js'

/** fake adapter:awaitResult 恒返指定 status */
function adapterWithStatus(status: RunResult['status']): HarnessAdapter {
  return {
    describe: () => ({
      harness_id: 'fake',
      tier: 'L0',
      capabilities: [],
      version: 'test',
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }),
    startRun: async (spec: RunSpec) => ({
      ok: true,
      value: { run_id: spec.run.run_id, harness_id: 'fake' },
    }),
    awaitResult: async (_h: RunHandle): Promise<{ ok: true; value: RunResult }> => ({
      ok: true,
      value: {
        status,
        text: null,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      },
    }),
    collectChanges: async () => ({
      ok: true,
      value: { files_changed: [], patch: null, commits: [], is_dirty: false },
    }),
    interrupt: async () => ({ ok: true, value: undefined }),
    dispose: async () => ({
      ok: true,
      value: { session_ref_retained: false, workspace_cleaned: false },
    }),
  }
}

const spec: {
  runSpec: RunSpec
  adapter: HarnessAdapter
  expect: { kind: 'stage_outcome'; key: 'pm' }
} = {
  runSpec: {
    run: { run_id: 'r1', task_id: 't1', stage: 'pm', role: 'PM', attempt: 1 },
    idempotency_key: 't1/pm/1',
    workspace: { path: '/tmp', repo_id: 'r', branch: 'main', untrusted: true },
    context: {
      context_id: 'c',
      recipe_id: 'pm',
      recipe_version: '1',
      sections: [],
      total_tokens: 0,
      dropped: [],
    },
    output_contract: { schema_ref: 'stage_outcome', mode: 'post_validate' },
    permissions: { allowed_tools: [], mode: 'manual' },
    limits: { wall_clock_s: 60, budget_usd: null, max_turns: 4 },
  },
  adapter: adapterWithStatus('SUCCEEDED'),
  expect: { kind: 'stage_outcome', key: 'pm' },
}

async function advanceWith(status: RunResult['status']) {
  const sessions = new HarnessSessionManager()
  const handle = await sessions.open({ ...spec, adapter: adapterWithStatus(status) })
  if (!handle.ok) throw new Error('open 失败')
  return sessions.advance(handle.value, { text: 'x' })
}

describe('advance · 非 SUCCEEDED 的 ErrorKind 映射', () => {
  it('CANCELLED → RUN_CANCELLED,retryable=false(人工撤回不重试)', async () => {
    const r = await advanceWith('CANCELLED')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('RUN_CANCELLED')
    expect(r.error.retryable).toBe(false)
  })

  it('TIMEOUT → RUN_TIMEOUT(可重试)', async () => {
    const r = await advanceWith('TIMEOUT')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('RUN_TIMEOUT')
    expect(r.error.retryable).toBe(true)
  })

  it('FAILED → PROTOCOL_ERROR', async () => {
    const r = await advanceWith('FAILED')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('PROTOCOL_ERROR')
  })
})

// ───────────────── 采集工作区改动（Run 到底改了什么的唯一来源） ─────────────────

const ONE_FILE: WorkspaceDiff = {
  files_changed: [{ path: 'README.md', change: 'modified' }],
  patch: 'diff --git a/README.md b/README.md\n+hello\n',
  commits: [],
  is_dirty: true,
}

/** 记录调用顺序的 fake —— 断言「采集发生在 dispose 之前」靠它 */
function recordingAdapter(
  calls: string[],
  opts: { diff?: () => Promise<Result<WorkspaceDiff>>; status?: RunResult['status'] } = {},
): HarnessAdapter {
  return {
    ...adapterWithStatus(opts.status ?? 'SUCCEEDED'),
    collectChanges: async () => {
      calls.push('collectChanges')
      return opts.diff === undefined ? { ok: true, value: ONE_FILE } : opts.diff()
    },
    dispose: async () => {
      calls.push('dispose')
      return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } }
    },
  }
}

describe('advance · 采集工作区改动', () => {
  it('成功轮次带回 diff，且采集发生在 dispose 之前', async () => {
    const calls: string[] = []
    const sessions = new HarnessSessionManager()
    const opened = await sessions.open({ ...spec, adapter: recordingAdapter(calls) })
    if (!opened.ok) throw new Error('open 失败')

    const turn = await sessions.advance(opened.value, { text: 'x' })
    expect(turn.ok, turn.ok ? '' : turn.error.detail).toBe(true)
    if (!turn.ok) return
    expect(turn.value.diff?.files_changed.map((f) => f.path)).toEqual(['README.md'])

    // dispose 会删掉 adapter 内的 state —— 采集晚于它只能拿到 NOT_FOUND
    await sessions.close(opened.value)
    expect(calls).toEqual(['collectChanges', 'dispose'])
  })

  it('采集失败不升级为 Run 失败：diff 为 null', async () => {
    const calls: string[] = []
    const sessions = new HarnessSessionManager()
    const opened = await sessions.open({
      ...spec,
      adapter: recordingAdapter(calls, {
        diff: async () => ({
          ok: false,
          error: { kind: 'WORKSPACE_ERROR', detail: 'git 炸了', retryable: true },
        }),
      }),
    })
    if (!opened.ok) throw new Error('open 失败')

    const turn = await sessions.advance(opened.value, { text: 'x' })
    expect(turn.ok, '采集失败不阻断这一轮').toBe(true)
    if (!turn.ok) return
    expect(turn.value.diff).toBeNull()
  })

  it('非 SUCCEEDED 的轮次不采集（那条路本来就要失败）', async () => {
    const calls: string[] = []
    const sessions = new HarnessSessionManager()
    const opened = await sessions.open({
      ...spec,
      adapter: recordingAdapter(calls, { status: 'TIMEOUT' }),
    })
    if (!opened.ok) throw new Error('open 失败')

    const turn = await sessions.advance(opened.value, { text: 'x' })
    expect(turn.ok).toBe(false)
    expect(calls).toEqual([])
  })
})
