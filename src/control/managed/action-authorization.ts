import type { DelegationPolicyVersion } from '../../generated/managed.js'
import { actionAuthorizationDigest } from './action-protocol.js'

export interface ActionAuthorizationRequest {
  readonly project_id: string
  readonly action: 'push_and_pr'
  readonly environment: 'local' | 'test' | 'staging' | 'production'
  readonly reversibility: 'reversible' | 'partially_reversible' | 'irreversible'
  readonly affected_resources: readonly string[]
  /** 当前 outbox 已认领的尝试次数；用于校验 max_attempts 预算。 */
  readonly attempts?: number
  readonly now: string
}

export type ActionAuthorization =
  | {
      readonly ok: true
      readonly kind: 'delegation_policy'
      readonly policy_id: string
      readonly policy_version: number
      readonly rule_id: string
      readonly digest: string
      readonly required_checks: readonly string[]
      readonly budget: Readonly<Record<string, number>>
    }
  | {
      readonly ok: false
      readonly reason: string
      readonly restrictive: boolean
    }

const POLICY_STRICTNESS = { delegated: 0, owner_required: 1, deny: 2 } as const

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function activeAt(policy: DelegationPolicyVersion, now: number): boolean {
  if (
    policy.approved_by_owner.trim() === '' ||
    policy.revoked_at !== undefined ||
    policy.superseded_by !== undefined
  )
    return false
  const from = timestamp(policy.valid_from)
  if (from === null || from > now) return false
  if (policy.valid_until === undefined) return true
  const until = timestamp(policy.valid_until)
  return until !== null && now < until
}

function fieldMatches(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value)
}

function validSelector(selector: string): boolean {
  if (selector === '*') return true
  if (!selector.includes('*')) return selector.length > 0
  return selector.length > 1 && selector.endsWith('*') && !selector.slice(0, -1).includes('*')
}

function selectorMatches(selector: string, resource: string): boolean {
  if (!validSelector(selector)) return false
  if (selector === '*') return true
  return selector.endsWith('*') ? resource.startsWith(selector.slice(0, -1)) : resource === selector
}

function resourcesMatch(selectors: readonly string[], resources: readonly string[]): boolean {
  return (
    resources.length > 0 &&
    resources.every((resource) => selectors.some((selector) => selectorMatches(selector, resource)))
  )
}

function ruleMatches(
  rule: DelegationPolicyVersion['rules'][number],
  request: ActionAuthorizationRequest,
): boolean {
  const limits = rule.impact_limits
  return (
    fieldMatches(rule.decision_kinds, 'approval') &&
    fieldMatches(rule.actions, request.action) &&
    fieldMatches(rule.environments, request.environment) &&
    rule.reversibility === request.reversibility &&
    resourcesMatch(rule.resource_selectors, request.affected_resources) &&
    limits.environments.includes(request.environment) &&
    limits.reversibilities.includes(request.reversibility) &&
    request.affected_resources.length <= limits.max_affected_resources
  )
}

function ruleNeedsUnsupportedEnforcement(rule: DelegationPolicyVersion['rules'][number]): boolean {
  return (
    rule.required_evidence.length > 0 ||
    rule.budget_limits.max_cost_usd !== undefined ||
    rule.budget_limits.max_tokens !== undefined
  )
}

function hasWildcardSelector(values: readonly string[]): boolean {
  return values.some((value) => value.includes('*'))
}

function highImpactRuleIsExact(
  rule: DelegationPolicyVersion['rules'][number],
  request: ActionAuthorizationRequest,
): boolean {
  if (request.reversibility === 'reversible') return true
  return (
    !hasWildcardSelector(rule.actions) &&
    !hasWildcardSelector(rule.resource_selectors) &&
    !hasWildcardSelector(rule.environments)
  )
}

function budgetFor(
  rule: DelegationPolicyVersion['rules'][number],
): Readonly<Record<string, number>> {
  return {
    ...(rule.budget_limits.max_attempts === undefined
      ? {}
      : { max_attempts: rule.budget_limits.max_attempts }),
  }
}

export function authorizeAction(
  request: ActionAuthorizationRequest,
  policies: readonly DelegationPolicyVersion[],
): ActionAuthorization {
  const now = timestamp(request.now)
  if (now === null) return { ok: false, reason: '授权时间无效', restrictive: true }

  const matching = policies
    .filter((policy) => policy.project_id === request.project_id && activeAt(policy, now))
    .flatMap((policy) =>
      policy.rules.filter((rule) => ruleMatches(rule, request)).map((rule) => ({ policy, rule })),
    )
  if (matching.length === 0)
    return { ok: false, reason: '没有覆盖该动作的有效委托规则', restrictive: false }

  if (matching.some(({ rule }) => ruleNeedsUnsupportedEnforcement(rule)))
    return {
      ok: false,
      reason: '匹配的委托规则要求本切片尚未执行的证据或预算门禁',
      restrictive: true,
    }
  if (matching.some(({ rule }) => !highImpactRuleIsExact(rule, request)))
    return {
      ok: false,
      reason: '高影响授权必须精确声明动作、环境与资源，不能使用通配符',
      restrictive: true,
    }
  if (
    matching.some(
      ({ rule }) =>
        rule.budget_limits.max_attempts !== undefined &&
        (request.attempts === undefined || request.attempts > rule.budget_limits.max_attempts),
    )
  )
    return { ok: false, reason: '动作尝试次数超过委托预算', restrictive: true }

  const strictest = matching.reduce<'delegated' | 'owner_required' | 'deny'>(
    (current, { rule }) =>
      POLICY_STRICTNESS[rule.mode] > POLICY_STRICTNESS[current] ? rule.mode : current,
    'delegated',
  )
  if (strictest !== 'delegated')
    return {
      ok: false,
      reason: `匹配的委托规则要求 ${strictest}`,
      restrictive: true,
    }

  const selected = matching
    .filter(({ rule }) => rule.mode === 'delegated')
    .sort(
      (left, right) =>
        right.policy.version - left.policy.version || left.rule.id.localeCompare(right.rule.id),
    )[0]
  if (selected === undefined)
    return { ok: false, reason: '没有可用的 delegated 规则', restrictive: false }

  const requiredChecks = [...new Set(matching.flatMap(({ rule }) => rule.required_checks))].sort()
  if (requiredChecks.length > 16)
    return {
      ok: false,
      reason: `required checks 并集 ${requiredChecks.length} 条超过 16 条上限`,
      restrictive: true,
    }
  const budget = budgetFor(selected.rule)

  return {
    ok: true,
    kind: 'delegation_policy',
    policy_id: selected.policy.id,
    policy_version: selected.policy.version,
    rule_id: selected.rule.id,
    digest: actionAuthorizationDigest({
      project_id: request.project_id,
      action: request.action,
      environment: request.environment,
      reversibility: request.reversibility,
      affected_resources: request.affected_resources,
      policy_id: selected.policy.id,
      policy_version: selected.policy.version,
      rule_id: selected.rule.id,
      required_checks: requiredChecks,
      budget,
    }),
    required_checks: requiredChecks,
    budget,
  }
}
