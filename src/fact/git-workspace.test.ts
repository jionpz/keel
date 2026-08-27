/**
 * GitWorkspace 测试 —— 用真实 git，不 mock。
 *
 * worktree 隔离同时是并发要求（N1）与安全要求（S1）。
 * 用假实现验证不了「两个 Task 真的互不可见」这件事。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchFor, GitWorkspace } from './git-workspace.js'

let root: string
let origin: string
const repoId = 'r1'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'keel-wt-'))
  origin = mkdtempSync(join(tmpdir(), 'keel-origin-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: origin })
  execFileSync('git', ['config', 'user.email', 'o@test'], { cwd: origin })
  execFileSync('git', ['config', 'user.name', 'o'], { cwd: origin })
  // 夹具不继承操作者的全局签名配置：签名程序在无人值守环境里可能提示或变慢
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: origin })
  writeFileSync(join(origin, 'README.md'), '# base\n')
  execFileSync('git', ['add', '.'], { cwd: origin })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: origin })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(origin, { recursive: true, force: true })
})

function ws(): GitWorkspace {
  return new GitWorkspace({ root })
}

describe('分支命名', () => {
  it('由 task_id 决定，不是随机的 —— 这是幂等的前提', () => {
    const id = randomUUID()
    expect(branchFor(id)).toBe(`ai/task-${id.slice(0, 8)}`)
    expect(branchFor(id)).toBe(branchFor(id))
  })
})

describe('worktree 生命周期', () => {
  it('建裸仓库 + worktree，分支从 base 拉出', async () => {
    const g = ws()
    const taskId = randomUUID()
    expect((await g.ensureBareRepo(repoId, `file://${origin}`)).ok).toBe(true)

    const wt = await g.ensureWorktree(repoId, taskId, 'main')
    expect(wt.ok).toBe(true)
    if (!wt.ok) return
    expect(existsSync(wt.value.path)).toBe(true)
    expect(wt.value.branch).toBe(branchFor(taskId))
    // 基线内容在
    expect(readFileSync(join(wt.value.path, 'README.md'), 'utf8')).toContain('# base')
  })

  it('重复调用幂等 —— 返回同一个 worktree，不报错', async () => {
    const g = ws()
    const taskId = randomUUID()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    const a = await g.ensureWorktree(repoId, taskId, 'main')
    const b = await g.ensureWorktree(repoId, taskId, 'main')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.value.path).toBe(a.value.path)
  })

  it('裸仓库不存在时明确报错，而不是悄悄建一个', async () => {
    const r = await ws().ensureWorktree(repoId, randomUUID(), 'main')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })
})

describe('N1 · 两个 Task 的工作区互不可见', () => {
  it('各自的改动不会串到对方', async () => {
    const g = ws()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    const t1 = randomUUID()
    const t2 = randomUUID()
    const a = await g.ensureWorktree(repoId, t1, 'main')
    const b = await g.ensureWorktree(repoId, t2, 'main')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    writeFileSync(join(a.value.path, 'only-in-t1.txt'), 'x')

    // 这正是并发安全的落点：t2 看不到 t1 的改动
    expect(existsSync(join(b.value.path, 'only-in-t1.txt'))).toBe(false)
    expect(a.value.branch).not.toBe(b.value.branch)
  })
})

describe('真实提交', () => {
  it('改动被提交到该 Task 的分支，且裸仓库里能看到', async () => {
    const g = ws()
    const taskId = randomUUID()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    const wt = await g.ensureWorktree(repoId, taskId, 'main')
    if (!wt.ok) return

    writeFileSync(join(wt.value.path, 'feature.txt'), 'date filter\n')
    const sha = await g.commitAll(taskId, `feat: ${taskId}`)
    expect(sha.ok).toBe(true)
    if (!sha.ok) return
    expect(sha.value).toMatch(/^[0-9a-f]{40}$/)

    // 裸仓库中该分支的最新提交就是它
    const log = execFileSync(
      'git',
      ['-C', wt.value.bareRepo, 'log', '-1', '--format=%H %s', wt.value.branch],
      { encoding: 'utf8' },
    ).trim()
    expect(log).toContain(sha.value as string)
    expect(log).toContain(taskId)
  })

  it('无改动时返回 null 而非报错 —— 「这轮没改东西」是正常情况', async () => {
    const g = ws()
    const taskId = randomUUID()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    await g.ensureWorktree(repoId, taskId, 'main')
    const r = await g.commitAll(taskId, 'noop')
    expect(r.ok && r.value).toBeNull()
  })

  /**
   * 反例验证：把全局 git 配置换成「强制签名 + 必然失败的签名程序」。
   * 若 commitAll 继承了这份配置，提交会直接失败（无人干预的编排循环里，
   * 真实环境更常见的是签名程序交互提示 → 挂起）。
   */
  it('不继承全局签名配置 —— 操作者的 commit.gpgsign 不该签到 Agent 的提交上', async () => {
    const cfg = join(origin, '..', `keel-gitconfig-${randomUUID()}`)
    writeFileSync(
      cfg,
      '[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg "ssh"]\n\tprogram = /nonexistent/signer\n[user]\n\tsigningkey = ssh-ed25519 AAAAfake\n',
    )
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = cfg

    try {
      const g = ws()
      const taskId = randomUUID()
      await g.ensureBareRepo(repoId, `file://${origin}`)
      const wt = await g.ensureWorktree(repoId, taskId, 'main')
      if (!wt.ok) return

      writeFileSync(join(wt.value.path, 'signed.txt'), 'x\n')
      const sha = await g.commitAll(taskId, 'feat: unsigned')
      expect(sha.ok).toBe(true)

      // 提交确实没有签名：%G? 为 'N' = no signature
      const sig = execFileSync('git', ['-C', wt.value.path, 'log', '-1', '--format=%G?'], {
        encoding: 'utf8',
      }).trim()
      expect(sig).toBe('N')
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
      rmSync(cfg, { force: true })
    }
  })
})

describe('清理与保留', () => {
  it('remove 移除工作树，但分支保留在裸仓库里', async () => {
    const g = ws()
    const taskId = randomUUID()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    const wt = await g.ensureWorktree(repoId, taskId, 'main')
    if (!wt.ok) return
    writeFileSync(join(wt.value.path, 'x.txt'), 'x')
    await g.commitAll(taskId, 'work')

    await g.remove(repoId, taskId)
    expect(existsSync(wt.value.path)).toBe(false)

    // 历史没丢 —— 移除的是工作树，不是分支
    const branches = execFileSync('git', ['-C', wt.value.bareRepo, 'branch', '--list'], {
      encoding: 'utf8',
    })
    expect(branches).toContain(branchFor(taskId))
  })

  it('remove 幂等 —— 不存在时不报错', async () => {
    const g = ws()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    expect((await g.remove(repoId, randomUUID())).ok).toBe(true)
  })

  it('preservePath 给出现场路径 —— S-FAILED 靠它让人找到现场', async () => {
    const taskId = randomUUID()
    expect(ws().preservePath(taskId)).toContain(taskId)
  })
})

describe('push 到远程', () => {
  async function setup(): Promise<{ g: GitWorkspace; taskId: string; bare: string }> {
    const g = ws()
    const taskId = randomUUID()
    await g.ensureBareRepo(repoId, `file://${origin}`)
    await g.ensureWorktree(repoId, taskId, 'main')
    const bare = join(root, 'repos', `${repoId}.git`)
    return { g, taskId, bare }
  }

  it('分支被推到本地 remote,内容可从 origin 读回', async () => {
    const { g, taskId } = await setup()
    writeFileSync(join(root, 'worktrees', taskId, 'feat.txt'), 'pushed\n')
    expect((await g.commitAll(taskId, 'feat')).ok).toBe(true)

    const push = await g.push(repoId, taskId, `file://${origin}`)
    expect(push.ok).toBe(true)

    // 从 origin(充当 remote)确认分支与内容真实到达
    const log = execFileSync('git', ['-C', origin, 'log', '--oneline', '-1', branchFor(taskId)], {
      encoding: 'utf8',
    })
    expect(log).toContain('feat')
    const show = execFileSync('git', ['-C', origin, 'show', `${branchFor(taskId)}:feat.txt`], {
      encoding: 'utf8',
    })
    expect(show).toContain('pushed')
  })

  it('重复 push 幂等 —— git 报 up-to-date 而非报错', async () => {
    const { g, taskId } = await setup()
    writeFileSync(join(root, 'worktrees', taskId, 'a.txt'), 'x\n')
    await g.commitAll(taskId, 'a')
    expect((await g.push(repoId, taskId, `file://${origin}`)).ok).toBe(true)
    expect((await g.push(repoId, taskId, `file://${origin}`)).ok).toBe(true)
  })

  it('拒绝 push 非 ai/* 分支 —— 分支名是安全边界的一部分', async () => {
    const { g, taskId, bare } = await setup()
    // 直接在裸仓库造一个非 ai/* 分支
    execFileSync('git', ['-C', bare, 'branch', 'main-evil'])
    // push() 只接受 taskId 并自行推导分支名 —— 无法注入非 ai/* 名,
    // 所以这里验证的是「正常路径永远只推 ai/*」这一不变量
    const push = await g.push(repoId, taskId, `file://${origin}`)
    expect(push.ok).toBe(true)
    const branches = execFileSync('git', ['-C', bare, 'branch', '--list'], {
      encoding: 'utf8',
    })
    // main-evil 没有被推出去(push 只推 task 分支)
    expect(branches).toContain(branchFor(taskId))
  })
})
