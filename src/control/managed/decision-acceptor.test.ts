import { describe, expect, it } from 'vitest'
import type {
  DecisionRequest,
  DelegationPolicyVersion,
  ProjectDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { acceptDecision, type DecisionAcceptanceInput } from './decision-acceptor.js'
import { decisionRequestDigest, validateTianwenProposal } from './decision-protocol.js'

const NOW = '2026-11-11T00:00:00.000Z'
const PAST = '2026-11-01T00:00:00.000Z'
const FUTURE = '2026-12-01T00:00:00.000Z'
const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const RESOLUTION_ID = '99999999-9999-4999-8999-999999999999'
const DECISION_ID = '44444444-4444-4444-8444-444444444444'
const POLICY_ID = '55555555-5555-4555-8555-555555555555'

const OPTIONS: DecisionRequest['options'] = [
  { id: 'zh', text: '中文' },
  { id: 'en', text: '英文' },
]

function request(over: Partial<DecisionRequest> = {}): DecisionRequest {
  const value: DecisionRequest = {
    schema_version: '1.0',
    id: REQUEST_ID,
    revision: 1,
    idempotency_key: 'managed-question:test',
    project_id: PROJECT_A,
    repo_id: PROJECT_A,
    managed_task_id: '66666666-6666-4666-8666-666666666666',
    managed_question_id: '77777777-7777-4777-8777-777777777777',
    decision_key: 'report.language',
    kind: 'preference',
    question: '报告使用哪种语言？',
    options: OPTIONS,
    constraints: [],
    missing_information: [],
    impact: {
      environment: 'local',
      reversibility: 'reversible',
      affected_resources: ['docs/report.md'],
    },
    action_category: 'write_file',
    input_digest: '',
    status: 'OPEN',
    created_at: PAST,
    expires_at: FUTURE,
    ...over,
  }
  value.input_digest = over.input_digest ?? decisionRequestDigest(value)
  return value
}

function decision(over: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    schema_version: '1.0',
    id: DECISION_ID,
    project_id: PROJECT_A,
    decision_key: 'report.language',
    version: 1,
    statement: '项目报告使用中文。',
    selected_option_id: 'zh',
    options: OPTIONS,
    scope: {
      decision_kinds: ['preference'],
      actions: ['write_file'],
      resource_selectors: ['docs/*'],
      environments: ['local'],
      reversibilities: ['reversible'],
    },
    source_type: 'owner_confirmed',
    source_ref: 'owner-message:1',
    created_by: 'owner',
    valid_from: PAST,
    created_at: PAST,
    ...over,
  }
}

function policy(over: Partial<DelegationPolicyVersion> = {}): DelegationPolicyVersion {
  return {
    schema_version: '1.0',
    id: POLICY_ID,
    policy_id: 'defaults.reversible',
    version: 1,
    project_id: PROJECT_A,
    approved_by_owner: 'owner',
    approved_at: PAST,
    valid_from: PAST,
    rules: [
      {
        id: 'report-language',
        decision_kinds: ['preference'],
        actions: ['write_file'],
        resource_selectors: ['docs/*'],
        environments: ['local'],
        reversibility: 'reversible',
        impact_limits: {
          environments: ['local'],
          reversibilities: ['reversible'],
          max_affected_resources: 8,
        },
        budget_limits: {},
        required_evidence: [],
        required_checks: [],
        mode: 'delegated',
        default_option_id: 'zh',
      },
    ],
    created_at: PAST,
    ...over,
  }
}

function proposal(req: DecisionRequest, over: Partial<TianwenProposal> = {}): TianwenProposal {
  return {
    schema_version: '1.0',
    request_id: req.id,
    request_revision: req.revision,
    input_digest: req.input_digest,
    recommendation: 'answer',
    answer_option_id: 'zh',
    rationale: '依据项目决定',
    claimed_evidence_grade: 'E3',
    basis_refs: [],
    observed_fact_refs: [],
    assumptions: [],
    alternatives: [],
    unresolved_conflicts: [],
    missing_authority: [],
    ...over,
  }
}

function input(over: Partial<DecisionAcceptanceInput> = {}): DecisionAcceptanceInput {
  const req = over.request ?? request()
  return {
    request: req,
    proposal: proposal(req),
    resolution_id: RESOLUTION_ID,
    now: NOW,
    authenticated_caller: {
      actor_type: 'tianwen',
      authenticated_id: 'tianwen-service',
      source: 'model_proposal',
    },
    decisions: [],
    policy: null,
    control: { state: 'active', task_active: true, budget_available: true },
    ...over,
  }
}

describe('确定性决策接纳器', () => {
  it('E3：模型自报 E0 不降级，可信明确决定仍按 E3 接纳', () => {
    const req = request()
    const p = proposal(req, {
      claimed_evidence_grade: 'E0',
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [decision()] }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.disposition).toBe('delegated')
    expect(result.value.evidence_grade).toBe('E3')
    expect(result.value.authority_refs).toEqual([
      { kind: 'project_decision', id: DECISION_ID, version: 1 },
    ])
    expect(result.value.answer).toBe('中文')
  })

  it('E1：模型自报 E3 不升级，只有委托默认时按 E1 接纳', () => {
    const req = request()
    const p = proposal(req, {
      claimed_evidence_grade: 'E3',
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [], policy: policy() }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.disposition).toBe('delegated')
    expect(result.value.evidence_grade).toBe('E1')
    expect(result.value.delegation_policy_id).toBe(POLICY_ID)
  })

  it('自称 E3 但没有任何可信引用 → owner_required', () => {
    const result = acceptDecision(input())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.disposition).toBe('owner_required')
    expect(result.value.evidence_grade).toBe('E0')
    expect(result.value.answer).toBeUndefined()
  })

  it('imported_candidate 不能冒充明确决定', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({
        request: req,
        proposal: p,
        decisions: [decision({ source_type: 'imported_candidate' })],
      }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('项目决定引用不存在时升级人工', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [] }))
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('同一 decision_key 的有效决定答案冲突时升级人工', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const conflict = decision({
      id: '88888888-8888-4888-8888-888888888888',
      version: 2,
      statement: '项目报告改用英文。',
      selected_option_id: 'en',
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [decision(), conflict] }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('同键多条有效决定答案一致时仍可按 E3 接纳', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const duplicate = decision({
      id: '88888888-8888-4888-8888-888888888888',
      version: 2,
      statement: '项目报告继续使用中文。',
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [decision(), duplicate] }),
    )
    expect(result.ok && result.value.disposition).toBe('delegated')
    expect(result.ok && result.value.evidence_grade).toBe('E3')
  })

  it('跨项目决定被拒绝', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({
        request: req,
        proposal: p,
        decisions: [decision({ project_id: PROJECT_B })],
      }),
    )
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it.each([
    ['过期', { valid_until: PAST }],
    ['撤销', { revoked_at: PAST, revoked_by: 'owner', revocation_reason: '不再适用' }],
    ['被替代', { superseded_by: POLICY_ID }],
  ])('项目决定%s时不得代答', (_label, over) => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [decision(over)] }))
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('请求 digest 被改时 fail closed', () => {
    const req = request()
    req.question = '同一个请求被篡改'
    const result = acceptDecision(input({ request: req, decisions: [decision()] }))
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('请求 revision 与提案不一致时 fail closed', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    req.revision = 2
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [decision()] }))
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('请求过期时 fail closed', () => {
    const req = request({ expires_at: PAST })
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [decision()] }))
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('伪造 actor/source 不产生代答', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({
        request: req,
        proposal: p,
        decisions: [decision()],
        authenticated_caller: {
          actor_type: 'human',
          authenticated_id: 'forged-owner',
          source: 'policy_default',
        },
      }),
    )
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('候选 payload 自带 actor 字段会被 schema 拒绝', () => {
    const req = request()
    const forged = {
      ...proposal(req),
      actor: { type: 'human', authenticated_id: 'forged-owner' },
    }
    expect(validateTianwenProposal(forged).ok).toBe(false)
  })

  it('策略 deny 即使存在 E3 决定也拒绝', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [
        { kind: 'project_decision', id: DECISION_ID, version: 1 },
        { kind: 'delegation_policy', id: POLICY_ID, version: 1 },
      ],
    })
    const deny = policy({
      rules: [
        {
          id: 'deny-report',
          decision_kinds: ['preference'],
          actions: ['write_file'],
          resource_selectors: ['docs/*'],
          environments: ['local'],
          reversibility: 'reversible',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['reversible'],
            max_affected_resources: 8,
          },
          budget_limits: {},
          required_evidence: [],
          required_checks: [],
          mode: 'deny',
        },
      ],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [decision()], policy: deny }),
    )
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('E1 不覆盖不可逆影响', () => {
    const req = request({
      impact: {
        environment: 'local',
        reversibility: 'partially_reversible',
        affected_resources: ['docs/report.md'],
      },
    })
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const partial = policy({
      rules: [
        {
          id: 'partial',
          decision_kinds: ['preference'],
          actions: ['write_file'],
          resource_selectors: ['docs/*'],
          environments: ['local'],
          reversibility: 'partially_reversible',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['partially_reversible'],
            max_affected_resources: 8,
          },
          budget_limits: {},
          required_evidence: [],
          required_checks: [],
          mode: 'delegated',
          default_option_id: 'zh',
        },
      ],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [], policy: partial }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it.each([
    ['过期', { valid_until: PAST }],
    ['撤销', { revoked_at: PAST, revoked_by: 'owner', revocation_reason: '授权结束' }],
  ])('委托策略%s时不得走 E1', (_label, over) => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [], policy: policy(over) }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('跨项目委托策略被拒绝', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({
        request: req,
        proposal: p,
        decisions: [],
        policy: policy({ project_id: PROJECT_B }),
      }),
    )
    expect(result.ok && result.value.disposition).toBe('denied')
  })

  it('委托策略引用版本不是当前可信版本时升级人工', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 2 }],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [], policy: policy() }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('相同选项 ID 但文案改变时旧决定不适用', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const changed = decision({
      options: [
        { id: 'zh', text: '简体中文' },
        { id: 'en', text: '英文' },
      ],
    })
    const result = acceptDecision(input({ request: req, proposal: p, decisions: [changed] }))
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('提案未采用策略默认时不静默改写答案', () => {
    const req = request()
    const p = proposal(req, {
      answer_option_id: 'en',
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({ request: req, proposal: p, decisions: [], policy: policy() }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })

  it('未解决冲突或任务控制不允许时 fail closed', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
      unresolved_conflicts: ['两份决定冲突'],
    })
    const conflict = acceptDecision(input({ request: req, proposal: p, decisions: [decision()] }))
    expect(conflict.ok && conflict.value.disposition).toBe('owner_required')
    const pausedReq = request()
    const pausedProposal = proposal(pausedReq, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const paused = acceptDecision(
      input({
        request: pausedReq,
        proposal: pausedProposal,
        decisions: [decision()],
        control: { state: 'paused', task_active: true, budget_available: true },
      }),
    )
    expect(paused.ok && paused.value.disposition).toBe('denied')
  })

  it('同输入重复接纳得到深相等的决议', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const value = input({ request: req, proposal: p, decisions: [decision()] })
    const first = acceptDecision(value)
    const second = acceptDecision(value)
    expect(first).toEqual(second)
    expect(req.input_digest).toBe(decisionRequestDigest(req))
  })

  it('空资源列表和提案 request_id 不匹配都 fail closed', () => {
    const empty = request({
      impact: {
        environment: 'local',
        reversibility: 'reversible',
        affected_resources: [] as unknown as [string, ...string[]],
      },
    })
    const result = acceptDecision(
      input({
        request: empty,
        proposal: proposal(empty, {
          basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
        }),
        policy: policy(),
      }),
    )
    expect(result.ok).toBe(false)

    const req = request()
    const forged = proposal(req, {
      request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      basis_refs: [{ kind: 'project_decision', id: DECISION_ID, version: 1 }],
    })
    const denied = acceptDecision(
      input({ request: req, proposal: forged, decisions: [decision()] }),
    )
    expect(denied.ok && denied.value.disposition).toBe('denied')
  })

  it('多份委托策略取最严格处置，required_checks 不会被静默忽略', () => {
    const req = request()
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const otherPolicy = policy({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      policy_id: 'other.defaults',
      rules: [
        {
          ...policy().rules[0],
          id: 'other-rule',
          impact_limits: {
            environments: ['local'],
            reversibilities: ['reversible'],
            max_affected_resources: 8,
          },
          required_checks: ['review:security'],
        },
      ],
    })
    const owner = acceptDecision(
      input({
        request: req,
        proposal: p,
        policies: [policy(), otherPolicy],
      }),
    )
    expect(owner.ok && owner.value.disposition).toBe('owner_required')

    const denyPolicy = policy({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      policy_id: 'deny.defaults',
      rules: [{ ...policy().rules[0], id: 'deny-all', mode: 'deny' }],
    })
    const denied = acceptDecision(
      input({
        request: req,
        proposal: p,
        policies: [policy(), denyPolicy],
      }),
    )
    expect(denied.ok && denied.value.disposition).toBe('denied')
  })

  it('approval 类问题没有执行网关核对时必须人工决定', () => {
    const req = request({ kind: 'approval' })
    const p = proposal(req, {
      basis_refs: [{ kind: 'delegation_policy', id: POLICY_ID, version: 1 }],
    })
    const result = acceptDecision(
      input({
        request: req,
        proposal: p,
        policy: policy({
          rules: [
            {
              ...policy().rules[0],
              decision_kinds: ['approval'],
            },
          ],
        }),
      }),
    )
    expect(result.ok && result.value.disposition).toBe('owner_required')
  })
})
