import { describe, expect, it } from 'vitest'
import {
  commitPolicyFromRow,
  type RepoCommitPolicy,
  renderCommitMessage,
  validateCommitPolicy,
  validateStoredCommitMessage,
} from './commit-policy.js'

const policy: RepoCommitPolicy = {
  commit_message_template: '{type}({scope}): {summary}',
  commit_types: ['fix', 'feat'],
  commit_scopes: ['control', 'fact'],
}
const fields = { type: 'fix', scope: 'control', summary: '修复重试反馈' }
const run = '12345678-1234-4000-8000-123456789abc'

describe('仓库提交规范', () => {
  it('未配置的 header 逐字保持旧格式且没有正文', () => {
    expect(renderCommitMessage({}, 'develop', run, {})).toEqual({
      ok: true,
      value: 'develop: run 12345678',
    })
    expect(
      commitPolicyFromRow({ commit_author: null, commit_message_check: null, id: 'ignored' }),
    ).toEqual({ ok: true, value: {} })
  })
  it('模板保留中文并生成普通正文行；实际消息可再校验', () => {
    const message = `fix(control): 修复重试反馈\n\nKeel-Run: ${run} stage=develop`
    expect(renderCommitMessage(policy, 'develop', run, { commit_message: fields })).toEqual({
      ok: true,
      value: message,
    })
    expect(validateStoredCommitMessage(policy, message).ok).toBe(true)
    expect(validateStoredCommitMessage(policy, 'fix(control): 没有运行信息').ok).toBe(false)
    expect(validateStoredCommitMessage(policy, message.replace('fix(', 'other(')).ok).toBe(false)
  })
  it.each([
    {},
    { ...fields, type: 'chore' },
    { ...fields, scope: 'other' },
    { ...fields, summary: '' },
    { ...fields, summary: ' 首尾空白' },
    { ...fields, summary: 'a\nb' },
    { ...fields, summary: 'a\0b' },
    { ...fields, summary: '中'.repeat(73) },
  ])('缺字段、越过闭合枚举、非法 summary 均被拒绝：%j', (commit_message) => {
    expect(renderCommitMessage(policy, 'develop', run, { commit_message })).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('commit_message_rejected:') },
    })
  })
  it('模板占位符相邻或含正则字符时仍可核对真实消息', () => {
    for (const template of ['{type}{scope}{summary}', '[{scope}] {summary} ({type})']) {
      const result = renderCommitMessage(
        { ...policy, commit_message_template: template },
        'develop',
        run,
        { commit_message: fields },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.detail)
      expect(
        validateStoredCommitMessage({ ...policy, commit_message_template: template }, result.value),
      ).toEqual({ ok: true, value: undefined })
    }
  })
  it('相邻枚举存在后缀歧义时，合法的最长 summary 仍能回读', () => {
    const ambiguous: RepoCommitPolicy = {
      commit_message_template: '{summary}{scope}{type}',
      commit_types: ['fix'],
      commit_scopes: ['ab', 'b'],
    }
    const rendered = renderCommitMessage(ambiguous, 'develop', run, {
      commit_message: { type: 'fix', scope: 'ab', summary: 'x'.repeat(72) },
    })
    if (!rendered.ok) throw new Error(rendered.error.detail)
    expect(validateStoredCommitMessage(ambiguous, rendered.value)).toEqual({
      ok: true,
      value: undefined,
    })
  })
  it('按 Unicode 字符数限制 summary 与整个 header', () => {
    expect(
      renderCommitMessage(policy, 'develop', run, {
        commit_message: { ...fields, summary: '😀'.repeat(72) },
      }).ok,
    ).toBe(true)
    expect(
      renderCommitMessage(
        {
          ...policy,
          commit_message_template: `prefix-long-long-long-long-{type}({scope}): {summary}`,
        },
        'develop',
        run,
        { commit_message: { ...fields, summary: '中'.repeat(72) } },
      ).ok,
    ).toBe(false)
  })
  it.each([
    { commit_author: 'bad' },
    { commit_author: ' Bot <bot@example.com>' },
    { commit_author: 'Bot  <bot@example.com>' },
    { commit_author: '  <bot@example.com>' },
    { commit_author: 'Bot. <bot@example.com>' },
    { commit_author: '"Bot" <bot@example.com>' },
    { commit_author: 'Bot <bot@example.com.>' },
    { commit_author: 'X\nY <a@b>' },
    { commit_author: 'X\0Y <a@b>' },
    { commit_message_check: '[' },
    { ...policy, commit_message_template: '{type}: {summary}' },
    { ...policy, commit_message_template: '{type}({scope}): {summary} {other}' },
    { ...policy, commit_message_template: '{type}({scope}): {summary}{type}' },
    { commit_message_template: '{type}({scope}): {summary}' },
    { ...policy, commit_types: ['fix', 'fix'] },
    { ...policy, commit_scopes: [] },
  ])('非法配置不能注册：%j', (value) => {
    expect(validateCommitPolicy(value).ok).toBe(false)
  })
  it('支持有效 header 正则、hook 与指定身份', () => {
    for (const commit_message_check of ['hook', '^fix\\(control\\): .+$']) {
      expect(
        validateCommitPolicy({
          ...policy,
          commit_author: '机器人 <bot@example.com>',
          commit_message_check,
        }).ok,
      ).toBe(true)
    }
  })
})
