/**
 * 转移函数的类型定义。
 *
 * 定义处：docs/04-state-machine.md
 *
 * 本目录受 ADR-0003 的纯函数约束管辖，由两处强制：
 *   - .dependency-cruiser.cjs 的 transition-must-be-pure（import 层面）
 *   - scripts/check-purity.ts（全局层面：Date.now / Math.random / process）
 */

import type { ControlMode, Stage, TaskStatus, TransitionId } from '../../shared/ids.js'

// ─────────────────────────────── 事件 ───────────────────────────────

export type TransitionEvent =
  | { readonly type: 'FeedbackTriaged' }
  | { readonly type: 'Dispatch' }
  | { readonly type: 'RunSucceeded'; readonly stage: Stage }
  | { readonly type: 'RunFailed'; readonly stage: Stage }
  | { readonly type: 'RunTimeout'; readonly stage: Stage }
  | { readonly type: 'ClarificationReceived' }
  | { readonly type: 'TimerFired'; readonly timer: 'clarification_ttl' }
  | { readonly type: 'CapabilityRequested'; readonly capability: string }
  | { readonly type: 'ArtifactCommitted'; readonly kind: string }
  | { readonly type: 'PolicyEvaluated'; readonly decision: string }
  | { readonly type: 'HumanApproved' }
  | { readonly type: 'HumanRejected' }
  | { readonly type: 'HumanRequestedRework' }
  | { readonly type: 'CIPassed' }
  | { readonly type: 'CIFailed' }
  | { readonly type: 'PRClosed' }
  | { readonly type: 'Cancelled' }
  | { readonly type: 'UnrecoverableError' }

export type TransitionEventType = TransitionEvent['type']

// ─────────────────────────────── Facts ───────────────────────────────

/**
 * guard 的输入。
 *
 * 全部来自 Fact Plane —— 这是转移可重放的前提。
 * 若这里混入实时查询外部系统的结果，同一次重放就会得到不同结论。
 */
export interface TransitionFacts {
  /** A-StageOutcome 的 verdict。守卫读的是枚举，不是自由文本 */
  readonly verdict: string | null
  /** pm 阶段的 details.needs_design，区分 T-003 与 T-004 */
  readonly needs_design: boolean
  /** 已用的 develop 尝试次数 */
  readonly dev_attempts: number
  readonly max_dev_attempts: number
  /** 当前阶段已用的尝试次数（T-030 / T-031 用） */
  readonly stage_attempts: number
  readonly max_stage_attempts: number
  /** capability_request 判定点的 Policy 结论 */
  readonly capability_allowed: boolean
}

// ─────────────────────────────── 副作用 ───────────────────────────────

/**
 * 副作用只作为**返回值中的描述**，不在转移函数内执行（ADR-0003 硬约束）。
 * 由外层执行器实施，并负责幂等（docs/04-state-machine.md §5.2）。
 */
export type SideEffect =
  | { readonly kind: 'CreateTask' }
  | { readonly kind: 'LinkFeedback' }
  | {
      readonly kind: 'CreateRun'
      /** 'SAME' = 当前阶段（通用重试规则 T-030 用），由外层执行器从 Run 上下文解析 */
      readonly stage: Stage | 'SAME'
      readonly attempt: 'first' | 'next'
    }
  | { readonly kind: 'FreezeRfc' }
  | { readonly kind: 'EvaluatePolicy'; readonly point: string }
  /** 幂等：分支名由 task_id 决定，非随机 */
  | { readonly kind: 'CreateBranch' }
  /** 幂等：先按 head 分支查已有 PR */
  | { readonly kind: 'CreatePullRequest' }
  | { readonly kind: 'NotifyHuman'; readonly reason: string }
  | { readonly kind: 'AskUser' }
  | { readonly kind: 'StartTimer'; readonly timer: string }
  | { readonly kind: 'CancelRun' }
  | { readonly kind: 'CleanWorkspace' }
  /** S-FAILED 刻意保留现场供诊断 */
  | { readonly kind: 'PreserveWorkspace' }
  | { readonly kind: 'RecordReason' }
  | { readonly kind: 'MaybeAutoMerge' }

// ─────────────────────────────── 规则 ───────────────────────────────

/** from 的特殊取值：null = ∅（初态创建） */
export type TransitionFrom = TaskStatus | 'ANY_STAGE' | 'ANY_NON_TERMINAL' | null
/** to 的特殊取值：SELF = 自环（同状态） */
export type TransitionTo = TaskStatus | 'SELF'

export interface TransitionRule {
  readonly id: TransitionId
  readonly from: TransitionFrom
  readonly on: readonly TransitionEventType[]
  /** null = 无 guard（文档中的「—」） */
  readonly guard: ((facts: TransitionFacts, event: TransitionEvent) => boolean) | null
  /** guard 的文字形式，与文档对照用 */
  readonly guardText: string
  readonly to: TransitionTo
  readonly effects: readonly SideEffect[]
  /** 是否无视 control_mode。仅 T-040 / T-041 —— 取消与不可恢复错误无论谁在驾驶都生效 */
  readonly ignoresControlMode: boolean
}

// ─────────────────────────────── 结果 ───────────────────────────────

export type TransitionResult =
  | {
      readonly matched: true
      readonly id: TransitionId
      readonly from: TaskStatus
      readonly next_status: TaskStatus
      readonly effects: readonly SideEffect[]
    }
  | {
      readonly matched: false
      readonly reason: 'no_rule' | 'control_mode_not_auto' | 'guard_failed'
      readonly detail: string
    }

export type { ControlMode, TaskStatus, TransitionId }
