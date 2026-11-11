import type { ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  DecisionRequest,
  DecisionResolution,
  DelegationPolicyVersion,
  ProjectDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'

const ajv = new Ajv2020({ allErrors: true })
const validators = {
  request: ajv.compile<DecisionRequest>(MANAGED_SCHEMAS.decision_request),
  proposal: ajv.compile<TianwenProposal>(MANAGED_SCHEMAS.tianwen_proposal),
  resolution: ajv.compile<DecisionResolution>(MANAGED_SCHEMAS.decision_resolution),
  decision: ajv.compile<ProjectDecision>(MANAGED_SCHEMAS.project_decision),
  policy: ajv.compile<DelegationPolicyVersion>(MANAGED_SCHEMAS.delegation_policy),
}

function validated<T>(validate: ValidateFunction<T>, value: unknown): Result<T> {
  return validate(value)
    ? ok(value as T)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors ?? undefined)))
}

export function validateDecisionRequest(value: unknown): Result<DecisionRequest> {
  return validated(validators.request, value)
}

export function validateTianwenProposal(value: unknown): Result<TianwenProposal> {
  return validated(validators.proposal, value)
}

export function validateDecisionResolution(value: unknown): Result<DecisionResolution> {
  return validated(validators.resolution, value)
}

export function validateProjectDecision(value: unknown): Result<ProjectDecision> {
  return validated(validators.decision, value)
}

export function validateDelegationPolicy(value: unknown): Result<DelegationPolicyVersion> {
  return validated(validators.policy, value)
}

export function decisionRequestDigest(request: DecisionRequest): string {
  return sha256CanonicalJson({
    project_id: request.project_id,
    repo_id: request.repo_id,
    managed_task_id: request.managed_task_id ?? null,
    managed_question_id: request.managed_question_id ?? null,
    task_id: request.task_id ?? null,
    node_id: request.node_id ?? null,
    attempt_id: request.attempt_id ?? null,
    decision_key: request.decision_key,
    kind: request.kind,
    question: request.question,
    options: request.options,
    suggested_option_id: request.suggested_option_id ?? null,
    constraints: request.constraints,
    missing_information: request.missing_information,
    impact: request.impact,
    action_category: request.action_category,
    workflow_digest: request.workflow_digest ?? null,
    observed_memory_epoch: request.observed_memory_epoch ?? null,
    expires_at: request.expires_at ?? null,
  })
}
