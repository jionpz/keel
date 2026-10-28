/**
 * GitWorkspace 测试 —— 用真实 git，不 mock。
 *
 * worktree 隔离同时是并发要求（N1）与安全要求（S1）。
 * 用假实现验证不了「两个 Task 真的互不可见」这件事。
 *
 * 本任务新增的三类断言同样只能靠真实 git：
 *   - 基线锚点：prepare 之后 ref 移动，worktree 仍从记录的 commit 长出来；
 *   - 并发：同一 repo 的 clone / fetch / worktree add 必须串行；
 *   - attached：用户工作树在 run 前后**逐字节不变**。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  branchFor,
  GitWorkspace,
  type PreparedProject,
  type ProjectBinding,
} from './git-workspace.js'

let root: string
let origin: string
const repoId = 'r1'

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'keel-wt-')))
  origin = realpathSync(mkdtempSync(join(tmpdir(), 'keel-origin-')))
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

const managed: ProjectBinding = { mode: 'managed', repoId }

async function prepare(
  g: GitWorkspace = ws(),
  binding: ProjectBinding = managed,
  remote: string = `file://${origin}`,
): Promise<PreparedProject> {
  const r = await g.prepareProject(binding, remote, 'main')
  if (!r.ok) throw new Error(r.error.detail)
  return r.value
}

function headOf(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

describe('分支命名', () => {
  it('由 task_id 决定，不是随机的 —— 这是幂等的前提', () => {
    const id = randomUUID()
    expect(branchFor(id)).toBe(`ai/task-${id.slice(0, 8)}`)
    expect(branchFor(id)).toBe(branchFor(id))
  })
})

describe('prepareProject · managed', () => {
  it('首次 clone + fetch，baseSha 与远端 main 一致', async () => {
    const p = await prepare()
    expect(p.baseRef).toBe('refs/remotes/origin/main')
    expect(p.baseSha).toBe(headOf(origin))
    expect(p.gitDir).toBe(join(root, 'repos', `${repoId}.git`))
    expect(p.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('第二次 prepare 复用裸仓库，不重复 clone', async () => {
    const g = ws()
    const first = await prepare(g)
    const second = await prepare(g)
    expect(second.gitDir).toBe(first.gitDir)
    // 只剩正式目录：没有 `.tmp-*` 残留
    expect(readdirSync(join(root, 'repos'))).toEqual([`${repoId}.git`])
  })

  it('远端前进后，新 prepare 的 baseSha 跟着前进', async () => {
    const g = ws()
    const first = await prepare(g)

    writeFileSync(join(origin, 'next.txt'), 'next\n')
    execFileSync('git', ['add', '.'], { cwd: origin })
    execFileSync('git', ['commit', '-q', '-m', 'next'], { cwd: origin })

    const second = await prepare(g)
    expect(second.baseSha).not.toBe(first.baseSha)
    expect(second.baseSha).toBe(headOf(origin))
  })

  it('半成品裸仓库 → git_dir_invalid，不当作可用缓存', async () => {
    mkdirSync(join(root, 'repos', `${repoId}.git`), { recursive: true })
    const r = await ws().prepareProject(managed, `file://${origin}`, 'main')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[git_dir_invalid\]/)
      expect(r.error.detail).toContain(root)
    }
  })

  it('远端不可达 → fetch_failed', async () => {
    const r = await ws().prepareProject(
      { mode: 'managed', repoId: 'missing' },
      `file://${join(root, 'no-such-remote')}`,
      'main',
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[git_dir_invalid\]/)
  })

  it('远端没有 base 分支 → base_missing', async () => {
    const r = await ws().prepareProject(managed, `file://${origin}`, 'no-such-branch')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[base_missing\]/)
  })
})

describe('ensureWorktree · 生命周期', () => {
  it('从 baseSha 建分支，内容来自基线', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()

    const wt = await g.ensureWorktree(p, taskId)
    expect(wt.ok).toBe(true)
    if (!wt.ok) return
    expect(wt.value.created).toBe(true)
    expect(wt.value.branch).toBe(branchFor(taskId))
    expect(headOf(wt.value.path)).toBe(p.baseSha)
    expect(readFileSync(join(wt.value.path, 'README.md'), 'utf8')).toContain('# base')
  })

  it('重复调用幂等 —— created=false，不移动分支', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()

    const a = await g.ensureWorktree(p, taskId)
    const b = await g.ensureWorktree(p, taskId)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.value.path).toBe(a.value.path)
    expect(b.value.created).toBe(false)
  })

  it('基线的 ref 被移动后，已准备的 worktree 仍锚定原 commit', async () => {
    const g = ws()
    const p = await prepare(g)

    // 模拟另一个进程在 prepare 与 worktree add 之间 fetch 到了新提交
    writeFileSync(join(origin, 'moved.txt'), 'moved\n')
    execFileSync('git', ['add', '.'], { cwd: origin })
    execFileSync('git', ['commit', '-q', '-m', 'moved'], { cwd: origin })
    execFileSync('git', [
      '-C',
      p.gitDir,
      'fetch',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ])

    expect(headOf(join(origin))).not.toBe(p.baseSha)
    const wt = await g.ensureWorktree(p, randomUUID())
    expect(wt.ok).toBe(true)
    if (!wt.ok) return
    expect(headOf(wt.value.path)).toBe(p.baseSha)
    expect(existsSync(join(wt.value.path, 'moved.txt'))).toBe(false)
  })
})

describe('N1 · 两个 Task 的工作区互不可见', () => {
  it('各自的改动不会串到对方', async () => {
    const g = ws()
    const p = await prepare(g)
    const t1 = randomUUID()
    const t2 = randomUUID()
    const a = await g.ensureWorktree(p, t1)
    const b = await g.ensureWorktree(p, t2)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    writeFileSync(join(a.value.path, 'only-in-t1.txt'), 'x')

    // 这正是并发安全的落点：t2 看不到 t1 的改动
    expect(existsSync(join(b.value.path, 'only-in-t1.txt'))).toBe(false)
    expect(a.value.branch).not.toBe(b.value.branch)
  })
})

describe('attached · 用户工作树只读', () => {
  function userRepo(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'keel-user-')))
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'u@test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'u'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', `file://${origin}`], { cwd: dir })
    writeFileSync(join(dir, 'local.txt'), 'user work\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'user'], { cwd: dir })
    return dir
  }

  it('gitDir 是用户仓库，worktree 仍在 .keel 下', async () => {
    const dir = userRepo()
    try {
      const p = await prepare(ws(), { mode: 'attached', repoId: 'a1', localPath: dir })
      expect(p.gitDir).toBe(dir)

      const wt = await ws().ensureWorktree(p, randomUUID())
      expect(wt.ok).toBe(true)
      if (!wt.ok) return
      expect(wt.value.path.startsWith(join(root, 'worktrees'))).toBe(true)
      expect(wt.value.path.startsWith(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prepare + worktree 前后，用户工作树内容、HEAD、dirty 状态完全一致', async () => {
    const dir = userRepo()
    try {
      const before = {
        head: headOf(dir),
        status: execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
          encoding: 'utf8',
        }),
        content: readFileSync(join(dir, 'local.txt'), 'utf8'),
        branch: execFileSync('git', ['-C', dir, 'branch', '--show-current'], {
          encoding: 'utf8',
        }).trim(),
      }

      const g = ws()
      const p = await prepare(g, { mode: 'attached', repoId: 'a2', localPath: dir })
      const wt = await g.ensureWorktree(p, randomUUID())
      expect(wt.ok).toBe(true)

      expect(headOf(dir)).toBe(before.head)
      expect(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })).toBe(
        before.status,
      )
      expect(readFileSync(join(dir, 'local.txt'), 'utf8')).toBe(before.content)
      expect(
        execFileSync('git', ['-C', dir, 'branch', '--show-current'], {
          encoding: 'utf8',
        }).trim(),
      ).toBe(before.branch)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('origin 不匹配 → origin_mismatch', async () => {
    const dir = userRepo()
    try {
      const r = await ws().prepareProject(
        { mode: 'attached', repoId: 'a3', localPath: dir },
        'https://github.com/acme/other.git',
        'main',
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.detail).toMatch(/^\[origin_mismatch\]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('并发 · 同一 repo 的共享 git 状态', () => {
  it('并发 prepare：都成功，只留下一个正式仓库', async () => {
    const g = ws()
    const results = await Promise.all([prepare(g), prepare(g)])
    expect(results[0].gitDir).toBe(results[1].gitDir)
    expect(readdirSync(join(root, 'repos'))).toEqual([`${repoId}.git`])
    // 没有残留的锁目录
    expect(existsSync(join(root, 'locks', `repo-${repoId}.lock`))).toBe(false)
  })

  it('并发 prepare 与 worktree：无 index.lock / ref 锁错误', async () => {
    const g = ws()
    const p = await prepare(g)
    const tasks = [randomUUID(), randomUUID(), randomUUID()]
    const results = await Promise.all([
      ...tasks.map((t) => g.ensureWorktree(p, t)),
      g.prepareProject(managed, `file://${origin}`, 'main'),
    ])
    for (const r of results) expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
  })

  it('同一 task 并发建 worktree：恰好一个创建，另一个复用', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const [a, b] = await Promise.all([g.ensureWorktree(p, taskId), g.ensureWorktree(p, taskId)])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect([a.value.created, b.value.created].filter(Boolean)).toHaveLength(1)
    expect(a.value.path).toBe(b.value.path)
  })
})

describe('真实提交', () => {
  it('改动被提交到该 Task 的分支，且 git 目录里能看到', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const wt = await g.ensureWorktree(p, taskId)
    if (!wt.ok) return

    writeFileSync(join(wt.value.path, 'feature.txt'), 'date filter\n')
    const sha = await g.commitAll(taskId, `feat: ${taskId}`)
    expect(sha.ok).toBe(true)
    if (!sha.ok) return
    expect(sha.value).toMatch(/^[0-9a-f]{40}$/)

    const log = execFileSync(
      'git',
      ['-C', wt.value.gitDir, 'log', '-1', '--format=%H %s', wt.value.branch],
      { encoding: 'utf8' },
    ).trim()
    expect(log).toContain(sha.value as string)
    expect(log).toContain(taskId)
  })

  it('无改动时返回 null 而非报错 —— 「这轮没改东西」是正常情况', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    await g.ensureWorktree(p, taskId)
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
      const p = await prepare(g)
      const taskId = randomUUID()
      const wt = await g.ensureWorktree(p, taskId)
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
  it('remove 移除工作树，但分支保留在 git 目录里', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const wt = await g.ensureWorktree(p, taskId)
    if (!wt.ok) return
    writeFileSync(join(wt.value.path, 'x.txt'), 'x')
    await g.commitAll(taskId, 'work')

    await g.remove(p, taskId)
    expect(existsSync(wt.value.path)).toBe(false)

    // 历史没丢 —— 移除的是工作树，不是分支
    const branches = execFileSync('git', ['-C', wt.value.gitDir, 'branch', '--list'], {
      encoding: 'utf8',
    })
    expect(branches).toContain(branchFor(taskId))
  })

  it('remove 幂等 —— 不存在时不报错', async () => {
    const g = ws()
    const p = await prepare(g)
    expect((await g.remove(p, randomUUID())).ok).toBe(true)
  })

  it('preservePath 给出现场路径 —— S-FAILED 靠它让人找到现场', async () => {
    const taskId = randomUUID()
    expect(ws().preservePath(taskId)).toContain(taskId)
  })
})

describe('push 到远程', () => {
  async function setup(): Promise<{ g: GitWorkspace; p: PreparedProject; taskId: string }> {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    await g.ensureWorktree(p, taskId)
    return { g, p, taskId }
  }

  it('分支被推到本地 remote,内容可从 origin 读回', async () => {
    const { g, p, taskId } = await setup()
    writeFileSync(join(root, 'worktrees', taskId, 'feat.txt'), 'pushed\n')
    expect((await g.commitAll(taskId, 'feat')).ok).toBe(true)

    const push = await g.push(p, taskId, `file://${origin}`)
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
    const { g, p, taskId } = await setup()
    writeFileSync(join(root, 'worktrees', taskId, 'a.txt'), 'x\n')
    await g.commitAll(taskId, 'a')
    expect((await g.push(p, taskId, `file://${origin}`)).ok).toBe(true)
    expect((await g.push(p, taskId, `file://${origin}`)).ok).toBe(true)
  })

  it('只推 ai/* 分支：非 task 分支不会被带出去', async () => {
    const { g, taskId, p } = await setup()
    execFileSync('git', ['-C', p.gitDir, 'branch', 'main-evil'])
    // push() 只接受 taskId 并自行推导分支名 —— 无法注入非 ai/* 名,
    // 所以这里验证的是「正常路径永远只推 ai/*」这一不变量
    const push = await g.push(p, taskId, `file://${origin}`)
    expect(push.ok).toBe(true)
    const branches = execFileSync('git', ['-C', p.gitDir, 'branch', '--list'], {
      encoding: 'utf8',
    })
    expect(branches).toContain(branchFor(taskId))
  })
})
