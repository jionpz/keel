import { describe, expect, it } from 'vitest'
import type { RepoCommitPolicy } from '../shared/commit-policy.js'
import {
  pullRequestBody,
  pullRequestSections,
  pullRequestTitle,
  renderPullRequestBody,
} from './pr-description.js'

const TEMPLATE: RepoCommitPolicy = {
  commit_message_template: '{type}({scope}): {summary}',
  commit_types: ['feat', 'fix'],
  commit_scopes: ['control', 'fact'],
}

function headings(body: string): string[] {
  return [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1] as string)
}

describe('PR 标题生成', () => {
  it('未配置提交模板时沿用 issue 标题', () => {
    expect(pullRequestTitle({ issueTitle: '修复 PR 描述', policy: {} })).toBe('修复 PR 描述')
    expect(
      pullRequestTitle({
        issueTitle: '修复 PR 描述',
        policy: TEMPLATE,
      }),
    ).toBe('修复 PR 描述')
  })

  it('配置模板后按同一模板渲染 header', () => {
    expect(
      pullRequestTitle({
        issueTitle: '来源 issue 标题',
        policy: TEMPLATE,
        commitMessage: { type: 'fix', scope: 'fact', summary: '修复 PR 描述' },
      }),
    ).toBe('fix(fact): 修复 PR 描述')
  })

  it('先压缩空白再截断到 header 上限', () => {
    const policy: RepoCommitPolicy = {
      ...TEMPLATE,
      commit_message_template: '{type}({scope}): [固定前缀固定前缀固定前缀固定前缀] {summary}',
    }
    const title = pullRequestTitle({
      issueTitle: '来源 issue 标题',
      policy,
      commitMessage: { type: 'fix', scope: 'fact', summary: ` 修复   PR\n描述 ${'长'.repeat(80)}` },
    })
    expect([...title].length).toBe(100)
    expect(title.startsWith('fix(fact): [固定前缀固定前缀固定前缀固定前缀] 修复 PR 描述 ')).toBe(
      true,
    )
    expect(title).not.toContain('\n')
  })

  it('header 正则不通过时退回 issue 标题', () => {
    expect(
      pullRequestTitle({
        issueTitle: '来源 issue 标题',
        policy: { ...TEMPLATE, commit_message_check: '^feat\\(' },
        commitMessage: { type: 'fix', scope: 'fact', summary: '修复 PR 描述' },
      }),
    ).toBe('来源 issue 标题')
  })
})

describe('PR 正文章节', () => {
  const facts = {
    rfc: {
      ref: 'artifact:rfc@2',
      body: {
        problem: '根因文本',
        proposed_change: {
          summary: '摘要文本',
          approach: '方案文本',
          affected_areas: ['control'],
        },
      },
    },
    develop: {
      ref: 'artifact:stage_outcome/develop@1',
      body: { reason: '实现了 PR 描述' },
    },
    qa: {
      ref: 'artifact:stage_outcome/qa@1',
      body: { verdict: 'pass', reason: '测试通过' },
    },
    review: {
      ref: 'artifact:stage_outcome/review@1',
      body: { verdict: 'pass', reason: '评审通过' },
    },
    state: {
      ref: 'artifact:state@4',
      body: { risks: [{ text: '风险 A', severity: 'low', mitigation: '缓解 A' }] },
    },
  } as const

  it('从落库产物生成问题、根因、改动、验证与风险', () => {
    const sections = pullRequestSections({
      issueTitle: '来源 issue 标题',
      issueSource: 'ticket:task-1',
      facts,
      fallbackChanges: '分支事实',
      fallbackChangesSource: 'git:task-1',
    })
    const body = renderPullRequestBody({ taskId: 'task-1', sections })
    expect(headings(body)).toEqual(['问题', '根因', '改动', '验证', '风险与未做'])
    expect(body).toContain('来源：ticket:task-1')
    expect(body).toContain('来源：artifact:rfc@2')
    expect(body).toContain('来源：artifact:stage_outcome/qa@1, artifact:stage_outcome/review@1')
    expect(body).toContain('来源：artifact:state@4')
    expect(body).toContain('实现了 PR 描述')
    expect(body).toContain('风险 A')
  })

  it('缺少产物的章节整节省略，不写占位文字', () => {
    const sections = pullRequestSections({
      issueTitle: '来源 issue 标题',
      issueSource: 'ticket:task-1',
      facts: {},
      fallbackChanges: '分支事实',
      fallbackChangesSource: 'git:task-1',
    })
    const body = renderPullRequestBody({ taskId: 'task-1', sections })
    expect(headings(body)).toEqual(['问题', '改动'])
    expect(body).not.toContain('根因')
    expect(body).not.toContain('验证')
    expect(body).not.toContain('占位')
  })

  it('Review 未处理风险进入风险与未做', () => {
    const sections = pullRequestSections({
      issueTitle: '来源 issue 标题',
      issueSource: 'ticket:task-1',
      facts: {
        review: {
          ref: 'artifact:stage_outcome/review@2',
          body: {
            verdict: 'fail',
            reason: '仍有风险',
            details: { failed_criteria: ['AC1'] },
          },
        },
      },
      fallbackChanges: '分支事实',
      fallbackChangesSource: 'git:task-1',
    })
    const body = renderPullRequestBody({ taskId: 'task-1', sections })
    // 失败结论同样属于验证事实，照实写进「验证」，未处理的风险再进「风险与未做」。
    expect(headings(body)).toEqual(['问题', '改动', '验证', '风险与未做'])
    expect(body).toContain('- Review：fail — 仍有风险')
    expect(body).toContain('Review 未通过：仍有风险')
    expect(body).toContain('未通过标准：AC1')
  })
})

describe('PR 正文兼容契约', () => {
  it('保留 Keel Task、Closes 与 keel:v1 标记', () => {
    const body = pullRequestBody({
      taskId: 'task-1',
      sections: pullRequestSections({
        issueTitle: '来源 issue 标题',
        issueSource: 'ticket:task-1',
        facts: {},
        fallbackChanges: '分支事实',
        fallbackChangesSource: 'git:task-1',
      }),
      remoteUrl: 'https://github.com/acme/keel.git',
      externalRefs: ['acme/keel#129'],
    })
    expect(body.startsWith('Keel Task task-1\n\n## 问题')).toBe(true)
    expect(body.endsWith('Closes #129\n<!-- keel:v1 task=task-1 -->')).toBe(true)
  })
})
