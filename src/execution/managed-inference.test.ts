/**
 * managedInference 的协议夹具测试。
 * RecordingAdapter 只验证 HarnessAdapter 接缝，不连接模型，也不代表真实模型验收。
 */
import { describe, expect, it, vi } from 'vitest'
import { makeError, ok, type Result } from '../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  InterruptReason,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../contracts/harness-adapter.js'
import type { ManagedInferenceInput } from '../contracts/managed.js'
import type { Context, Usage } from '../contracts/types.js'
import { managedInference } from './managed-inference.js'

const NONZERO_USAGE: Usage = {
  tokens_in: 123,
  tokens_out: 45,
  cost_usd: 0.0123,
  cost_basis: 'estimated',
}

function contextFixture(): Context {
  return {
    context_id: 'context-1',
    recipe_id: 'managed/investigate',
    recipe_version: '1',
    sections: [
      {
        id: 'role',
        content: '角色指令',
        source_ref: 'fixed:role',
        source_kind: 'fixed',
        priority: 'required',
        tokens: 3,
      },
      {
        id: 'workflow',
        content: '流程包指令',
        source_ref: 'managed-package:abc',
        source_kind: 'artifact',
        priority: 'required',
        tokens: 5,
      },
      {
        id: 'facts',
        content: '已观察事实',
        source_ref: 'managed-task:task-1',
        source_kind: 'artifact',
        priority: 'required',
        tokens: 4,
      },
    ],
    total_tokens: 12,
    dropped: [],
  }
}

function inputFixture(phase: ManagedInferenceInput['phase']): ManagedInferenceInput {
  return {
    attempt_id: 'attempt-1',
    task_id: 'task-1',
    repo_id: 'repo-1',
    phase,
    context: contextFixture(),
    workspace_path: '/fixture/project',
  }
}

/** 内存协议夹具：只记录 RunSpec、返回预设的 harness 结果。 */
class RecordingAdapter implements HarnessAdapter {
  readonly specs: RunSpec[] = []
  readonly interruptReasons: InterruptReason[] = []
  disposed = false
  private resolvePending!: (result: Result<RunResult>) => void
  private readonly pending = new Promise<Result<RunResult>>((resolve) => {
    this.resolvePending = resolve
  })

  constructor(
    private readonly runResult: RunResult = {
      status: 'SUCCEEDED',
      text: '{"outcome":"completed"}',
      proposals: [],
      usage: NONZERO_USAGE,
      session_ref: null,
    },
    private readonly returnPending = false,
  ) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: 'recording-protocol-fixture',
      version: 'fixture',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'estimated',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.specs.push(spec)
    return ok({ run_id: spec.run.run_id, harness_id: 'recording-protocol-fixture' })
  }

  async awaitResult(_handle: RunHandle): Promise<Result<RunResult>> {
    return this.returnPending ? this.pending : ok(this.runResult)
  }

  async collectChanges(_handle: RunHandle): Promise<Result<WorkspaceDiff>> {
    throw new Error('协议测试不调用 collectChanges')
  }

  async interrupt(_handle: RunHandle, reason: InterruptReason): Promise<Result<void>> {
    this.interruptReasons.push(reason)
    if (reason === 'timeout') {
      this.resolvePending(
        ok({
          status: 'TIMEOUT',
          text: null,
          proposals: [],
          usage: NONZERO_USAGE,
          session_ref: null,
        }),
      )
    }
    return ok(undefined)
  }

  async dispose(_handle: RunHandle): Promise<Result<DisposeReport>> {
    this.disposed = true
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}

describe('managedInference · 协议夹具', () => {
  it('为天问和调查执行者传递只读权限、隔离工作区与完整上下文', async () => {
    for (const [phase, role, stage] of [
      ['tianwen', 'Tianwen', 'tianwen'],
      ['investigate', 'Investigator', 'managed_investigate'],
    ] as const) {
      const adapter = new RecordingAdapter()
      const result = await managedInference(adapter)(inputFixture(phase))
      expect(result.ok).toBe(true)
      expect(adapter.specs).toHaveLength(1)
      const spec = adapter.specs[0]
      expect(spec).toBeDefined()
      if (spec === undefined) throw new Error('RecordingAdapter 未收到 RunSpec')
      expect(spec.permissions.allowed_tools).toEqual([])
      expect(spec.permissions.mode).toBe('deny_unlisted')
      expect(spec.workspace.untrusted).toBe(true)
      expect(spec.workspace.repo_id).toBe('repo-1')
      expect(spec.run.role).toBe(role)
      expect(spec.run.stage).toBe(stage)
      expect(spec.context.sections).toEqual(contextFixture().sections)
      expect(spec.context).toEqual(contextFixture())
      expect(adapter.disposed).toBe(true)
    }
  })

  it('成功结果保留 Harness 上报的非零 usage', async () => {
    const adapter = new RecordingAdapter()
    const result = await managedInference(adapter)(inputFixture('investigate'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.usage).toEqual(NONZERO_USAGE)
    expect(adapter.specs[0]?.limits.wall_clock_s).toBe(90)
  })

  it('90 秒 watchdog 中断 Harness，并在 TIMEOUT 失败中保留已见 usage', async () => {
    vi.useFakeTimers()
    const adapter = new RecordingAdapter(undefined, true)
    try {
      const pending = managedInference(adapter)(inputFixture('tianwen'))
      await vi.advanceTimersByTimeAsync(90_000)
      const result = await pending
      expect(adapter.interruptReasons).toEqual(['timeout'])
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toEqual(makeError('RUN_TIMEOUT', 'managed inference failed'))
      expect(result.usage).toEqual(NONZERO_USAGE)
      expect(adapter.disposed).toBe(true)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
