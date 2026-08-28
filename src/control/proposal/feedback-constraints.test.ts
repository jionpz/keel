/**
 * 反馈显式约束的解析与核对 —— 纯函数,不连 DB。
 *
 * 背景:父任务 AC5 两次真实运行都因 rfc_draft 自报 risk=high 被 P1 拦下,
 * 而 Issue 正文写死了 risk=low。这里锁住「显式声明必须被采用」这条机制。
 */

import { describe, expect, it } from 'vitest'
import {
  declaredFactsDirective,
  parseDeclaredPolicyFacts,
  policyFactsConflicts,
} from './feedback-constraints.js'

/** 与 src/acceptance/issue-e2e.acceptance.test.ts 的 ISSUE_BODY 同构 */
const ACCEPTANCE_BODY = [
  '目标:只改 README.md 一处文档,补一句「导出支持按日期筛选」。',
  '约束(必须遵守,写进 RFC.policy_facts):',
  '- risk=low',
  '- complexity=low',
  '- estimated_files=1',
  '- security_sensitive=false',
  '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
  '这是验收探针,不是架构变更。',
].join('\n')

describe('parseDeclaredPolicyFacts', () => {
  it('解析验收 Issue 正文里的四项约束', () => {
    expect(parseDeclaredPolicyFacts(ACCEPTANCE_BODY)).toEqual({
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 1,
      security_related: false,
    })
  })

  it('接受全角冒号与 estimated_files_changed 别名', () => {
    expect(parseDeclaredPolicyFacts('risk：high\nestimated_files_changed: 12')).toEqual({
      risk: 'high',
      estimated_files_changed: 12,
    })
  })

  it('自由文本里的风险描述不算声明 —— 不替模型做裁决', () => {
    expect(parseDeclaredPolicyFacts('这个改动风险不大,应该很简单,只动一两个文件')).toEqual({})
  })

  it('不把 security_risk= 之类的复合键误读成 risk=', () => {
    expect(parseDeclaredPolicyFacts('security_risk=high')).toEqual({})
  })

  it('同一键多次出现取第一次', () => {
    expect(parseDeclaredPolicyFacts('risk=low\n后来又说 risk=high').risk).toBe('low')
  })
})

describe('policyFactsConflicts', () => {
  const declared = parseDeclaredPolicyFacts(ACCEPTANCE_BODY)

  it('RFC 原样采用声明值 → 无冲突', () => {
    const body = {
      policy_facts: {
        risk: 'low',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
      },
    }
    expect(policyFactsConflicts(declared, body)).toEqual([])
  })

  it('RFC 自报 high(父任务的真实失败形态)→ 逐项拒绝', () => {
    const body = {
      policy_facts: {
        risk: 'high',
        complexity: 'high',
        estimated_files_changed: 0,
        security_related: false,
      },
    }
    const v = policyFactsConflicts(declared, body)
    expect(v.map((x) => x.path)).toEqual([
      'policy_facts.risk',
      'policy_facts.complexity',
      'policy_facts.estimated_files_changed',
    ])
    expect(v.every((x) => x.rule === 'declared-scope')).toBe(true)
    // 回灌文本必须可操作:说清反馈写了什么、RFC 写了什么、怎么改
    expect(v[0]?.message).toContain('"low"')
    expect(v[0]?.message).toContain('"high"')
    expect(v[0]?.message).toContain('non_goals')
  })

  it('反馈未声明任何约束 → 不干预模型自评估', () => {
    const body = { policy_facts: { risk: 'high', complexity: 'high' } }
    expect(policyFactsConflicts({}, body)).toEqual([])
  })

  it('body 缺 policy_facts(schema 已在第 1 步拦下)→ 空操作,不抛错', () => {
    expect(policyFactsConflicts(declared, { title: 't' })).toEqual([])
    expect(policyFactsConflicts(declared, null)).toEqual([])
  })
})

describe('declaredFactsDirective', () => {
  const declared = parseDeclaredPolicyFacts(ACCEPTANCE_BODY)

  it('渲染出的字面值与 policyFactsConflicts 认可的取值一致', () => {
    const text = declaredFactsDirective(declared) ?? ''
    // 指令里出现的每个键值,原样填进 RFC 后都必须过 4b —— 否则提示词在骗模型
    const body = { policy_facts: { ...declared } }
    expect(policyFactsConflicts(declared, body)).toEqual([])
    for (const [k, v] of Object.entries(declared)) {
      expect(text, `应含 ${k}`).toContain(`"${k}": ${JSON.stringify(v)}`)
    }
  })

  it('无声明 → null,调用方据此不追加任何内容', () => {
    expect(declaredFactsDirective({})).toBeNull()
  })

  it('给出越界内容的去处,而不是只说「不许超」', () => {
    expect(declaredFactsDirective(declared)).toContain('non_goals')
  })
})
