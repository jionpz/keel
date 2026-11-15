/** JT-01：与旧 Artifact/Task 状态机分离的只读调查协议。 */

import type {
  JstackRoutePackage,
  JstackRoutePlan,
  JstackTicketPackage,
  ManagedActionIntent,
  ManagedTicketStageResult,
  TianwenDecision,
} from '../generated/managed.js'
import type { ResultWithUsage } from './errors.js'
import type { RunHooks } from './harness-adapter.js'
import type { Context, Usage } from './types.js'

export interface ManagedObservation {
  readonly path: string
  readonly digest: string
  readonly content: string
}

export interface ManagedAnswer {
  readonly question: string
  readonly answer: string
  readonly actor: 'human'
}

export type ManagedStatus =
  | 'READY'
  | 'RUNNING'
  | 'WAITING_TIANWEN'
  | 'WAITING_HUMAN'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'
export type ManagedPhase = 'investigate' | 'tianwen'

export interface ManagedTask {
  readonly id: string
  readonly repo_id: string
  readonly package_digest: string
  readonly workspace_path: string
  readonly question: string
  readonly file_index: readonly string[]
  readonly observations: readonly ManagedObservation[]
  readonly answers: readonly ManagedAnswer[]
  readonly status: ManagedStatus
  readonly phase: ManagedPhase
  readonly pending_question_id: string | null
  readonly lease_token: string | null
  readonly attempts: number
  readonly max_attempts: number
  readonly failures: number
  readonly report: unknown
  readonly error: string | null
}

export interface ManagedQuestion {
  readonly id: string
  readonly task_id: string
  readonly question: string
  readonly options: readonly string[]
  readonly status: 'OPEN' | 'WAITING_HUMAN' | 'RESOLVED'
  readonly suggestion: unknown
  readonly answer: string | null
}

export interface ManagedInferenceInput {
  readonly attempt_id: string
  readonly task_id: string
  readonly repo_id: string
  readonly phase: ManagedPhase
  readonly context: Context
  readonly workspace_path: string
}

/** 推理是 Execution Plane 的接缝，Control 只接收结构化候选与真实 usage。 */
export type ManagedInference = (input: ManagedInferenceInput) => Promise<
  ResultWithUsage<{
    readonly value: unknown
    readonly usage: Usage
  }>
>

export type ManagedTicketStageName = 'execute' | 'verify' | 'review' | 'land'
export type ManagedTicketStatus =
  | 'READY'
  | 'RUNNING'
  | 'WAITING_HUMAN'
  | 'WAITING_GATEWAY'
  | 'PAUSED'
  | 'PR_OPENED'
  | 'CHECKING'
  | 'PR_READY'
  | 'PR_CHECKS_FAILED'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'

export interface ManagedTicketTask {
  readonly id: string
  readonly repo_id: string
  readonly package_digest: string
  readonly ticket_id: string
  readonly ticket_title: string
  readonly baseline_commit: string
  readonly worktree_path: string
  readonly current_stage: ManagedTicketStageName
  readonly status: ManagedTicketStatus
  readonly completion_target: 'branch_ready' | 'pr_ready'
  readonly lease_token: string | null
  readonly lease_until: string | null
  readonly attempts: number
  readonly max_attempts: number
  readonly rework_count: number
  readonly control_generation: number
  readonly pending_decision_id: string | null
  readonly pending_decision_revision: number | null
  readonly last_error: string | null
  readonly handoff: unknown
  readonly created_at: string
  readonly updated_at: string
}

export interface ManagedTicketStageRecord {
  readonly id: string
  readonly task_id: string
  readonly stage: ManagedTicketStageName
  readonly attempt: number
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'REUSED' | 'REWORK' | 'FAILED' | 'MUST_STOP'
  readonly package_digest: string
  readonly baseline_commit: string
  readonly input_commit: string
  readonly output_commit: string | null
  readonly input_digest: string
  readonly output_digest: string | null
  readonly evidence_digest: string | null
  readonly result: unknown
  readonly evidence: unknown
  readonly usage: unknown
  readonly reused_from_evidence_id: string | null
  readonly gate_digest: string | null
  readonly error: string | null
  readonly started_at: string
  readonly ended_at: string | null
}

export interface ManagedTicketToolPlan {
  readonly harness: string
  readonly stage: ManagedTicketStageName
  readonly profile: string
  readonly role: string
  readonly native_tools: readonly string[]
  readonly degradations: readonly unknown[]
  readonly missing_optional: readonly string[]
}

export interface ManagedTicketStageInput {
  readonly onProgress?: RunHooks['onProgress']
  readonly attempt_id: string
  readonly task_id: string
  readonly repo_id: string
  readonly stage: ManagedTicketStageName
  readonly context: Context
  readonly workspace_path: string
  readonly package: JstackTicketPackage
  readonly stage_definition: JstackTicketPackage['stages'][number]
  readonly tool_plan: ManagedTicketToolPlan
  readonly baseline_commit: string
  readonly input_commit: string
  readonly rework_notes: readonly string[]
  readonly human_decisions: readonly unknown[]
}

export type ManagedTicketStageRunner = (input: ManagedTicketStageInput) => Promise<
  ResultWithUsage<{
    readonly output: ManagedTicketStageResult
    readonly usage: Usage
  }>
>

export interface ManagedTicketDecisionRunInput {
  readonly attempt_id: string
  readonly task_id: string
  readonly repo_id: string
  readonly workspace_path: string
  readonly context: Context
}

export type ManagedTicketDecisionRunner = (input: ManagedTicketDecisionRunInput) => Promise<
  ResultWithUsage<{
    readonly output: TianwenDecision
    readonly usage: Usage
  }>
>

export type ManagedWorkflowStatus =
  | 'ROUTING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_HUMAN'
  | 'WAITING_GATEWAY'
  | 'PR_READY'
  | 'PAUSED'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'

export interface ManagedWorkflow {
  readonly id: string
  readonly repo_id: string
  readonly package_digest: string
  readonly repo_config_digest: string
  readonly baseline_commit: string
  readonly worktree_root: string
  readonly request: string
  readonly scope_paths: readonly string[]
  readonly external_issue: string | null
  readonly completion_target: 'branch_ready' | 'pr_ready'
  readonly status: ManagedWorkflowStatus
  readonly current_graph_version: number
  readonly lease_token: string | null
  readonly lease_until: string | null
  readonly attempts: number
  readonly max_attempts: number
  readonly last_error: string | null
  readonly created_at: string
  readonly updated_at: string
}

export type ManagedWorkflowNodeStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_HUMAN'
  | 'WAITING_GATEWAY'
  | 'PR_READY'
  | 'ARCHIVED'
  | 'FAILED'
  | 'CANCELLED'

export interface ManagedWorkflowNode {
  readonly id: string
  readonly workflow_id: string
  readonly graph_version: number
  readonly node_key: string
  readonly ticket_id: string
  readonly external_issue: string | null
  readonly ticket_title: string
  readonly ticket_size: 'XS' | 'S' | 'M'
  readonly depends_on: readonly string[]
  readonly scope_paths: readonly string[]
  readonly acceptance: readonly string[]
  readonly status: ManagedWorkflowNodeStatus
  readonly ticket_task_id: string | null
  readonly base_commit: string | null
  readonly worktree_path: string | null
  readonly output_commit: string | null
  readonly last_error: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface ManagedWorkflowGraph {
  readonly workflow_id: string
  readonly version: number
  readonly plan_digest: string
  readonly plan: unknown
  readonly status: 'COMMITTED' | 'SUPERSEDED'
  readonly created_at: string
  readonly committed_at: string
  readonly invalidated_reason: string | null
}

export interface ManagedWorkflowEvidence {
  readonly id: string
  readonly workflow_id: string
  readonly graph_version: number
  readonly node_id: string
  readonly source_node_id: string | null
  readonly stage: ManagedTicketStageName | 'archive'
  readonly input_commit: string
  readonly diff_digest: string
  readonly stage_digest: string
  readonly branch: string
  readonly target_digest: string
  readonly result_digest: string
  readonly evidence_digest: string
  readonly result: unknown
  readonly evidence: unknown
  readonly status: 'VALID' | 'INVALIDATED'
  readonly invalidated_reason: string | null
  readonly created_at: string
  readonly invalidated_at: string | null
}

export interface ManagedWorkflowPlanInput {
  readonly attempt_id: string
  readonly workflow_id: string
  readonly repo_id: string
  readonly request: string
  readonly context: Context
  readonly workspace_path: string
  readonly scope_paths: readonly string[]
  readonly package: JstackRoutePackage
}

export type ManagedWorkflowPlanRunner = (input: ManagedWorkflowPlanInput) => Promise<
  ResultWithUsage<{
    readonly output: JstackRoutePlan
    readonly usage: Usage
  }>
>

export interface ManagedWorkflowTickResult {
  readonly workflowId: string
  readonly status: ManagedWorkflowStatus
  readonly action:
    | 'planned'
    | 'materialized'
    | 'ticketed'
    | 'waiting'
    | 'plan_required'
    | 'plan_failed'
    | 'plan_rejected'
    | 'context_budget'
    | 'protocol_error'
    | 'workspace_error'
    | 'materialize_failed'
  readonly nodeKey?: string
  readonly ticketStatus?: string
  readonly error?: string
}

export type ManagedActionOutboxStatus =
  | 'PENDING'
  | 'LEASED'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'UNCERTAIN'

export interface ManagedActionOutboxRecord {
  readonly id: string
  readonly action_intent_id: string
  readonly status: ManagedActionOutboxStatus
  readonly lease_token: string | null
  readonly lease_until: string | null
  readonly fence: number
  readonly attempts: number
  readonly permit_id: string | null
  readonly remote_kind: 'pull_request' | null
  readonly remote_id: string | null
  readonly remote_url: string | null
  readonly result: unknown
  readonly last_error: string | null
  readonly next_attempt_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface ManagedActionOutboxClaim {
  readonly outbox: ManagedActionOutboxRecord
  readonly intent: ManagedActionIntent
}

export interface ManagedActionGatewayResult {
  readonly outboxId: string
  readonly taskId: string
  readonly status: ManagedActionOutboxStatus
  readonly prNumber?: number
  readonly prUrl?: string
  readonly error?: string
}

export interface ManagedCheckGatewayResult {
  readonly targetId: string
  readonly taskId: string
  readonly status: 'PENDING' | 'CHECKING' | 'READY' | 'FAILED'
  readonly prNumber: number
  readonly headSha: string
  readonly evidenceDigest?: string
  readonly error?: string
}
