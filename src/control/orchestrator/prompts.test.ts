/**
 * 提示词回归 —— #1-01:rfc_draft 不得预置/暗示 policy_facts 的具体取值。
 *
 * policy_facts 是 Policy 的输入,必须由模型按 RFC 真实内容填写;
 * 提示词只给形状(键结构与取值枚举),不替模型做裁决。
 */

import { describe, expect, it } from 'vitest'
import { promptFor } from './prompts.js'

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

  it('明确要求如实填写', () => {
    expect(prompt).toContain('必须按 RFC 的真实内容填写')
  })
})
