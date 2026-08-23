/**
 * SessionManager —— 「Session 是计算资源」的落点。
 *
 * 定义处：docs/05-contracts/session-manager.md
 *
 * 本契约最重要的性质是**它没有的东西**：
 * 这里不存在任何让 Session 写入 Fact Plane 的方法。
 * Session 能做的只有 emit 一个 Proposal，由 Control Plane 校验后代为写入。
 *
 * 这不是靠自觉 —— 三层防御：
 *   1. 数据库授权（keel_execution 对 artifact/event/task 无写权限）← 硬
 *   2. Proposal 校验流水线第 3 步（平面越界检查）
 *   3. 契约里根本没有这样的 API
 */

import type { ACheckpoint } from '../generated/artifacts.js'
import type { CapabilityId, RoleId } from '../shared/ids.js'
import type { Result } from './errors.js'
import type { HarnessAdapter } from './harness-adapter.js'
import type { Context, Limits, Proposal, RunRef, Usage, WorkspaceSpec } from './types.js'

export interface SessionHandle {
  readonly session_id: string
  readonly run_id: string
  readonly harness_id: string
}

/** Checkpoint 触发时机。中间两条是必须的，不是可配置的偏好 */
export interface CheckpointPolicy {
  /** 每 N 轮 */
  readonly every_n_turns: number
  /** 发出 blocking 的 CapabilityRequest 前 —— 必须，因为等待期间 Session 可能被回收 */
  readonly before_blocking_request: true
  /** close 前 —— 必须，否则等于把这次会话的推理成果扔掉 */
  readonly before_close: true
  /** 预算达到该比例时（0..1） */
  readonly at_budget_ratio: number
}

export interface SessionSpec {
  readonly run: RunRef
  readonly adapter: HarnessAdapter
  readonly context: Context
  readonly workspace: WorkspaceSpec
  readonly limits: Limits
  readonly checkpoint_policy: CheckpointPolicy
}

export interface TurnInput {
  readonly text: string
  /** R-007 回灌：上一轮 Proposal 被拒的理由 */
  readonly rejected_violations?: readonly string[]
}

export interface TurnOutcome {
  readonly proposals: readonly Proposal[]
  readonly usage: Usage
  /** Session 认为本阶段工作已完成 */
  readonly finished: boolean
  /** 由 A-CapabilityRequest 提案派生 */
  readonly needs: readonly CapabilityId[]
}

export type CloseReason = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'takeover'

export interface CloseReport {
  readonly checkpointed: boolean
  readonly session_ref_retained: boolean
}

export interface SessionManager {
  /**
   * [v0.1 必须] 按 Role 与所需能力挑选 Adapter。
   *
   * 找不到满足**必需**能力的 → CAPABILITY_UNSUPPORTED；
   * 只缺可降级能力 → 正常返回，由调用方按降级矩阵处理。
   *
   * requirements 含 CAP-UNTRUSTED_WORKSPACE 时**不允许降级匹配**。
   */
  selectAdapter(role: RoleId, requirements: readonly CapabilityId[]): Result<HarnessAdapter>

  /** [v0.1 必须] 开会话 */
  open(spec: SessionSpec): Promise<Result<SessionHandle>>

  /** [v0.1 必须] 推进一轮 */
  advance(handle: SessionHandle, input: TurnInput): Promise<Result<TurnOutcome>>

  /** [v0.1 必须] 产出可恢复摘要。它同样以 Proposal 形式提交，走同一条校验流水线 */
  checkpoint(handle: SessionHandle): Promise<Result<ACheckpoint>>

  /**
   * [v0.1 必须] 恢复会话。
   *
   * 由 checkpoint.resume_hint.mode 分派两条路径：
   *   session_ref   → adapter.resume()，会话历史由 Harness 侧保持
   *   rematerialize → adapter.startRun() 开新会话，上下文由 ContextBuilder 重建
   *
   * **失效回退**：session_ref 路径报错（句柄过期、Harness 侧已清理）时，
   * 必须自动回退到 rematerialize 并记一条 Event。
   *
   * 这条自动回退是「Session inside, State outside」真正的价值兑现处：
   * 会话没了不是灾难，因为事实从来就不在会话里。
   */
  restore(checkpoint: ACheckpoint, context: Context): Promise<Result<SessionHandle>>

  /** [v0.1 必须] 关闭。除强杀情形外，close 前必须先 checkpoint */
  close(handle: SessionHandle, reason: CloseReason): Promise<Result<CloseReport>>
}
