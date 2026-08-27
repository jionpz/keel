/**
 * 提示词回归 —— #1-01:rfc_draft 不得预置/暗示 policy_facts 的具体取值。
 *
 * policy_facts 是 Policy 的输入,必须由模型按 RFC 真实内容填写;
 * 提示词只给形状(键结构与取值枚举),不替模型做裁决。
 */

import { describe, expect, it } from 'vitest'
import { expectedArtifact, promptFor } from './prompts.js'

describe('promptFor · rfc_draft 的 policy_facts', () => {
  const prompt = promptFor('rfc_draft', 'run-1')

  it('形状仍给出 policy_facts 键结构与取值枚举', () => {
    expect(prompt).toContain('"policy_facts"')
    expect(prompt).toContain('"risk":"<low|medium|high>"')
    expect(prompt).toContain('"security_related":<true|false>')
  })

  it('不预置任何具体取值 —— 不替模型做裁决', () => {
    // 旧版写死的 "risk":"low" / "complexity":"low" / 1 / false 连写
    expect(prompt).not.toContain('"risk":"low"')
    expect(prompt).not.toContain('"complexity":"low"')
    expect(prompt).not.toContain('"estimated_files_changed":1')
    // 「这是一个低风险、低复杂度、非安全相关的小改动」这类断言也不该出现
    expect(prompt).not.toContain('低风险')
    expect(prompt).not.toContain('非安全相关')
  })

  it('明确要求如实填写(不套固定取值,不为放行压低也不为保险抬高)', () => {
    const rfcPrompt = promptFor('rfc_draft', 'run-1')
    expect(rfcPrompt).toContain('不要为了保险而抬高')
    expect(rfcPrompt).toContain('不要为了放行而压低')
    expect(rfcPrompt).toContain('全部依据')
  })
})

describe('promptFor · critic 的结构化评审(#1-15)', () => {
  const prompt = promptFor('critic', 'run-c1')

  it('期望产物是 critic_review 而非 stage_outcome', () => {
    expect(expectedArtifact('critic')).toEqual({ kind: 'critic_review', key: 'latest' })
  })

  it('提示词给出 critic_review 的关键字段形状', () => {
    for (const field of [
      'review_type',
      'subject_ref',
      'scale',
      'criteria',
      'scores',
      'findings',
      'recommendation',
      'confidence',
    ]) {
      expect(prompt, `应含字段 ${field}`).toContain(field)
    }
  })

  it('要求覆盖所有候选方案并如实报置信度', () => {
    expect(prompt).toContain('必须覆盖被评审的每个候选方案')
    expect(prompt).toContain('confidence')
  })
})

describe('promptFor · rfc_draft 的方案来源聚焦(issue #25)', () => {
  const prompt = promptFor('rfc_draft', 'run-r1')

  it('明确方案来自用户反馈 + A-State 候选,不是项目整体', () => {
    expect(prompt).toContain('用户反馈')
    expect(prompt).toContain('candidate_options')
    expect(prompt).toContain('不要给整个项目写')
  })

  it('要求如实评估,不预设方向', () => {
    expect(prompt).toContain('按 RFC 的真实内容评估')
    expect(prompt).toContain('不要为了保险而抬高')
  })
})

/**
 * AC5 阻塞点(2026-08-27):两次真实运行里 Issue 正文写死 risk=low,
 * rfc_draft 仍自报 high 被 P1 拦到 S-HUMAN_REVIEW。提示词必须把
 * 「反馈给出的约束优先于自评估」讲成硬要求 —— 机械核对在
 * src/control/proposal/feedback-constraints.ts。
 */
describe('promptFor · rfc_draft 服从反馈显式声明的约束(AC5)', () => {
  const prompt = promptFor('rfc_draft', 'run-r2')

  it('反馈给出约束时要求原样采用,且优先于自评估', () => {
    expect(prompt).toContain('原样采用')
    expect(prompt).toContain('优先于你的自评估')
  })

  it('列出被识别的约束键名 —— 与解析器认的别名一致', () => {
    for (const key of ['risk=', 'complexity=', 'estimated_files=', 'security_sensitive=']) {
      expect(prompt, `应提到约束键 ${key}`).toContain(key)
    }
  })

  it('把「反馈未给出」单列一档,不与「已给出」混为一谈', () => {
    expect(prompt).toContain('已显式给出')
    expect(prompt).toContain('未给出')
  })

  it('仍不预置任何具体取值', () => {
    expect(prompt).not.toContain('"risk":"low"')
    expect(prompt).not.toContain('"complexity":"low"')
  })

  // 2026-08-27 第三次真实运行:模型给 policy_facts 加了 `note` 字段,
  // 被 additionalProperties:false 连拒 3 次 → T-031 升人工。
  it('声明 policy_facts 只此四键 —— 额外字段会被 schema 拒', () => {
    expect(prompt).toContain('只允许上面这四个键')
    expect(prompt).toContain('note')
  })
})
