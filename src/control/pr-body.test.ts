import { describe, expect, it } from 'vitest'
import { issueReferenceLines, prBodyWithIssueReferences } from './pr-body.js'

const REMOTE = 'https://github.com/acme/keel.git'
const BASE = 'Keel Task task-1\n\nAutomated PR.'

describe('PR 正文来源 issue 引用', () => {
  it('无 Feedback 时正文保持原样', () => {
    expect(
      prBodyWithIssueReferences({
        body: BASE,
        taskId: 'task-1',
        remoteUrl: REMOTE,
        externalRefs: [],
      }),
    ).toBe(BASE)
  })

  it('单个同仓 issue 写 Closes 与机器标记', () => {
    expect(
      prBodyWithIssueReferences({
        body: BASE,
        taskId: 'task-1',
        remoteUrl: REMOTE,
        externalRefs: ['acme/keel#129'],
      }),
    ).toBe(`${BASE}\n\nCloses #129\n<!-- keel:v1 task=task-1 -->`)
  })

  it('多个 issue 每个一行并按 external_ref 去重', () => {
    expect(
      issueReferenceLines(['acme/keel#129', 'acme/keel#130', 'acme/keel#129'], REMOTE),
    ).toEqual(['Closes #129', 'Closes #130'])
  })

  it('跨仓 issue 只写 Refs', () => {
    expect(issueReferenceLines(['other/repo#7'], REMOTE)).toEqual(['Refs other/repo#7'])
  })

  it('managed 的相对 issue 引用按当前仓库写 Closes', () => {
    expect(issueReferenceLines(['#42'], REMOTE)).toEqual(['Closes #42'])
  })

  it('非法 external_ref 不进入正文', () => {
    expect(issueReferenceLines(['not-an-issue', 'acme/keel#0'], REMOTE)).toEqual([])
  })

  it('相对引用与完整同仓引用合并去重，未知仓库不能关闭相对 issue', () => {
    expect(issueReferenceLines(['#42', 'acme/keel#42'], REMOTE)).toEqual(['Closes #42'])
    expect(issueReferenceLines(['#42'], null)).toEqual([])
  })

  it('完整 URL 按 host 与仓库判断，跨 host 只保留完整引用', () => {
    const enterprise = 'https://github.example.com/acme/keel.git'
    expect(
      issueReferenceLines(['https://github.example.com/acme/keel/issues/42'], enterprise),
    ).toEqual(['Closes #42'])
    expect(issueReferenceLines(['https://github.com/acme/keel/issues/42'], enterprise)).toEqual([
      'Refs https://github.com/acme/keel/issues/42',
    ])
  })
})
