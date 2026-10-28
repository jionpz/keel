/**
 * 项目根与目录规范化。
 *
 * 这一层的错误不会在 happy path 暴露：`/repo` 与 `/repo/` 看起来一样，
 * 只有同时绑定两者时才会发现唯一索引没起作用。所以每条规则都单独钉住。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalizeDir, resolveKeelHome, validateAttachedDir } from './project-root.js'

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'keel-root-')))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('resolveKeelHome', () => {
  it('相对 KEEL_HOME 按给定 cwd 解析为绝对路径', () => {
    const home = resolveKeelHome({ KEEL_HOME: '.keel' }, sandbox)
    expect(home).toBe(join(sandbox, '.keel'))
  })

  it('目录不存在时创建', () => {
    const home = resolveKeelHome({ KEEL_HOME: 'nested/home' }, sandbox)
    expect(canonicalizeDir(home).ok).toBe(true)
  })

  it('不同 cwd 传入同一个相对值 → 两个不同的项目根（所以必须固化）', () => {
    const a = resolveKeelHome({ KEEL_HOME: '.keel' }, sandbox)
    const other = join(sandbox, 'other')
    mkdirSync(other)
    const b = resolveKeelHome({ KEEL_HOME: '.keel' }, other)
    expect(a).not.toBe(b)
    expect(a).toBe(join(sandbox, '.keel'))
    expect(b).toBe(join(other, '.keel'))
  })

  it('符号链接根收敛到真实路径', () => {
    const real = join(sandbox, 'real-home')
    mkdirSync(real)
    symlinkSync(real, join(sandbox, 'link-home'))
    const home = resolveKeelHome({ KEEL_HOME: 'link-home' }, sandbox)
    expect(home).toBe(real)
  })
})

describe('canonicalizeDir · 别名收敛', () => {
  it('尾斜杠、点段、重复分隔符收敛到同一路径', () => {
    const dir = join(sandbox, 'repo')
    mkdirSync(dir)
    const expected = canonicalizeDir(dir)
    expect(expected.ok).toBe(true)
    if (!expected.ok) return

    for (const alias of [`${dir}/`, `${dir}/.`, `${dir}/./`, `${dir}//`, join(dir, 'sub', '..')]) {
      const r = canonicalizeDir(alias)
      expect(r.ok, alias).toBe(true)
      if (r.ok) expect(r.value, alias).toBe(expected.value)
    }
  })

  it('相对路径按 cwd 解析', () => {
    mkdirSync(join(sandbox, 'repo'))
    const r = canonicalizeDir('repo', sandbox)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(join(sandbox, 'repo'))
  })

  it('符号链接收敛到目标目录', () => {
    const dir = join(sandbox, 'repo')
    mkdirSync(dir)
    const link = join(sandbox, 'repo-link')
    symlinkSync(dir, link)
    const r = canonicalizeDir(link)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(dir)
  })

  it('目录不存在 → local_path_missing，且不创建目录', () => {
    const missing = join(sandbox, 'nope')
    const r = canonicalizeDir(missing)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('WORKSPACE_ERROR')
      expect(r.error.detail).toMatch(/^\[local_path_missing\]/)
      expect(r.error.detail).toContain(missing)
    }
    expect(canonicalizeDir(missing).ok).toBe(false)
  })

  it('文件不是目录 → local_path_missing', () => {
    const file = join(sandbox, 'file.txt')
    writeFileSync(file, 'x')
    const r = canonicalizeDir(file)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[local_path_missing\]/)
  })
})

describe('validateAttachedDir', () => {
  const REMOTE = 'https://github.com/acme/widgets.git'

  function gitRepo(name: string, origin?: string): string {
    const dir = join(sandbox, name)
    mkdirSync(dir)
    execFileSync('git', ['init', '--quiet', dir])
    if (origin !== undefined) {
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
    }
    return dir
  }

  it('合法 git 工作树 + 匹配 remote（忽略 .git 后缀）→ 成功', async () => {
    const dir = gitRepo('repo', 'https://github.com/acme/widgets')
    const r = await validateAttachedDir(dir, REMOTE)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.path).toBe(dir)
      expect(r.value.origin).toBe('https://github.com/acme/widgets')
    }
  })

  it('非 git 目录 → not_a_git_worktree', async () => {
    const dir = join(sandbox, 'plain')
    mkdirSync(dir)
    const r = await validateAttachedDir(dir, REMOTE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[not_a_git_worktree\]/)
  })

  it('没有 origin → origin_mismatch actual="(none)"', async () => {
    const dir = gitRepo('no-origin')
    const r = await validateAttachedDir(dir, REMOTE)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[origin_mismatch\]/)
      expect(r.error.detail).toContain('actual="(none)"')
    }
  })

  it('origin 不同 → 错误里同时给出期望与实际', async () => {
    const dir = gitRepo('wrong', 'https://github.com/acme/other')
    const r = await validateAttachedDir(dir, REMOTE)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[origin_mismatch\]/)
      expect(r.error.detail).toContain('expected="https://github.com/acme/widgets"')
      expect(r.error.detail).toContain('actual="https://github.com/acme/other"')
    }
  })

  it('目录不存在 → local_path_missing', async () => {
    const r = await validateAttachedDir(join(sandbox, 'absent'), REMOTE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[local_path_missing\]/)
  })

  it('校验是只读的：不改变工作树状态与 origin', async () => {
    const dir = gitRepo('readonly', 'https://github.com/acme/widgets')
    const before = execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString()
    const originBefore = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'])
      .toString()
      .trim()

    await validateAttachedDir(dir, REMOTE)

    expect(execFileSync('git', ['-C', dir, 'status', '--porcelain']).toString()).toBe(before)
    expect(execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin']).toString().trim()).toBe(
      originBefore,
    )
    // 防「测试自己写了绝对路径」的假阳性
    expect(relative(sandbox, dir)).not.toBe('')
  })
})
