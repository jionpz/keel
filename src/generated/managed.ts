/**
 * ⚠️ 本文件由 scripts/generate-types.ts 自动生成 —— 请勿手改。
 *
 * 事实来源：docs/schemas/*.schema.json
 * 重新生成：pnpm run generate
 *
 * 手改本文件会立刻产生第二个事实来源，schema 从此不可信。
 * CI 会通过 `pnpm run check:generated` 检测手改（ADR-0002 L2/L4）。
 */

export interface DecisionRequest {
schema_version: "1.0"
id: string
revision: number
idempotency_key: string
project_id: string
repo_id: string
managed_task_id?: string
managed_question_id?: string
task_id?: string
node_id?: string
attempt_id?: string
decision_key: string
kind: ("clarification" | "preference" | "design" | "approval" | "recovery" | "budget")
question: string
/**
 * @minItems 2
 * @maxItems 12
 */
options: [{
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]
suggested_option_id?: string
/**
 * @maxItems 32
 */
constraints: string[]
/**
 * @maxItems 32
 */
missing_information: string[]
impact: {
environment: ("local" | "test" | "staging" | "production")
reversibility: ("reversible" | "partially_reversible" | "irreversible")
/**
 * @minItems 1
 * @maxItems 64
 */
affected_resources: [string, ...(string)[]]
}
action_category: string
workflow_digest?: string
observed_memory_epoch?: number
input_digest: string
status: ("OPEN" | "PROCESSING" | "WAITING_HUMAN" | "RESOLVED" | "CANCELLED" | "SUPERSEDED")
expires_at?: string
created_at: string
}

export interface DecisionResolution {
schema_version: "1.0"
id: string
request_id: string
request_revision: number
input_digest: string
disposition: ("delegated" | "human_confirmed" | "owner_required" | "denied")
answer_option_id?: string
answer?: string
rationale: string
evidence_grade: ("E0" | "E1" | "E2" | "E3")
/**
 * @maxItems 64
 */
basis_refs: {
kind: ("project_decision" | "delegation_policy")
id: string
version: number
}[]
actor: {
type: ("tianwen" | "human" | "policy")
authenticated_id: string
}
/**
 * @maxItems 64
 */
authority_refs: {
kind: ("project_decision" | "delegation_policy")
id: string
version: number
}[]
/**
 * @maxItems 64
 */
validity_conditions: string[]
memory_epoch?: number
delegation_policy_id?: string
delegation_policy_version?: number
context_digest: string
resolved_at: string
}

export interface DelegationPolicyVersion {
schema_version: "1.0"
id: string
policy_id: string
version: number
project_id: string
approved_by_owner: string
approved_at: string
valid_from: string
valid_until?: string
/**
 * @minItems 1
 * @maxItems 64
 */
rules: [{
id: string
/**
 * @minItems 1
 */
decision_kinds: [("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"), ...(("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"))[]]
/**
 * @minItems 1
 */
actions: [string, ...(string)[]]
/**
 * @minItems 1
 */
resource_selectors: [string, ...(string)[]]
/**
 * @minItems 1
 */
environments: [("*" | "local" | "test" | "staging" | "production"), ...(("*" | "local" | "test" | "staging" | "production"))[]]
reversibility: ("reversible" | "partially_reversible" | "irreversible")
impact_limits: {
/**
 * @minItems 1
 */
environments: [("local" | "test" | "staging" | "production"), ...(("local" | "test" | "staging" | "production"))[]]
/**
 * @minItems 1
 */
reversibilities: [("reversible" | "partially_reversible" | "irreversible"), ...(("reversible" | "partially_reversible" | "irreversible"))[]]
max_affected_resources: number
}
budget_limits: {
max_cost_usd?: number
max_tokens?: number
max_attempts?: number
}
/**
 * @maxItems 16
 */
required_evidence: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
/**
 * @maxItems 16
 */
required_checks: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
mode: ("delegated" | "owner_required" | "deny")
default_option_id?: string
}, ...({
id: string
/**
 * @minItems 1
 */
decision_kinds: [("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"), ...(("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"))[]]
/**
 * @minItems 1
 */
actions: [string, ...(string)[]]
/**
 * @minItems 1
 */
resource_selectors: [string, ...(string)[]]
/**
 * @minItems 1
 */
environments: [("*" | "local" | "test" | "staging" | "production"), ...(("*" | "local" | "test" | "staging" | "production"))[]]
reversibility: ("reversible" | "partially_reversible" | "irreversible")
impact_limits: {
/**
 * @minItems 1
 */
environments: [("local" | "test" | "staging" | "production"), ...(("local" | "test" | "staging" | "production"))[]]
/**
 * @minItems 1
 */
reversibilities: [("reversible" | "partially_reversible" | "irreversible"), ...(("reversible" | "partially_reversible" | "irreversible"))[]]
max_affected_resources: number
}
budget_limits: {
max_cost_usd?: number
max_tokens?: number
max_attempts?: number
}
/**
 * @maxItems 16
 */
required_evidence: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
/**
 * @maxItems 16
 */
required_checks: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string]
mode: ("delegated" | "owner_required" | "deny")
default_option_id?: string
})[]]
supersedes_id?: string
superseded_by?: string
revoked_at?: string
revoked_by?: string
revocation_reason?: string
created_at: string
}

export type ManagedInvestigationResult = ({
outcome: "read_files"
/**
 * @minItems 1
 * @maxItems 8
 */
paths: [string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]
} | {
outcome: "waiting_decision"
question: string
/**
 * @minItems 2
 * @maxItems 6
 */
options: [string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]
decision_key: string
kind: ("clarification" | "preference" | "design" | "approval" | "recovery" | "budget")
action_category: string
impact: {
environment: ("local" | "test" | "staging" | "production")
reversibility: ("reversible" | "partially_reversible" | "irreversible")
/**
 * @minItems 1
 * @maxItems 64
 */
affected_resources: [string, ...(string)[]]
}
} | {
outcome: "completed"
report: string
/**
 * @minItems 1
 * @maxItems 32
 */
citations: [{
path: string
digest: string
}, ...({
path: string
digest: string
})[]]
})

export interface ProjectDecision {
schema_version: "1.0"
id: string
project_id: string
decision_key: string
version: number
statement: string
selected_option_id: string
/**
 * @minItems 1
 * @maxItems 12
 */
options: [{
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]|[{
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}, {
id: string
text: string
}]
scope: {
/**
 * @minItems 1
 */
decision_kinds: [("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"), ...(("*" | "clarification" | "preference" | "design" | "approval" | "recovery" | "budget"))[]]
/**
 * @minItems 1
 */
actions: [string, ...(string)[]]
/**
 * @minItems 1
 */
resource_selectors: [string, ...(string)[]]
/**
 * @minItems 1
 */
environments: [("*" | "local" | "test" | "staging" | "production"), ...(("*" | "local" | "test" | "staging" | "production"))[]]
/**
 * @minItems 1
 */
reversibilities: [("*" | "reversible" | "partially_reversible" | "irreversible"), ...(("*" | "reversible" | "partially_reversible" | "irreversible"))[]]
}
source_type: ("owner_confirmed" | "imported_candidate" | "policy_default")
source_ref: string
created_by: string
valid_from: string
valid_until?: string
supersedes_id?: string
superseded_by?: string
revoked_at?: string
revoked_by?: string
revocation_reason?: string
created_at: string
}

export interface TianwenDecision {
recommendation: ("answer" | "approve" | "reject" | "defer")
answer_option_id?: string
rationale: string
/**
 * @maxItems 64
 */
basis_refs: {
kind: ("project_decision" | "delegation_policy")
id: string
version: number
}[]
/**
 * @maxItems 64
 */
assumptions: string[]
/**
 * @maxItems 32
 */
alternatives: string[]
/**
 * @maxItems 32
 */
unresolved_conflicts: string[]
/**
 * @maxItems 32
 */
missing_authority: string[]
}

export interface TianwenProposal {
schema_version: "1.0"
request_id: string
request_revision: number
input_digest: string
recommendation: ("answer" | "approve" | "reject" | "defer")
answer_option_id?: string
rationale: string
claimed_evidence_grade: ("E0" | "E1" | "E2" | "E3")
/**
 * @maxItems 64
 */
basis_refs: {
kind: ("project_decision" | "delegation_policy")
id: string
version: number
}[]
/**
 * @maxItems 64
 */
observed_fact_refs: string[]
/**
 * @maxItems 64
 */
assumptions: string[]
/**
 * @maxItems 32
 */
alternatives: string[]
/**
 * @maxItems 32
 */
unresolved_conflicts: string[]
/**
 * @maxItems 32
 */
missing_authority: string[]
validation_plan?: string
rollback_plan?: string
model_profile_version?: string
}

export interface TianwenSuggestion {
recommendation: string
rationale: string
/**
 * @maxItems 12
 */
missing_information: []|[string]|[string, string]|[string, string, string]|[string, string, string, string]|[string, string, string, string, string]|[string, string, string, string, string, string]|[string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string]|[string, string, string, string, string, string, string, string, string, string, string, string]
}

export interface JstackInvestigationPackage {
protocol_version: "1.0"
workflow_id: "jstack"
mode: "investigation"
source_commit: string
/**
 * @minItems 1
 * @maxItems 1
 */
stages: ["execute"]
instructions: {
route: string
stages: string
execute: string
}
}

export const MANAGED_SCHEMAS = {"decision_request": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"DecisionRequest","type":"object","additionalProperties":false,"required":["schema_version","id","revision","idempotency_key","project_id","repo_id","decision_key","kind","question","options","constraints","missing_information","impact","action_category","input_digest","status","created_at"],"properties":{"schema_version":{"const":"1.0"},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"revision":{"type":"integer","minimum":1},"idempotency_key":{"type":"string","minLength":1,"maxLength":300},"project_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"repo_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"managed_task_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"managed_question_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"task_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"node_id":{"type":"string","minLength":1,"maxLength":300},"attempt_id":{"type":"string","minLength":1,"maxLength":300},"decision_key":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,127}$"},"kind":{"enum":["clarification","preference","design","approval","recovery","budget"]},"question":{"type":"string","minLength":1,"maxLength":16000},"options":{"type":"array","minItems":2,"maxItems":12,"items":{"type":"object","additionalProperties":false,"required":["id","text"],"properties":{"id":{"type":"string","minLength":1,"maxLength":100},"text":{"type":"string","minLength":1,"maxLength":4000}}}},"suggested_option_id":{"type":"string","minLength":1,"maxLength":100},"constraints":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"missing_information":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"impact":{"type":"object","additionalProperties":false,"required":["environment","reversibility","affected_resources"],"properties":{"environment":{"enum":["local","test","staging","production"]},"reversibility":{"enum":["reversible","partially_reversible","irreversible"]},"affected_resources":{"type":"array","minItems":1,"maxItems":64,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}}}},"action_category":{"type":"string","minLength":1,"maxLength":128},"workflow_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"observed_memory_epoch":{"type":"integer","minimum":0},"input_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"status":{"enum":["OPEN","PROCESSING","WAITING_HUMAN","RESOLVED","CANCELLED","SUPERSEDED"]},"expires_at":{"type":"string","minLength":1,"maxLength":64},"created_at":{"type":"string","minLength":1,"maxLength":64}}},
"decision_resolution": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"DecisionResolution","type":"object","additionalProperties":false,"required":["schema_version","id","request_id","request_revision","input_digest","disposition","rationale","evidence_grade","basis_refs","actor","authority_refs","validity_conditions","context_digest","resolved_at"],"properties":{"schema_version":{"const":"1.0"},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"request_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"request_revision":{"type":"integer","minimum":1},"input_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"disposition":{"enum":["delegated","human_confirmed","owner_required","denied"]},"answer_option_id":{"type":"string","minLength":1,"maxLength":100},"answer":{"type":"string","minLength":1,"maxLength":4000},"rationale":{"type":"string","minLength":1,"maxLength":16000},"evidence_grade":{"enum":["E0","E1","E2","E3"]},"basis_refs":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["kind","id","version"],"properties":{"kind":{"enum":["project_decision","delegation_policy"]},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"version":{"type":"integer","minimum":1}}}},"actor":{"type":"object","additionalProperties":false,"required":["type","authenticated_id"],"properties":{"type":{"enum":["tianwen","human","policy"]},"authenticated_id":{"type":"string","minLength":1,"maxLength":300}}},"authority_refs":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["kind","id","version"],"properties":{"kind":{"enum":["project_decision","delegation_policy"]},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"version":{"type":"integer","minimum":1}}}},"validity_conditions":{"type":"array","maxItems":64,"items":{"type":"string","minLength":1,"maxLength":2000}},"memory_epoch":{"type":"integer","minimum":0},"delegation_policy_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"delegation_policy_version":{"type":"integer","minimum":1},"context_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"resolved_at":{"type":"string","minLength":1,"maxLength":64}}},
"delegation_policy": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"DelegationPolicyVersion","type":"object","additionalProperties":false,"required":["schema_version","id","policy_id","version","project_id","approved_by_owner","approved_at","valid_from","rules","created_at"],"properties":{"schema_version":{"const":"1.0"},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"policy_id":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,127}$"},"version":{"type":"integer","minimum":1},"project_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"approved_by_owner":{"type":"string","minLength":1,"maxLength":200},"approved_at":{"type":"string","minLength":1,"maxLength":64},"valid_from":{"type":"string","minLength":1,"maxLength":64},"valid_until":{"type":"string","minLength":1,"maxLength":64},"rules":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["id","decision_kinds","actions","resource_selectors","environments","reversibility","impact_limits","budget_limits","required_evidence","required_checks","mode"],"properties":{"id":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,127}$"},"decision_kinds":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["*","clarification","preference","design","approval","recovery","budget"]}},"actions":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":128}},"resource_selectors":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}},"environments":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["*","local","test","staging","production"]}},"reversibility":{"enum":["reversible","partially_reversible","irreversible"]},"impact_limits":{"type":"object","additionalProperties":false,"required":["environments","reversibilities","max_affected_resources"],"properties":{"environments":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["local","test","staging","production"]}},"reversibilities":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["reversible","partially_reversible","irreversible"]}},"max_affected_resources":{"type":"integer","minimum":1,"maximum":64}}},"budget_limits":{"type":"object","additionalProperties":false,"properties":{"max_cost_usd":{"type":"number","minimum":0},"max_tokens":{"type":"integer","minimum":0},"max_attempts":{"type":"integer","minimum":1}}},"required_evidence":{"type":"array","maxItems":16,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":200}},"required_checks":{"type":"array","maxItems":16,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":200}},"mode":{"enum":["delegated","owner_required","deny"]},"default_option_id":{"type":"string","minLength":1,"maxLength":100}}}},"supersedes_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"superseded_by":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"revoked_at":{"type":"string","minLength":1,"maxLength":64},"revoked_by":{"type":"string","minLength":1,"maxLength":200},"revocation_reason":{"type":"string","minLength":1,"maxLength":2000},"created_at":{"type":"string","minLength":1,"maxLength":64}}},
"investigation_result": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ManagedInvestigationResult","oneOf":[{"type":"object","additionalProperties":false,"required":["outcome","paths"],"properties":{"outcome":{"const":"read_files"},"paths":{"type":"array","minItems":1,"maxItems":8,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}}}},{"type":"object","additionalProperties":false,"required":["outcome","question","options","decision_key","kind","action_category","impact"],"properties":{"outcome":{"const":"waiting_decision"},"question":{"type":"string","minLength":1,"maxLength":4000},"options":{"type":"array","minItems":2,"maxItems":6,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1000}},"decision_key":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,127}$"},"kind":{"enum":["clarification","preference","design","approval","recovery","budget"]},"action_category":{"type":"string","minLength":1,"maxLength":128},"impact":{"type":"object","additionalProperties":false,"required":["environment","reversibility","affected_resources"],"properties":{"environment":{"enum":["local","test","staging","production"]},"reversibility":{"enum":["reversible","partially_reversible","irreversible"]},"affected_resources":{"type":"array","minItems":1,"maxItems":64,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}}}}}},{"type":"object","additionalProperties":false,"required":["outcome","report","citations"],"properties":{"outcome":{"const":"completed"},"report":{"type":"string","minLength":1,"maxLength":16000},"citations":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["path","digest"],"properties":{"path":{"type":"string","minLength":1},"digest":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}}}}]},
"project_decision": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"ProjectDecision","type":"object","additionalProperties":false,"required":["schema_version","id","project_id","decision_key","version","statement","selected_option_id","options","scope","source_type","source_ref","created_by","valid_from","created_at"],"properties":{"schema_version":{"const":"1.0"},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"project_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"decision_key":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]{0,127}$"},"version":{"type":"integer","minimum":1},"statement":{"type":"string","minLength":1,"maxLength":16000},"selected_option_id":{"type":"string","minLength":1,"maxLength":100},"options":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"object","additionalProperties":false,"required":["id","text"],"properties":{"id":{"type":"string","minLength":1,"maxLength":100},"text":{"type":"string","minLength":1,"maxLength":4000}}}},"scope":{"type":"object","additionalProperties":false,"required":["decision_kinds","actions","resource_selectors","environments","reversibilities"],"properties":{"decision_kinds":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["*","clarification","preference","design","approval","recovery","budget"]}},"actions":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":128}},"resource_selectors":{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":512}},"environments":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["*","local","test","staging","production"]}},"reversibilities":{"type":"array","minItems":1,"uniqueItems":true,"items":{"enum":["*","reversible","partially_reversible","irreversible"]}}}},"source_type":{"enum":["owner_confirmed","imported_candidate","policy_default"]},"source_ref":{"type":"string","minLength":1,"maxLength":1000},"created_by":{"type":"string","minLength":1,"maxLength":200},"valid_from":{"type":"string","minLength":1,"maxLength":64},"valid_until":{"type":"string","minLength":1,"maxLength":64},"supersedes_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"superseded_by":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"revoked_at":{"type":"string","minLength":1,"maxLength":64},"revoked_by":{"type":"string","minLength":1,"maxLength":200},"revocation_reason":{"type":"string","minLength":1,"maxLength":2000},"created_at":{"type":"string","minLength":1,"maxLength":64}}},
"tianwen_decision": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TianwenDecision","type":"object","additionalProperties":false,"required":["recommendation","rationale","basis_refs","assumptions","alternatives","unresolved_conflicts","missing_authority"],"properties":{"recommendation":{"enum":["answer","approve","reject","defer"]},"answer_option_id":{"type":"string","minLength":1,"maxLength":100},"rationale":{"type":"string","minLength":1,"maxLength":16000},"basis_refs":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["kind","id","version"],"properties":{"kind":{"enum":["project_decision","delegation_policy"]},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"version":{"type":"integer","minimum":1}}}},"assumptions":{"type":"array","maxItems":64,"items":{"type":"string","minLength":1,"maxLength":2000}},"alternatives":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"unresolved_conflicts":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"missing_authority":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}}}},
"tianwen_proposal": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TianwenProposal","type":"object","additionalProperties":false,"required":["schema_version","request_id","request_revision","input_digest","recommendation","rationale","claimed_evidence_grade","basis_refs","observed_fact_refs","assumptions","alternatives","unresolved_conflicts","missing_authority"],"properties":{"schema_version":{"const":"1.0"},"request_id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"request_revision":{"type":"integer","minimum":1},"input_digest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"recommendation":{"enum":["answer","approve","reject","defer"]},"answer_option_id":{"type":"string","minLength":1,"maxLength":100},"rationale":{"type":"string","minLength":1,"maxLength":16000},"claimed_evidence_grade":{"enum":["E0","E1","E2","E3"]},"basis_refs":{"type":"array","maxItems":64,"items":{"type":"object","additionalProperties":false,"required":["kind","id","version"],"properties":{"kind":{"enum":["project_decision","delegation_policy"]},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"version":{"type":"integer","minimum":1}}}},"observed_fact_refs":{"type":"array","maxItems":64,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":1000}},"assumptions":{"type":"array","maxItems":64,"items":{"type":"string","minLength":1,"maxLength":2000}},"alternatives":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"unresolved_conflicts":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"missing_authority":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":2000}},"validation_plan":{"type":"string","minLength":1,"maxLength":8000},"rollback_plan":{"type":"string","minLength":1,"maxLength":8000},"model_profile_version":{"type":"string","minLength":1,"maxLength":300}}},
"tianwen_suggestion": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"TianwenSuggestion","type":"object","additionalProperties":false,"required":["recommendation","rationale","missing_information"],"properties":{"recommendation":{"type":"string","minLength":1,"maxLength":4000},"rationale":{"type":"string","minLength":1,"maxLength":4000},"missing_information":{"type":"array","maxItems":12,"items":{"type":"string","minLength":1,"maxLength":1000}}}},
"workflow_package": {"$schema":"https://json-schema.org/draft/2020-12/schema","title":"JstackInvestigationPackage","type":"object","additionalProperties":false,"required":["protocol_version","workflow_id","mode","source_commit","stages","instructions"],"properties":{"protocol_version":{"const":"1.0"},"workflow_id":{"const":"jstack"},"mode":{"const":"investigation"},"source_commit":{"type":"string","minLength":1,"maxLength":100},"stages":{"type":"array","minItems":1,"maxItems":1,"items":{"const":"execute"}},"instructions":{"type":"object","additionalProperties":false,"required":["route","stages","execute"],"properties":{"route":{"type":"string","minLength":1,"maxLength":100000},"stages":{"type":"string","minLength":1,"maxLength":50000},"execute":{"type":"string","minLength":1,"maxLength":30000}}}}}} as const
