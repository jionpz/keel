/**
 * 工作区错误码。
 *
 * 断言的是**契约**（前缀 + 字段名），不是文案 —— 文案会改，调用方与测试
 * 依赖的是 code。这里也钉住两件容易漏的事：引号注入与超长 stderr。
 */

import { describe, expect, it } from 'vitest'
import { workspaceError } from './workspace-error.js'

describe('workspaceError', () => {
  it('detail 以 [code] 开头，字段按 k="v" 输出', () => {
    const e = workspaceError('origin_mismatch', { expected: 'a/b', actual: 'a/c' })
    expect(e.kind).toBe('WORKSPACE_ERROR')
    expect(e.detail).toBe('[origin_mismatch] expected="a/b" actual="a/c"')
  })

  it('undefined / null 字段被跳过', () => {
    const e = workspaceError('fetch_failed', {
      git_dir: '/x',
      base: undefined,
      reason: null,
    })
    expect(e.detail).toBe('[fetch_failed] git_dir="/x"')
  })

  it('值里的双引号不会破坏字段边界', () => {
    const e = workspaceError('not_a_git_worktree', { path: '/tmp/a"b' })
    expect(e.detail).toBe('[not_a_git_worktree] path="/tmp/a\'b"')
  })

  it('超长 stderr 截断并保留省略号', () => {
    const e = workspaceError('fetch_failed', { reason: 'x'.repeat(2000) })
    expect(e.detail.length).toBeLessThan(600)
    expect(e.detail).toContain('…')
  })

  it('换行被压平成单行 —— 错误汇总里一条失败只占一行', () => {
    const e = workspaceError('fetch_failed', { reason: 'line1\nline2' })
    expect(e.detail).toBe('[fetch_failed] reason="line1 line2"')
  })
})
