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

/**
 * 第 4b 步接线 —— 光有 feedback-constraints.ts 的纯函数不算数,
 * 必须证明它真的挂在 validateProposal 上(父任务 AC5)。
 */
describe('validate 第 4b 步 · RFC 不得越出反馈显式声明的范围', () => {
  /** fake client:只回答 ContextBuilder 同源的 feedback 查询 */
  function clientWithFeedback(bodies: readonly string[]): PoolClient {
    return {
      query: async (sql: string) => {
        if (sql.includes('FROM feedback f')) return { rows: bodies.map((body) => ({ body })) }
        throw new Error(`未预期的查询:${sql.slice(0, 60)}`)
      },
    } as unknown as PoolClient
  }

  function rfc(facts: {
    risk: string
    complexity: string
    estimated_files_changed: number
    security_related: boolean
  }): Proposal {
    return {
      proposal_id: 'p-rfc',
      task_id: 't1',
      kind: 'rfc',
      key: '',
      body: {
        schema_version: '1.0',
        title: 'README 补一句',
        problem: '导出筛选未写进文档',
        goals: ['补一句说明'],
        non_goals: ['改代码'],
        proposed_change: {
          summary: '改 README.md 一处',
          affected_areas: ['README.md'],
          approach: '追加一行',
        },
        acceptance_criteria: [{ id: 'AC1', text: 'README 含该句', verifiable_by: '人工核对' }],
        policy_facts: facts,
      },
      supersedes: null,
      produced_by_run: 'run-rfc',
    }
  }

  const declaring = '约束:\n- risk=low\n- complexity=low\n- estimated_files=1'

  it('自报 high 而反馈写死 low → 拒收并回灌(不留给 Policy 兜)', async () => {
    const r = await validateProposal(
      rfc({
        risk: 'high',
        complexity: 'high',
        estimated_files_changed: 1,
        security_related: false,
      }),
      { client: clientWithFeedback([declaring]) },
    )
    expect(r.accepted).toBe(false)
    expect(r.violations.map((v) => v.path)).toEqual([
      'policy_facts.risk',
      'policy_facts.complexity',
    ])
    expect(r.violations.every((v) => v.rule === 'declared-scope')).toBe(true)
  })

  it('原样采用声明值 → 通过', async () => {
    const r = await validateProposal(
      rfc({ risk: 'low', complexity: 'low', estimated_files_changed: 1, security_related: false }),
      { client: clientWithFeedback([declaring]) },
    )
    expect(r.accepted).toBe(true)
  })

  it('反馈未声明约束 → 不干预模型自评估', async () => {
    const r = await validateProposal(
      rfc({
        risk: 'high',
        complexity: 'high',
        estimated_files_changed: 40,
        security_related: true,
      }),
      { client: clientWithFeedback(['导出的 Excel 希望能够按照日期筛选']) },
    )
    expect(r.accepted).toBe(true)
  })

  it('task 无关联 feedback → 空操作,不报错', async () => {
    const r = await validateProposal(
      rfc({ risk: 'high', complexity: 'low', estimated_files_changed: 3, security_related: false }),
      { client: clientWithFeedback([]) },
    )
    expect(r.accepted).toBe(true)
  })
})
