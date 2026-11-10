/**
 * HarnessAdapter —— 「Harness 是执行层，可替换」这一主张的唯一落点。
 *
 * 定义处：docs/05-contracts/harness-adapter.md
 *
 * 核心设计：**分级 + 显式降级**。
 * 一个扁平接口套所有 Harness 是假的 —— 各家能力并不齐整，
 * 要么退化到最弱者，要么假装弱者有强者的能力。
 *
 * 关键主张：能力缺失只让闭环**更贵**，不让它**失效** ——
 * 因为事实本来就不在会话里，而在 Fact Plane。
 * 唯一没有降级路径的是 CAP-UNTRUSTED_WORKSPACE（见 startRun 的契约要求）。
 *
 * 本文件只声明标注 [v0.1 必须] 的方法。
 * [可延后] 的以注释保留位置 —— 声明了就会有人去实现它。
 */

import type { ACheckpoint } from '../generated/artifacts.js'
import type { CapabilityId, HarnessTier } from '../shared/ids.js'
import type { Result } from './errors.js'
import type { Context, Limits, Proposal, RunRef, Usage, WorkspaceSpec } from './types.js'

/** 不透明句柄，由 Adapter 实现自行定义内部结构 */
export interface RunHandle {
  readonly run_id: string
  readonly harness_id: string
}

export interface HarnessDescriptor {
  readonly harness_id: string
  readonly version: string
  readonly tier: HarnessTier
  readonly capabilities: readonly CapabilityId[]
  readonly tool_inventory?: readonly string[]
  readonly cost_basis: Usage['cost_basis']
  readonly limits: {
    readonly max_input_bytes: number | null
    readonly max_wall_clock_s: number | null
  }
}

export type OutputContractMode = 'native' | 'post_validate'
export type PermissionMode = 'manual' | 'auto' | 'accept_edits' | 'deny_unlisted'

export interface RunSpec {
  readonly run: RunRef
  /** 派生自 (task_id, stage, attempt)。相同 key 的重复调用不得启动第二个进程 */
  readonly idempotency_key: string
  readonly workspace: WorkspaceSpec
  readonly context: Context
  readonly output_contract: {
    readonly schema_ref: string
    /** native 需 CAP-STRUCTURED_OUTPUT；否则调用方应改用 post_validate */
    readonly mode: OutputContractMode
  }
  readonly permissions: {
    readonly allowed_tools: readonly string[]
    readonly mode: PermissionMode
  }
  readonly limits: Limits
  /**
   * 本次 run 请求的模型（最终值）。
   *
   * omp 用它替换 adapter 构造时的缺省；claude 忽略它（模型来自构造参数，
   * 未显式指定就不传 `--model`）。编排器把同一个值写进 `run.requested_model`,
   * 所以落库值与实际 spawn 的 `--model` 必须同源 —— 不允许调用方各算一次。
   */
  readonly model?: string
}

export interface RunResult {
  /**
   * 运行终态四选一(R9,issue #23):
   * - SUCCEEDED  正常完成,text 应有值
   * - FAILED     运行开始后已终止,但非超时、非主动取消 ——
   *   不带细分类(输出不可解析 / 内部错误 / 业务失败都归此);
   *   调用方按「可重试失败」处理
   * - TIMEOUT    超过 limits.wall_clock_s 强制终止
   * - CANCELLED  收到 interrupt(人工撤回 / 预算熔断)后终止 —— 不可重试
   */
  readonly status: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED'
  /**
   * Harness 产出的原始文本。
   *
   * `post_validate` 模式下**必须非空** —— 调用方要从中提取结构化提案。
   * 无 CAP-STRUCTURED_OUTPUT 的 Harness 只能走这条路，
   * 若 Adapter 不带出文本，降级路径就断了。
   */
  readonly text: string | null
  readonly proposals: readonly Proposal[]
  readonly usage: Usage
  /** 仅 CAP-RESUME 时非空 */
  readonly session_ref: string | null
}

export interface FileChange {
  readonly path: string
  readonly change: 'added' | 'modified' | 'deleted'
}

/**
 * 各 Harness 交付结果的方式不同：有的自动 commit，有的留脏工作树。
 * Adapter 的职责是把这种差异吸收掉，向上统一成本类型。
 */
export interface WorkspaceDiff {
  readonly files_changed: readonly FileChange[]
  readonly patch: string | null
  /** Harness 自行提交的 commit SHA */
  readonly commits: readonly string[]
  readonly is_dirty: boolean
}

export type InterruptReason = 'cancelled' | 'budget' | 'takeover' | 'timeout' | 'stalled'

/**
 * 执行层进展遥测 —— **只用于 liveness，不是 Fact**。
 *
 * `kind` 由 adapter 定义（OMP 用 `--mode=json` 的事件类型）；控制面只记录，
 * 不据此判定业务含义，也不把事件重放建立在这些数据上。
 */
export interface ProgressEvent {
  readonly kind: string
  /**
   * 单调时钟读数（毫秒），控制面注入。用于「多久没有新进展」，
   * 不受系统墙钟跳变影响；持久化时间戳另用注入的 `now`。
   */
  readonly at: number
  readonly sessionRef?: string
  /** 首个事件携带；用于孤儿进程清理 */
  readonly pid?: number
  readonly pgid?: number
  /** 进程启动时间（ISO），与 pid 一起防 PID 复用误杀 */
  readonly startedAt?: string
}

/** 执行层钩子：不属于可序列化的 RunSpec，只随调用传递 */
export interface RunHooks {
  readonly onProgress?: (event: ProgressEvent) => void
}

export interface DisposeReport {
  /**
   * 句柄是否仍可用于后续 resume。
   * dispose 销毁的是进程与本地资源，不必然使 session_ref 失效 ——
   * 对会话由 Harness 侧持久化的实现（如 Claude Code），dispose 之后仍可 --resume。
   */
  readonly session_ref_retained: boolean
  readonly workspace_cleaned: boolean
}

export interface HarnessAdapter {
  /** [v0.1 必须] 静态身份与能力声明 */
  describe(): HarnessDescriptor

  /**
   * [v0.1 必须] 启动一次执行。
   *
   * 契约要求：
   * - workspace.untrusted = true 而未声明 CAP-UNTRUSTED_WORKSPACE
   *   → 必须返回 CAPABILITY_UNSUPPORTED，**不得降级执行**
   * - output_contract.mode = 'native' 而无 CAP-STRUCTURED_OUTPUT
   *   → 返回 CAPABILITY_UNSUPPORTED
   * - 相同 idempotency_key 的重复调用 → 返回已有句柄，不得启动第二个进程
   */
  startRun(spec: RunSpec, hooks?: RunHooks): Promise<Result<RunHandle>>

  /** [v0.1 必须] 等待执行结束 */
  awaitResult(handle: RunHandle): Promise<Result<RunResult>>

  /** [v0.1 必须] 收集工作区变更，吸收各 Harness 的交付方式差异 */
  collectChanges(handle: RunHandle): Promise<Result<WorkspaceDiff>>

  /** [v0.1 必须] 中断。无 CAP-INTERRUPT 时降级为强杀进程 —— 该次 Run 作废（R-010） */
  interrupt(handle: RunHandle, reason: InterruptReason): Promise<Result<void>>

  /** [v0.1 必须] 销毁进程与本地资源 */
  dispose(handle: RunHandle): Promise<Result<DisposeReport>>

  // ── [可延后] 以下方法仅在对应 capability 下需要，v0.1 不声明 ──
  //
  // resume(checkpoint: ACheckpoint, context: Context): Promise<Result<RunHandle>>
  //     需 CAP-RESUME。前置条件 checkpoint.resume_hint.mode === 'session_ref'。
  //     不满足时调用方必须改走 rematerialize 路径。
  //
  // observe(handle: RunHandle): AsyncIterator<HarnessEvent>
  //     需 CAP-STREAM。无它则预算只能在 Run 结束后核算 ——
  //     意味着熔断触发时超支已经发生。这是能力缺失的真实代价。
}

/** 仅为上方注释中的签名保留引用，避免 ACheckpoint 未使用告警 */
export type ResumeCheckpoint = ACheckpoint
