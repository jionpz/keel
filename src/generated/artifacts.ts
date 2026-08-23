/**
 * ⚠️ 本文件由 scripts/generate-types.ts 自动生成 —— 请勿手改。
 *
 * 事实来源：docs/schemas/*.schema.json
 * 重新生成：pnpm run generate
 *
 * 手改本文件会立刻产生第二个事实来源，schema 从此不可信。
 * CI 会通过 `pnpm run check:generated` 检测手改（ADR-0002 L2/L4）。
 */

// ── capability-request.schema.json ──
/**
 * Session 请求能力调用的通用机制。Session 不直接调用任何能力，只 emit 本产物由 Control Plane 裁决派发。
 */
export interface ACapabilityRequest {
schema_version: "1.0"
request_id: string
requested_by_run: string
/**
 * v0.1 注册表。新增能力只需扩这里 + 加一条 Policy 规则，无需改 Session 实现。
 */
capability: ("critic_review" | "human_input" | "additional_context")
params?: {

}
rationale: string
/**
 * true = 原 Session 等待结果；false = 可继续推进
 */
blocking: boolean
}

// ── checkpoint.schema.json ──
/**
 * 某个 Session 的可恢复摘要。owner 是 Session 而非 Task。丢失只增加 token 成本，不损失事实。
 */
export interface ACheckpoint {
schema_version: "1.0"
run_id: string
harness_id: string
harness_tier?: ("L0" | "L1" | "L2")
turn_index: number
/**
 * 人类可读进度，如 6/10
 */
progress?: string
current_goal?: string
next_action: string
/**
 * rematerialize 降级路径的主要输入。无 CAP-RESUME 时靠它重建上下文。
 */
working_summary: string
emitted_artifacts?: string[]
unresolved_questions?: string[]
/**
 * L0/L1 降级开关。判别字段为 mode —— 两种模式所需的数据不同，故建模为判别联合而非可空字段。
 */
resume_hint: (ResumeBySessionRef | ResumeByRematerialize)
}
/**
 * Adapter 声明 CAP-RESUME：把句柄交回 Harness，会话上下文由其自行保持。
 */
export interface ResumeBySessionRef {
mode: "session_ref"
session_ref: string
}
/**
 * 无 CAP-RESUME 或句柄已失效：由 ContextBuilder 从 A-State + working_summary 重建，开新会话。
 */
export interface ResumeByRematerialize {
mode: "rematerialize"
/**
 * 重新物化所依据的 artifact 引用
 */
rematerialize_from: string[]
}

// ── critic-review.schema.json ──
/**
 * 结构化评审结果。相对初稿 §8 补齐了量表、评分维度、证据与置信度。
 */
export interface ACriticReview {
schema_version: "1.0"
review_type: ("architecture" | "security" | "quality" | "product" | "feasibility")
request_id: string
/**
 * 被评审对象的 artifact 引用
 */
subject_ref: string
/**
 * 没有量表的分数无法跨 Critic 比较或复现
 */
scale: {
min: number
max: number
higher_is_better: boolean
}
/**
 * @minItems 1
 */
criteria: [string, ...(string)[]]
scores: {
option_id: string
total: number
by_criterion?: {
[k: string]: number
}
}[]
findings?: {
id: string
severity: ("low" | "medium" | "high")
text: string
/**
 * 无证据的 finding 等同于意见，故为必填
 */
evidence: string
}[]
recommendation: string
/**
 * 低置信度的推荐不应触发自动推进；它是 Policy 的输入
 */
confidence: number
/**
 * 多 Critic 时的分歧记录。分歧本身是信号，不应被平均掉。
 */
dissent?: (string | null)
}

// ── event.schema.json ──
/**
 * append-only 事件信封。存于独立 event 表，只增不改。
 */
export interface AEvent {
schema_version: "1.0"
/**
 * 全局单调，排序与重放游标
 */
seq: number
task_id: string
run_id?: (string | null)
type: ("FeedbackReceived" | "TaskCreated" | "TaskStatusChanged" | "ControlModeChanged" | "RunCreated" | "RunStatusChanged" | "ProposalSubmitted" | "ProposalAccepted" | "ProposalRejected" | "ArtifactCommitted" | "PolicyEvaluated" | "CapabilityRequested" | "CapabilityGranted" | "CapabilityDenied" | "SideEffectSkipped" | "BudgetExceeded" | "HumanAction" | "NoTransition" | "SideEffectApplied" | "SideEffectIntent" | "ContextBuilt")
/**
 * 状态转移类事件应在 payload 中记录 transition ID（如 T-012），使事件流可直接对照转移表核验
 */
payload?: {

}
trace_id?: (string | null)
span_id?: (string | null)
occurred_at: string
}

// ── policy-decision.schema.json ──
/**
 * 可重放的裁决记录。facts_snapshot 是完整快照而非引用，这是可重放的前提。
 */
export interface APolicyDecision {
schema_version: "1.0"
/**
 * 在哪个判定点求值，如 rfc_ready
 */
decision_point: string
policy_version: string
evaluated_at: string
/**
 * 求值时输入的完整快照。用引用会随时间变化，快照才能保证同输入同裁决。
 */
facts_snapshot: {

}
/**
 * 数组：多条规则可能同时命中，冲突裁决规则见 policy-engine.md
 */
matched_rules: {
id: string
condition: string
action: string
}[]
decision: string
reason: string
/**
 * true = 无规则命中，走了默认 deny。大量 true 是规则覆盖不足的信号。
 */
default_applied: boolean
}

// ── rfc.schema.json ──
/**
 * PM -> Developer 的核心交接物。进入 S-RFC_READY 后冻结。
 */
export interface ARFC {
schema_version: "1.0"
title: string
problem: string
/**
 * @minItems 1
 */
goals: [string, ...(string)[]]
non_goals: string[]
proposed_change: {
summary: string
affected_areas: string[]
approach: string
}
alternatives_considered?: {
id: string
summary: string
why_not: string
}[]
/**
 * @minItems 1
 */
acceptance_criteria: [{
id: string
text: string
/**
 * 如何验证：集成测试 / 回归测试 / 人工核对
 */
verifiable_by: string
}, ...({
id: string
text: string
/**
 * 如何验证：集成测试 / 回归测试 / 人工核对
 */
verifiable_by: string
})[]]
test_plan?: string[]
rollback_plan?: string
/**
 * Policy Engine 的静态输入。随 RFC 一同冻结，故同一 RFC 版本的裁决结果恒定。
 */
policy_facts: {
risk: ("low" | "medium" | "high")
complexity: ("low" | "medium" | "high")
estimated_files_changed: number
security_related: boolean
}
}

// ── stage-outcome.schema.json ──
/**
 * 某阶段的结构化结论。状态机转移守卫的唯一输入源 —— 守卫必须读枚举，不能解析自由文本。建模为按 stage 判别的联合，使守卫在类型层面就能被收窄。
 */
export type AStageOutcome = (PmOutcome | BrainstormOutcome | RfcDraftOutcome | CriticOutcome | DevelopOutcome | VerificationOutcome)

export interface PmOutcome {
schema_version: "1.0"
run_id: string
stage: "pm"
verdict: ("actionable" | "unclear" | "reject")
reason: string
details?: {
/**
 * 区分 T-003（走 brainstorm）与 T-004（直接起草 RFC）
 */
needs_design?: boolean
}
}
export interface BrainstormOutcome {
schema_version: "1.0"
run_id: string
stage: "brainstorm"
verdict: ("converged" | "needs_more")
reason: string
details?: {

}
}
export interface RfcDraftOutcome {
schema_version: "1.0"
run_id: string
stage: "rfc_draft"
verdict: "drafted"
reason: string
details?: {

}
}
export interface CriticOutcome {
schema_version: "1.0"
run_id: string
stage: "critic"
verdict: "reviewed"
reason: string
details?: {

}
}
export interface DevelopOutcome {
schema_version: "1.0"
run_id: string
stage: "develop"
verdict: ("implemented" | "blocked")
reason: string
details?: {

}
}
/**
 * QA 与 Review 的结论形状相同（pass / fail），故合为一支。
 */
export interface VerificationOutcome {
schema_version: "1.0"
run_id: string
stage: ("qa" | "review")
verdict: ("pass" | "fail")
reason: string
details?: {
failed_criteria?: string[]
report_ref?: string
}
}

// ── state.schema.json ──
/**
 * 某个 Task 的当前事实集合。注意：这不是 task.status（状态机位置）。
 */
export interface AState {
schema_version: "1.0"
current_goal: string
context_summary?: string
confirmed_facts: {
id: string
text: string
/**
 * 溯源：run:<stage>#<attempt> 或 human:<who>
 */
source: string
confidence?: number
}[]
candidate_options?: {
id: string
summary: string
pros?: string[]
cons?: string[]
status: ("open" | "recommended" | "accepted" | "rejected")
}[]
decisions: {
id: string
text: string
rationale: string
decided_at: string
/**
 * run:<stage>#<attempt> 或 human:<who>
 */
decided_by: string
}[]
open_questions: {
id: string
text: string
blocking: boolean
}[]
risks: {
id: string
text: string
severity: ("low" | "medium" | "high")
mitigation?: string
}[]
}
