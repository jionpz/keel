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
import { collectGitDiff } from './git-diff.js'

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
})
