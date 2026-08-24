/**
 * validate 第 4 步 Policy 求值 —— #1-02。
 *
 * 旧实现:capability_allowed 恒 true,validate 第 4 步空返回 ——
 * capability_request 提案不经任何授权就落库。现在:
 *   1. validate 第 4 步对需要授权的 kind 求值 Policy,缺裁决拒收
 *   2. T-009 守卫现场求值(见 driver 测试),不再恒 true
 *
 * 纯单测:fake PolicyEngine + fake client,不连 DB。
 */

import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import type { Proposal, SchemaViolation } from '../../contracts/types.js'
import type { APolicyDecision } from '../../generated/artifacts.js'
import { validateProposal } from './validate.js'

const NOW = '2026-08-24T12:00:00Z'

/** fake client:只回答 capability_request 的 facts;其它抛错 */
const client = {
  query: async (sql: string) => {
    if (sql.includes("kind = 'rfc'")) throw new Error('不应查 RFC')
    if (sql.includes('FROM run')) return { rows: [] }
    throw new Error(`未预期的查询:${sql.slice(0, 60)}`)
  },
} as unknown as PoolClient

const proposal: Proposal = {
  proposal_id: 'p1',
  task_id: 't1',
  kind: 'capability_request',
  key: 'creq_1',
  body: {
    schema_version: '1.0',
    request_id: 'creq_1',
    requested_by_run: 'run:b',
    capability: 'critic_review',
    params: {},
    rationale: '需要 Critic 评审',
    blocking: true,
  },
  supersedes: null,
  produced_by_run: 'run-b',
}

/** fake Policy:固定返回一个裁决 */
function engineWith(decision: string): PolicyEngine {
  return {
    evaluate: (): { ok: true; value: APolicyDecision } => ({
      ok: true,
      value: {
        schema_version: '1.0',
        decision_point: 'capability_request',
        policy_version: 'test',
        evaluated_at: NOW,
        facts_snapshot: {},
        matched_rules: [],
        decision: decision as APolicyDecision['decision'],
        reason: 'test',
        default_applied: decision === 'human_review',
      },
    }),
    validate: () => ({ ok: true, errors: [], warnings: [] }),
  }
}

function denied(verdict: { accepted: boolean; violations: readonly SchemaViolation[] }): boolean {
  return !verdict.accepted && verdict.violations.some((v) => v.rule === 'policy-denied')
}

describe('validate 第 4 步 · capability_request 授权', () => {
  it('缺 Policy 引擎 → 拒收(policy-unavailable),不默认放行', async () => {
    const r = await validateProposal(proposal, { client })
    expect(r.accepted).toBe(false)
    expect(r.violations.some((v) => v.rule === 'policy-unavailable')).toBe(true)
  })

  it('裁决 human_review(默认 deny)→ 拒收(policy-denied)', async () => {
    const r = await validateProposal(proposal, {
      client,
      policy: engineWith('human_review'),
      now: NOW,
    })
    expect(denied(r)).toBe(true)
  })

  it('裁决 security_review → 拒收(policy-denied)', async () => {
    const r = await validateProposal(proposal, {
      client,
      policy: engineWith('security_review'),
      now: NOW,
    })
    expect(denied(r)).toBe(true)
  })

  it('裁决 auto_develop → 通过', async () => {
    const r = await validateProposal(proposal, {
      client,
      policy: engineWith('auto_develop'),
      now: NOW,
    })
    expect(r.accepted).toBe(true)
    expect(r.violations).toEqual([])
  })

  it('无需授权的 kind(如 state)不触发 Policy 求值', async () => {
    const state: Proposal = {
      ...proposal,
      kind: 'state',
      body: {
        schema_version: '1.0',
        current_goal: 'g',
        confirmed_facts: [],
        decisions: [],
        open_questions: [],
        risks: [],
      },
    }
    const r = await validateProposal(state, { client })
    expect(r.accepted).toBe(true) // 无 policy 也过 —— 该 kind 不需要授权
  })
})
