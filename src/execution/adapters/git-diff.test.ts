/**
 * collectGitDiff 回归 —— #1-06。
 *
 * 旧 HumanAdapter.collectChanges 恒返回 is_dirty=false,
 * 人工改的文件在 CollectChanges 里消失 —— 进 S-DONE 清理时直接丢。
 * 现在 Human 与 OMP 共用同一实现,必须看到真实 git 脏树。
 *
 * 用临时 git 仓库验证,不起任何 Harness。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { collectGitDiff, gitHeadSha } from './git-diff.js'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'keel-gitdiff-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('collectGitDiff · 读真实 git 脏树', () => {
  it('干净仓库 → is_dirty=false,无文件改动', async () => {
    const r = await collectGitDiff(repo)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.is_dirty).toBe(false)
    expect(r.value.files_changed).toEqual([])
    expect(r.value.patch).toBeNull()
  })

  it('有改动 → is_dirty=true,列出的文件与 git status 一致', async () => {
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    writeFileSync(join(repo, 'base.txt'), 'base\nchanged\n')

    const r = await collectGitDiff(repo)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.is_dirty).toBe(true)
    expect(r.value.files_changed.map((f) => f.path).sort()).toEqual(['base.txt', 'new.txt'])
    expect(r.value.patch).not.toBeNull()
  })

  it('已提交的改动不算脏(与 status --porcelain 语义一致)', async () => {
    writeFileSync(join(repo, 'committed.txt'), 'x\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'commit2'], { cwd: repo })

    const r = await collectGitDiff(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.is_dirty).toBe(false)
  })

  it('R8 · 双状态 porcelain 按工作区列分类,不再误判', async () => {
    // 注入 exec:精确控 porcelain 输出,构造 AD/MM/??/AM 四态
    const exec = (_cmd: string, args: readonly string[], _cwd: string) => {
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout:
            [
              'AD staged-deleted.txt', // 暂存新增 + 工作区删除 → 工作区 D 说了算 → deleted
              'MM both-modified.txt', // 暂存改 + 工作区改 → modified
              '?? untracked.txt', // 未跟踪 → added
              'AM add-mod.txt', // 暂存新增 + 工作区改 → modified
              'A  staged-added.txt', // X=A,Y=空格:暂存新增,工作区未动 → added
            ].join('\n') + '\n',
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' } // diff 空
    }

    const r = await collectGitDiff(repo, { exec })
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return

    const byPath = new Map(r.value.files_changed.map((f) => [f.path, f.change]))
    expect(byPath.get('staged-deleted.txt'), 'AD 按工作区 D → deleted').toBe('deleted')
    expect(byPath.get('both-modified.txt'), 'MM → modified').toBe('modified')
    expect(byPath.get('untracked.txt'), '?? → added').toBe('added')
    expect(byPath.get('add-mod.txt'), 'AM 工作区 M → modified').toBe('modified')
    expect(byPath.get('staged-added.txt'), 'Y=A 暂存新增且工作区未动 → added').toBe('added')
  })
})

/**
 * since 基线 —— 编排层要的是「**这个 Run** 改了什么」，不是「工作树现在脏不脏」。
 *
 * 没有基线时，模型自己 `git commit` 之后 status 干净、diff 为空，
 * 一次真实完成的 develop 会被报成「0 文件 0 提交」。
 */
describe('collectGitDiff · since 基线', () => {
  function head(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  }

  function commitAll(msg: string): void {
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repo })
  }

  it('反例：模型自己 commit 之后，无基线读不到任何改动（缺陷本身）', async () => {
    writeFileSync(join(repo, 'by-model.txt'), 'x\n')
    commitAll('model commit')

    const r = await collectGitDiff(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.files_changed).toEqual([])
    expect(r.value.commits).toEqual([])
  })

  it('有基线：已提交的改动仍可见，commits 报出本轮 SHA', async () => {
    const before = head()
    writeFileSync(join(repo, 'by-model.txt'), 'x\n')
    commitAll('model commit')
    const after = head()

    const r = await collectGitDiff(repo, { since: before })
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.files_changed.map((f) => f.path)).toContain('by-model.txt')
    expect(r.value.commits).toEqual([after])
    // 已提交 → 工作树干净，但「本轮有没有干活」的答案是「有」
    expect(r.value.is_dirty).toBe(false)
  })

  it('有基线：新建但未 add 的文件报 added（git diff 看不见未跟踪）', async () => {
    const before = head()
    writeFileSync(join(repo, 'untracked-new.txt'), 'hello\n')

    const r = await collectGitDiff(repo, { since: before })
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    const entry = r.value.files_changed.find((f) => f.path === 'untracked-new.txt')
    expect(entry?.change, '新建文件必须报 added，否则 develop 会被误判为空改动').toBe('added')
    expect(r.value.is_dirty).toBe(true)
  })

  it('有基线：基线之后无任何改动 → 空（这才是真的没干活）', async () => {
    const before = head()
    const r = await collectGitDiff(repo, { since: before })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.files_changed).toEqual([])
    expect(r.value.commits).toEqual([])
  })

  it('有基线：删除与重命名解析正确', async () => {
    const before = head()
    execFileSync('git', ['mv', 'base.txt', 'renamed.txt'], { cwd: repo })
    rmSync(join(repo, 'renamed.txt')) // 同一工作树里再造一个删除
    writeFileSync(join(repo, 'kept.txt'), 'k\n')
    commitAll('rename + delete')

    const r = await collectGitDiff(repo, { since: before })
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    const byPath = new Map(r.value.files_changed.map((f) => [f.path, f.change]))
    expect(byPath.get('base.txt'), '源路径被删 → deleted').toBe('deleted')
    expect(byPath.get('kept.txt')).toBe('added')
  })
})

describe('gitHeadSha · 取基线', () => {
  it('正常仓库返回 40 位 sha', async () => {
    const r = await gitHeadSha(repo)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatch(/^[0-9a-f]{40}$/)
  })

  it('非 git 目录 → ok(null)，不是错误（没有基线 ≠ 失败）', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'keel-nogit-'))
    try {
      const r = await gitHeadSha(plain)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.value).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
