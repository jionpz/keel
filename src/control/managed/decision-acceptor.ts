import { err, makeError, type Result } from '../../contracts/errors.js'
import type {
  DecisionRequest,
  DecisionResolution,
  DelegationPolicyVersion,
  ProjectDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import {
  decisionRequestDigest,
  validateDecisionRequest,
  validateDecisionResolution,
  validateDelegationPolicy,
  validateProjectDecision,
  validateTianwenProposal,
} from './decision-protocol.js'

export type DecisionControlState = 'active' | 'paused' | 'cancelled'

export interface DecisionAcceptanceControl {
  readonly state: DecisionControlState
  readonly task_active: boolean
  readonly budget_available: boolean
}

export interface AuthenticatedDecisionCaller {
  readonly actor_type: string
  readonly authenticated_id: string
  readonly source: string
}

export interface DecisionAcceptanceInput {
  readonly request: DecisionRequest
  readonly proposal: TianwenProposal
  readonly resolution_id: string
  readonly now: string
  readonly authenticated_caller: AuthenticatedDecisionCaller
  readonly decisions: readonly ProjectDecision[]
  readonly policy?: DelegationPolicyVersion | null
  readonly policies?: readonly DelegationPolicyVersion[]
  readonly control: DecisionAcceptanceControl
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const POLICY_STRICTNESS = { delegated: 0, owner_required: 1, deny: 2 } as const

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function activeAt(
  validFrom: string,
  validUntil: string | undefined,
  revokedAt: string | undefined,
  supersededBy: string | undefined,
  now: number,
): boolean {
  const from = timestamp(validFrom)
  if (from === null || from > now || revokedAt !== undefined || supersededBy !== undefined)
    return false
  if (validUntil === undefined) return true
  const until = timestamp(validUntil)
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

function decisionScopeMatchesRequest(decision: ProjectDecision, request: DecisionRequest): boolean {
  return (
    decision.project_id === request.project_id &&
    decision.decision_key === request.decision_key &&
    fieldMatches(decision.scope.decision_kinds, request.kind) &&
    fieldMatches(decision.scope.actions, request.action_category) &&
    fieldMatches(decision.scope.environments, request.impact.environment) &&
    fieldMatches(decision.scope.reversibilities, request.impact.reversibility) &&
    resourcesMatch(decision.scope.resource_selectors, request.impact.affected_resources)
  )
}

function selectedDecisionAnswer(
  decision: ProjectDecision,
  request: DecisionRequest,
): string | null {
  const decisionOption = decision.options.find(
    (option) => option.id === decision.selected_option_id,
  )
  const requestOption = request.options.find((option) => option.id === decision.selected_option_id)
  if (decisionOption === undefined || requestOption === undefined) return null
  return decisionOption.text === requestOption.text ? decisionOption.text : null
}

function decisionMatchesRequest(
  decision: ProjectDecision,
  request: DecisionRequest,
  answerOptionId: string,
): boolean {
  const selectedAnswer = selectedDecisionAnswer(decision, request)
  const requestOption = request.options.find((option) => option.id === answerOptionId)
  return (
    decisionScopeMatchesRequest(decision, request) &&
    decision.selected_option_id === answerOptionId &&
    selectedAnswer !== null &&
    requestOption !== undefined &&
    selectedAnswer === requestOption.text
  )
}

function hasConflictingDecisions(input: DecisionAcceptanceInput, now: number): boolean {
  const answers = new Set<string>()
  for (const decision of input.decisions) {
    if (
      decision.source_type !== 'owner_confirmed' ||
      !activeAt(
        decision.valid_from,
        decision.valid_until,
        decision.revoked_at,
        decision.superseded_by,
        now,
      ) ||
      !decisionScopeMatchesRequest(decision, input.request)
    )
      continue
    const answer = selectedDecisionAnswer(decision, input.request)
    if (answer !== null) answers.add(JSON.stringify([decision.selected_option_id, answer]))
  }
  return answers.size > 1
}

function policyRuleMatches(
  rule: DelegationPolicyVersion['rules'][number],
  request: DecisionRequest,
): boolean {
  return (
    fieldMatches(rule.decision_kinds, request.kind) &&
    fieldMatches(rule.actions, request.action_category) &&
    fieldMatches(rule.environments, request.impact.environment) &&
    rule.reversibility === request.impact.reversibility &&
    resourcesMatch(rule.resource_selectors, request.impact.affected_resources) &&
    policyImpactLimitsMatch(rule, request)
  )
}

function policyImpactLimitsMatch(
  rule: DelegationPolicyVersion['rules'][number],
  request: DecisionRequest,
): boolean {
  const limits = rule.impact_limits
  return (
    limits.environments.includes(request.impact.environment) &&
    limits.reversibilities.includes(request.impact.reversibility) &&
    request.impact.affected_resources.length <= limits.max_affected_resources
  )
}

function policyRequiresUnsupportedEvidence(
  rule: DelegationPolicyVersion['rules'][number],
): boolean {
  return rule.required_evidence.length > 0 || rule.required_checks.length > 0
}

function policyRequiresUnsupportedBudget(rule: DelegationPolicyVersion['rules'][number]): boolean {
  return (
    rule.budget_limits.max_attempts !== undefined ||
    rule.budget_limits.max_cost_usd !== undefined ||
    rule.budget_limits.max_tokens !== undefined
  )
}

function candidatePolicies(input: DecisionAcceptanceInput): readonly DelegationPolicyVersion[] {
  if (input.policies !== undefined) return input.policies
  return input.policy == null ? [] : [input.policy]
}

function usablePolicy(
  policy: DelegationPolicyVersion | null,
  projectId: string,
  now: number,
): DelegationPolicyVersion | null {
  if (
    policy === null ||
    policy.project_id !== projectId ||
    policy.approved_by_owner.trim().length === 0 ||
    !activeAt(policy.valid_from, policy.valid_until, policy.revoked_at, policy.superseded_by, now)
  )
    return null
  return policy
}

function strictestMode(
  rules: readonly DelegationPolicyVersion['rules'][number][],
): 'delegated' | 'owner_required' | 'deny' {
  return rules.reduce<'delegated' | 'owner_required' | 'deny'>(
    (current, rule) =>
      POLICY_STRICTNESS[rule.mode] > POLICY_STRICTNESS[current] ? rule.mode : current,
    'delegated',
  )
}

function authorityRef(
  kind: 'project_decision' | 'delegation_policy',
  id: string,
  version: number,
): DecisionResolution['authority_refs'][number] {
  return { kind, id, version }
}

function makeResolution(
  input: DecisionAcceptanceInput,
  disposition: DecisionResolution['disposition'],
  evidenceGrade: DecisionResolution['evidence_grade'],
  rationale: string,
  authorityRefs: DecisionResolution['authority_refs'],
  extras: {
    readonly answer_option_id?: string
    readonly answer?: string
    readonly policy?: DelegationPolicyVersion
    readonly validity_conditions: readonly string[]
  },
): DecisionResolution {
  const delegated = disposition === 'delegated'
  const actor: DecisionResolution['actor'] = delegated
    ? { type: 'tianwen', authenticated_id: input.authenticated_caller.authenticated_id }
    : { type: 'policy', authenticated_id: 'keel.decision-acceptor' }
  const contextDigest = sha256CanonicalJson({
    request_id: input.request.id,
    request_revision: input.request.revision,
    input_digest: input.request.input_digest,
    proposal: input.proposal,
    authority_refs: authorityRefs,
    policy:
      extras.policy === undefined
        ? null
        : {
            id: extras.policy.id,
            version: extras.policy.version,
            approved_by_owner: extras.policy.approved_by_owner,
          },
    control: input.control,
    now: input.now,
  })
  return {
    schema_version: '1.0',
    id: input.resolution_id,
    request_id: input.request.id,
    request_revision: input.request.revision,
    input_digest: input.request.input_digest,
    disposition,
    ...(extras.answer_option_id === undefined ? {} : { answer_option_id: extras.answer_option_id }),
    ...(extras.answer === undefined ? {} : { answer: extras.answer }),
    rationale,
    evidence_grade: evidenceGrade,
    basis_refs: input.proposal.basis_refs.map((ref) => ({ ...ref })),
    actor,
    authority_refs: authorityRefs.map((ref) => ({ ...ref })),
    validity_conditions: [...extras.validity_conditions],
    ...(input.request.observed_memory_epoch === undefined
      ? {}
      : { memory_epoch: input.request.observed_memory_epoch }),
    ...(extras.policy === undefined
      ? {}
      : {
          delegation_policy_id: extras.policy.id,
          delegation_policy_version: extras.policy.version,
        }),
    context_digest: contextDigest,
    resolved_at: input.now,
  }
}

function finish(resolution: DecisionResolution): Result<DecisionResolution> {
  return validateDecisionResolution(resolution)
}

function denied(
  input: DecisionAcceptanceInput,
  rationale: string,
  authorityRefs: DecisionResolution['authority_refs'] = [],
): Result<DecisionResolution> {
  return finish(deniedResolution(input, rationale, authorityRefs))
}

function deniedResolution(
  input: DecisionAcceptanceInput,
  rationale: string,
  authorityRefs: DecisionResolution['authority_refs'] = [],
): DecisionResolution {
  return makeResolution(input, 'denied', 'E0', rationale, authorityRefs, {
    validity_conditions: ['request remains denied until a new revision is opened'],
  })
}

function ownerRequired(
  input: DecisionAcceptanceInput,
  rationale: string,
  authorityRefs: DecisionResolution['authority_refs'] = [],
): Result<DecisionResolution> {
  return finish(ownerRequiredResolution(input, rationale, authorityRefs))
}

function ownerRequiredResolution(
  input: DecisionAcceptanceInput,
  rationale: string,
  authorityRefs: DecisionResolution['authority_refs'] = [],
): DecisionResolution {
  return makeResolution(input, 'owner_required', 'E0', rationale, authorityRefs, {
    validity_conditions: ['a human decision is required for the current request revision'],
  })
}

interface VerifiedReferences {
  readonly decisions: readonly ProjectDecision[]
  readonly policy: DelegationPolicyVersion | null
  readonly policyReferenced: boolean
}

type ReferenceCheck =
  | { readonly ok: true; readonly value: VerifiedReferences }
  | { readonly ok: false; readonly resolution: DecisionResolution }

function verifyReferences(input: DecisionAcceptanceInput, answerOptionId: string): ReferenceCheck {
  const now = timestamp(input.now)
  if (now === null)
    return {
      ok: false,
      resolution: deniedResolution(input, '接纳时间不是合法时间'),
    }
  const decisions: ProjectDecision[] = []
  let policy: DelegationPolicyVersion | null = null
  let policyReferenced = false

  for (const ref of input.proposal.basis_refs) {
    if (ref.kind === 'project_decision') {
      const decision = input.decisions.find(
        (candidate) => candidate.id === ref.id && candidate.version === ref.version,
      )
      if (decision === undefined)
        return {
          ok: false,
          resolution: ownerRequiredResolution(
            input,
            `无法解析项目决定引用 ${ref.id}@${ref.version}`,
          ),
        }
      if (decision.project_id !== input.request.project_id)
        return {
          ok: false,
          resolution: deniedResolution(input, `项目决定 ${ref.id} 不属于当前项目`),
        }
      if (
        decision.source_type !== 'owner_confirmed' ||
        !activeAt(
          decision.valid_from,
          decision.valid_until,
          decision.revoked_at,
          decision.superseded_by,
          now,
        )
      )
        return {
          ok: false,
          resolution: ownerRequiredResolution(
            input,
            `项目决定 ${ref.id}@${ref.version} 已失效、撤销或被替代`,
          ),
        }
      if (!decisionMatchesRequest(decision, input.request, answerOptionId))
        return {
          ok: false,
          resolution: ownerRequiredResolution(
            input,
            `项目决定 ${ref.id}@${ref.version} 的作用域或选项不匹配`,
          ),
        }
      decisions.push(decision)
    } else {
      policyReferenced = true
      const candidates = candidatePolicies(input)
      const referenced = candidates.find(
        (candidate) => candidate.id === ref.id && candidate.version === ref.version,
      )
      if (referenced === undefined)
        return {
          ok: false,
          resolution: ownerRequiredResolution(
            input,
            `无法解析委托策略引用 ${ref.id}@${ref.version}`,
          ),
        }
      if (policy !== null && policy.id !== referenced.id)
        return {
          ok: false,
          resolution: ownerRequiredResolution(input, '提案同时引用多个委托策略版本'),
        }
      if (referenced.project_id !== input.request.project_id)
        return {
          ok: false,
          resolution: deniedResolution(input, `委托策略 ${ref.id} 不属于当前项目`),
        }
      if (
        referenced.approved_by_owner.trim().length === 0 ||
        !activeAt(
          referenced.valid_from,
          referenced.valid_until,
          referenced.revoked_at,
          referenced.superseded_by,
          now,
        )
      )
        return {
          ok: false,
          resolution: ownerRequiredResolution(
            input,
            `委托策略 ${ref.id}@${ref.version} 已失效、撤销或被替代`,
          ),
        }
      policy = referenced
    }
  }

  return { ok: true, value: { decisions, policy, policyReferenced } }
}

export function acceptDecision(input: DecisionAcceptanceInput): Result<DecisionResolution> {
  const request = validateDecisionRequest(input.request)
  if (!request.ok) return request
  const proposal = validateTianwenProposal(input.proposal)
  if (!proposal.ok) return proposal
  for (const trustedDecision of input.decisions) {
    const checkedDecision = validateProjectDecision(trustedDecision)
    if (!checkedDecision.ok) return checkedDecision
  }
  for (const candidate of candidatePolicies(input)) {
    const checkedPolicy = validateDelegationPolicy(candidate)
    if (!checkedPolicy.ok) return checkedPolicy
  }
  if (!UUID.test(input.resolution_id))
    return err(makeError('SCHEMA_VIOLATION', 'resolution_id 不是 UUID'))
  const now = timestamp(input.now)
  if (now === null) return err(makeError('SCHEMA_VIOLATION', '接纳时间不是合法时间'))

  if (
    input.authenticated_caller.actor_type !== 'tianwen' ||
    input.authenticated_caller.source !== 'model_proposal' ||
    input.authenticated_caller.authenticated_id.trim().length === 0
  )
    return denied(input, '调用者身份或来源不是受信天问提案')
  if (input.request.status !== 'OPEN' && input.request.status !== 'PROCESSING')
    return denied(input, `请求状态 ${input.request.status} 不接受新决议`)
  if (input.request.revision !== input.proposal.request_revision)
    return denied(input, '提案 revision 与请求不匹配')
  if (input.proposal.request_id !== input.request.id)
    return denied(input, '提案 request_id 与请求不匹配')
  if (decisionRequestDigest(input.request) !== input.request.input_digest)
    return denied(input, '请求输入与持久 digest 不匹配')
  if (input.proposal.input_digest !== input.request.input_digest)
    return denied(input, '提案 digest 与请求不匹配')
  if (input.request.expires_at !== undefined) {
    const expiresAt = timestamp(input.request.expires_at)
    if (expiresAt === null) return err(makeError('SCHEMA_VIOLATION', 'expires_at 不是合法时间'))
    if (now >= expiresAt) return denied(input, '请求已过期')
  }
  if (
    input.control.state !== 'active' ||
    !input.control.task_active ||
    !input.control.budget_available
  )
    return denied(input, '任务控制状态或预算不允许自动接纳')
  if (input.proposal.recommendation !== 'answer')
    return ownerRequired(input, `本切片不接受 ${input.proposal.recommendation} 型提案`)
  if (input.proposal.unresolved_conflicts.length > 0 || input.proposal.missing_authority.length > 0)
    return ownerRequired(input, '提案仍有未解决冲突或缺失授权')
  if (input.proposal.observed_fact_refs.length > 0)
    return ownerRequired(input, '本切片尚未实现 observed fact 引用核验')
  const answerOptionId = input.proposal.answer_option_id
  if (answerOptionId === undefined) return ownerRequired(input, '提案没有指向请求选项')
  const answerOption = input.request.options.find((option) => option.id === answerOptionId)
  if (answerOption === undefined) return ownerRequired(input, '提案选项不在请求选项内')
  if (hasConflictingDecisions(input, now))
    return ownerRequired(input, '同一 decision_key 存在多个仍有效但答案冲突的项目决定')

  const refs = verifyReferences(input, answerOptionId)
  if (!refs.ok) return finish(refs.resolution)
  const decisionRefs = refs.value.decisions.map((decision) =>
    authorityRef('project_decision', decision.id, decision.version),
  )
  const policyRefs =
    refs.value.policy === null
      ? []
      : [authorityRef('delegation_policy', refs.value.policy.id, refs.value.policy.version)]

  const activePolicies = candidatePolicies(input)
    .filter((candidate) => usablePolicy(candidate, input.request.project_id, now) !== null)
    .filter((candidate) => candidate.project_id === input.request.project_id)
  const gateMatches = activePolicies.map((candidate) => ({
    policy: candidate,
    rules: candidate.rules.filter((rule) => policyRuleMatches(rule, input.request)),
  }))
  const gatePolicyRefs = gateMatches
    .filter((entry) => entry.rules.length > 0)
    .map((entry) => authorityRef('delegation_policy', entry.policy.id, entry.policy.version))
  if (gateMatches.some((entry) => strictestMode(entry.rules) === 'deny' && entry.rules.length > 0))
    return denied(input, '当前委托策略明确拒绝该问题', gatePolicyRefs)
  if (
    gateMatches.some(
      (entry) => strictestMode(entry.rules) === 'owner_required' && entry.rules.length > 0,
    )
  )
    return ownerRequired(input, '当前委托策略要求本次人工决定', gatePolicyRefs)
  if (
    gateMatches.some((entry) =>
      entry.rules.some(
        (rule) =>
          rule.mode === 'delegated' &&
          (policyRequiresUnsupportedEvidence(rule) || policyRequiresUnsupportedBudget(rule)),
      ),
    )
  )
    return ownerRequired(input, '当前委托策略要求的证据、检查或预算限制尚未实现', gatePolicyRefs)

  if (decisionRefs.length > 0) {
    return finish(
      makeResolution(
        input,
        'delegated',
        'E3',
        '仍有效且作用域匹配的项目明确决定覆盖本问题',
        decisionRefs,
        {
          answer_option_id: answerOption.id,
          answer: answerOption.text,
          validity_conditions: decisionRefs.map(
            (ref) => `project_decision:${ref.id}@${ref.version} remains active`,
          ),
        },
      ),
    )
  }

  if (!refs.value.policyReferenced || refs.value.policy === null)
    return ownerRequired(input, '没有可验证的 E3 决定或 E1 委托策略依据')
  if (input.request.kind === 'approval')
    return ownerRequired(input, 'approval 类请求必须先经执行网关核对动作与环境')
  if (input.request.impact.reversibility !== 'reversible')
    return ownerRequired(input, 'E1 只允许可逆默认，当前影响不可逆')
  const matching = refs.value.policy.rules.filter((rule) => policyRuleMatches(rule, input.request))
  if (matching.length === 0) return ownerRequired(input, '委托策略没有覆盖当前问题范围')
  const mode = strictestMode(matching)
  if (mode === 'deny') return denied(input, '当前委托策略明确拒绝该问题')
  if (mode === 'owner_required') return ownerRequired(input, '当前委托策略要求本次人工决定')
  const delegated = matching.filter((rule) => rule.mode === 'delegated')
  const defaults = new Set(
    delegated
      .map((rule) => rule.default_option_id)
      .filter((optionId): optionId is string => optionId !== undefined),
  )
  if (defaults.size !== 1 || !defaults.has(answerOption.id))
    return ownerRequired(input, '提案没有采用委托规则声明的可逆默认')

  return finish(
    makeResolution(
      input,
      'delegated',
      'E1',
      `提案采用委托策略 ${refs.value.policy.policy_id}@${refs.value.policy.version} 的可逆默认`,
      policyRefs,
      {
        answer_option_id: answerOption.id,
        answer: answerOption.text,
        policy: refs.value.policy,
        validity_conditions: [
          `delegation_policy:${refs.value.policy.id}@${refs.value.policy.version} remains active`,
          'request impact remains reversible',
        ],
      },
    ),
  )
}
