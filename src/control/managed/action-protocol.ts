import type { ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedActionIntent, ManagedExecutionPermit } from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'

const ajv = new Ajv2020({ allErrors: true })
const validators = {
  intent: ajv.compile<ManagedActionIntent>(MANAGED_SCHEMAS.action_intent),
  permit: ajv.compile<ManagedExecutionPermit>(MANAGED_SCHEMAS.execution_permit),
}

function validated<T>(validate: ValidateFunction<T>, value: unknown): Result<T> {
  return validate(value)
    ? ok(value as T)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors ?? undefined)))
}

export function validateActionIntent(value: unknown): Result<ManagedActionIntent> {
  return validated(validators.intent, value)
}

export function validateExecutionPermit(value: unknown): Result<ManagedExecutionPermit> {
  return validated(validators.permit, value)
}

export function actionTargetDigest(
  intent: Pick<
    ManagedActionIntent,
    | 'remote_url'
    | 'base_branch'
    | 'head_branch'
    | 'pr_title'
    | 'pr_body'
    | 'environment'
    | 'reversibility'
    | 'affected_resources'
  >,
): string {
  return sha256CanonicalJson({
    remote_url: intent.remote_url,
    base_branch: intent.base_branch,
    head_branch: intent.head_branch,
    pr_title: intent.pr_title,
    pr_body: intent.pr_body,
    environment: intent.environment,
    reversibility: intent.reversibility,
    affected_resources: [...intent.affected_resources].sort(),
  })
}

export function actionAuthorizationDigest(input: {
  readonly project_id: string
  readonly action: string
  readonly environment: string
  readonly reversibility: string
  readonly affected_resources: readonly string[]
  readonly policy_id: string
  readonly policy_version: number
  readonly rule_id: string
  readonly required_checks: readonly string[]
  readonly budget: Readonly<Record<string, number>>
}): string {
  return sha256CanonicalJson({
    project_id: input.project_id,
    action: input.action,
    environment: input.environment,
    reversibility: input.reversibility,
    affected_resources: [...input.affected_resources].sort(),
    policy_id: input.policy_id,
    policy_version: input.policy_version,
    rule_id: input.rule_id,
    required_checks: [...input.required_checks].sort(),
    budget: input.budget,
  })
}
