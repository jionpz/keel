import { describe, expect, it } from 'vitest'
import type { DelegationPolicyVersion } from '../../generated/managed.js'
import { type ActionAuthorizationRequest, authorizeAction } from './action-authorization.js'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const POLICY = '22222222-2222-4222-8222-222222222222'

function request(overrides: Partial<ActionAuthorizationRequest> = {}): ActionAuthorizationRequest {
  return {
    project_id: PROJECT,
    action: 'push_and_pr',
    environment: 'production',
    reversibility: 'reversible',
    affected_resources: ['https://github.com/acme/widget.git', 'branch:ai/test'],
    now: '2026-11-11T00:00:00.000Z',
    ...overrides,
  }
}

function policy(
  overrides: Partial<DelegationPolicyVersion> = {},
  rule: Partial<DelegationPolicyVersion['rules'][number]> = {},
): DelegationPolicyVersion {
  return {
    schema_version: '1.0',
    id: POLICY,
    policy_id: 'ticket-delivery',
    version: 1,
    project_id: PROJECT,
    approved_by_owner: 'owner',
    approved_at: '2026-11-01T00:00:00.000Z',
    valid_from: '2026-11-01T00:00:00.000Z',
    rules: [
      {
        id: 'push-pr',
        decision_kinds: ['approval'],
        actions: ['push_and_pr'],
        resource_selectors: ['*'],
        environments: ['production'],
        reversibility: 'reversible',
        impact_limits: {
          environments: ['production'],
          reversibilities: ['reversible'],
          max_affected_resources: 8,
        },
        budget_limits: {},
        required_evidence: [],
        required_checks: [],
        mode: 'delegated',
        ...rule,
      },
    ],
    created_at: '2026-11-01T00:00:00.000Z',
    ...overrides,
  } as unknown as DelegationPolicyVersion
}

describe('managed action authorization', () => {
  it('匹配 delegated 规则时返回策略版本与稳定摘要', () => {
    const first = authorizeAction(request(), [policy()])
    const second = authorizeAction(request(), [policy()])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      ok: true,
      policy_id: POLICY,
      policy_version: 1,
      rule_id: 'push-pr',
    })
    if (first.ok) expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('撤销、替代或过期的策略不能授权', () => {
    expect(
      authorizeAction(request(), [policy({ revoked_at: '2026-11-10T00:00:00.000Z' })]).ok,
    ).toBe(false)
    expect(
      authorizeAction(request(), [
        policy({ superseded_by: '33333333-3333-4333-8333-333333333333' }),
      ]).ok,
    ).toBe(false)
    expect(
      authorizeAction(request(), [policy({ valid_until: '2026-11-10T00:00:00.000Z' })]).ok,
    ).toBe(false)
  })

  it('更严格的规则优先于 delegated', () => {
    const delegated = policy()
    const ownerRequired = policy(
      { id: '44444444-4444-4444-8444-444444444444', version: 2 },
      { id: 'owner', mode: 'owner_required' },
    )
    const denied = policy(
      { id: '55555555-5555-4555-8555-555555555555', version: 3 },
      { id: 'deny', mode: 'deny' },
    )
    expect(authorizeAction(request(), [delegated, ownerRequired])).toMatchObject({
      ok: false,
      restrictive: true,
    })
    expect(authorizeAction(request(), [delegated, denied])).toMatchObject({
      ok: false,
      restrictive: true,
    })
  })

  it('required_checks 随许可返回，required_evidence 仍拒绝自动许可', () => {
    expect(authorizeAction(request(), [policy({}, { required_checks: ['ci'] })])).toMatchObject({
      ok: true,
      required_checks: ['ci'],
    })
    expect(authorizeAction(request(), [policy({}, { required_evidence: ['diff'] })]).ok).toBe(false)
  })

  it('多个匹配 delegated 规则的 required_checks 取并集', () => {
    const second = policy(
      { id: '66666666-6666-4666-8666-666666666666', version: 2 },
      { id: 'checks-2', required_checks: ['integration', 'ci'] },
    )
    expect(
      authorizeAction(request(), [policy({}, { required_checks: ['ci'] }), second]),
    ).toMatchObject({
      ok: true,
      required_checks: ['ci', 'integration'],
    })
  })

  it('required_checks 并集超过 16 条时拒绝自动许可', () => {
    const first = policy(
      {},
      {
        required_checks: [
          'check-00',
          'check-01',
          'check-02',
          'check-03',
          'check-04',
          'check-05',
          'check-06',
          'check-07',
          'check-08',
          'check-09',
          'check-10',
          'check-11',
          'check-12',
          'check-13',
          'check-14',
          'check-15',
        ],
      },
    )
    const second = policy(
      { id: '77777777-7777-4777-8777-777777777777', version: 2 },
      { id: 'checks-2', required_checks: ['overflow'] },
    )
    expect(authorizeAction(request(), [first, second])).toMatchObject({
      ok: false,
      restrictive: true,
    })
  })

  it('资源、环境或可逆性不匹配时拒绝', () => {
    expect(
      authorizeAction(request({ affected_resources: ['https://github.com/acme/other.git'] }), [
        policy({}, { resource_selectors: ['https://github.com/acme/widget.git'] }),
      ]).ok,
    ).toBe(false)
    expect(authorizeAction(request({ environment: 'staging' }), [policy()]).ok).toBe(false)
    expect(authorizeAction(request({ reversibility: 'irreversible' }), [policy()]).ok).toBe(false)
  })
})
