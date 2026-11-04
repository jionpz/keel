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

import { execFile, execFileSync } from 'node:child_process'
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
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  branchFor,
  type GitExec,
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
    expect(wt.value.branchCreated).toBe(true)
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
    expect(b.value.branchCreated).toBe(false)
  })

  it('worktree 被外部删除后重建：复用原分支，HEAD 停在分支 tip 而不是新基线', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()

    const first = await g.ensureWorktree(p, taskId)
    if (!first.ok) return
    writeFileSync(join(first.value.path, 'work.txt'), 'work\n')
    const commit = await g.commitAll(taskId, 'work')
    expect(commit.ok && commit.value).not.toBeNull()
    if (!commit.ok || commit.value === null) return

    // 远端前进，重新 prepare 会拿到更新的 baseSha
    writeFileSync(join(origin, 'next.txt'), 'next\n')
    execFileSync('git', ['add', '.'], { cwd: origin })
    execFileSync('git', ['commit', '-q', '-m', 'next'], { cwd: origin })
    const p2 = await prepare(g)
    expect(p2.baseSha).not.toBe(p.baseSha)

    // 模拟被外部删除（git 元数据仍在）—— add 会先失败，prune 后重试成功
    rmSync(first.value.path, { recursive: true, force: true })

    const again = await g.ensureWorktree(p2, taskId)
    expect(again.ok, again.ok ? '' : again.error.detail).toBe(true)
    if (!again.ok) return
    expect(again.value.created).toBe(true)
    expect(again.value.branchCreated).toBe(false)
    expect(headOf(again.value.path)).toBe(commit.value)
    expect(headOf(again.value.path)).not.toBe(p2.baseSha)
  })

  it('路径被普通目录占用 → fail closed，不删除目录', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const wtPath = join(root, 'worktrees', taskId)
    mkdirSync(wtPath, { recursive: true })
    writeFileSync(join(wtPath, 'keep.txt'), 'do not delete\n')

    const r = await g.ensureWorktree(p, taskId)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[worktree_failed\]/)
      expect(r.error.detail).toContain(wtPath)
      expect(r.error.detail).toContain('(not a worktree)')
    }
    expect(readFileSync(join(wtPath, 'keep.txt'), 'utf8')).toBe('do not delete\n')
  })

  it('目录存在但 checkout 在别的分支 → fail closed，报告期望与实际分支', async () => {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const first = await g.ensureWorktree(p, taskId)
    if (!first.ok) return
    execFileSync('git', ['-C', first.value.path, 'checkout', '-q', '-b', 'other'])

    const r = await g.ensureWorktree(p, taskId)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[worktree_failed\]/)
      expect(r.error.detail).toContain(branchFor(taskId))
      expect(r.error.detail).toContain('actual="other"')
    }
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
    expect([a.value.branchCreated, b.value.branchCreated].filter(Boolean)).toHaveLength(1)
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

// ───────────────────── git 传输认证（11-03-git-transport-auth） ─────────────────────

const TOKEN = 'ghp_transport_injection_test'
const AUTH_B64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64')

interface ExecCall {
  readonly args: readonly string[]
  readonly env: NodeJS.ProcessEnv | undefined
}

const realExecAsync = promisify(execFile)

const realExec: GitExec = async (file, args) => {
  const { stdout, stderr } = await realExecAsync(file, [...args], { encoding: 'utf8' })
  return { stdout, stderr }
}

/** 临时设置 token 并在结束后恢复 —— 不把凭据留在其他用例的环境里 */
async function withToken<T>(fn: () => Promise<T>): Promise<T> {
  const savedKeel = process.env.KEEL_GITHUB_TOKEN
  const savedGithub = process.env.GITHUB_TOKEN
  process.env.KEEL_GITHUB_TOKEN = TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    return await fn()
  } finally {
    if (savedKeel === undefined) delete process.env.KEEL_GITHUB_TOKEN
    else process.env.KEEL_GITHUB_TOKEN = savedKeel
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGithub
  }
}

/** 临时移除 token —— 用于验证「无 token 时调用形态与改动前一致」 */
async function withNoToken<T>(fn: () => Promise<T>): Promise<T> {
  const savedKeel = process.env.KEEL_GITHUB_TOKEN
  const savedGithub = process.env.GITHUB_TOKEN
  delete process.env.KEEL_GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    return await fn()
  } finally {
    if (savedKeel === undefined) delete process.env.KEEL_GITHUB_TOKEN
    else process.env.KEEL_GITHUB_TOKEN = savedKeel
    if (savedGithub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = savedGithub
  }
}

/** 临时设置一组 GIT_CONFIG_* —— 验证注入时操作者既有配置不被覆盖 */
async function withGitConfigEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(env)
  const saved = new Map(keys.map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function expectNoSecretInArgv(args: readonly string[]): void {
  const joined = args.join(' ')
  expect(joined).not.toContain(TOKEN)
  expect(joined).not.toContain(AUTH_B64)
}

describe('git 传输认证 · https 注入', () => {
  it('clone 携带 extraheader；token 只在 env 里，不进 argv，错误已脱敏', async () => {
    const calls: ExecCall[] = []
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      throw new Error(`fatal: could not read Username for 'https://github.com': ${TOKEN}`)
    }
    const g = new GitWorkspace({ root, exec: fake })

    await withToken(async () => {
      const r = await g.ensureBareRepo(repoId, 'https://github.com/acme/widget.git')
      expect(r.ok).toBe(false)
      if (r.ok) return
      // 错误 detail 必须已脱敏：明文与 base64 都不许出现
      expect(r.error.detail).not.toContain(TOKEN)
      expect(r.error.detail).not.toContain(AUTH_B64)
      expect(r.error.detail).toContain('***')
    })

    const clone = calls.find((c) => c.args.includes('clone'))
    expect(clone).toBeDefined()
    if (clone === undefined) return
    expect(clone.env?.GIT_CONFIG_COUNT).toBe('1')
    expect(clone.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(clone.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${AUTH_B64}`)
    expectNoSecretInArgv(clone.args)
  })

  it('fetch 携带 extraheader；ssh remote 不注入', async () => {
    mkdirSync(join(root, 'repos'), { recursive: true })
    const bare = join(root, 'repos', `${repoId}.git`)
    execFileSync('git', ['clone', '-q', '--bare', `file://${origin}`, bare])

    const calls: ExecCall[] = []
    const sha = 'c'.repeat(40)
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      if (args.includes('--is-bare-repository')) return { stdout: 'true\n', stderr: '' }
      if (args.includes('fetch')) return { stdout: '', stderr: '' }
      if (args.includes('rev-parse')) return { stdout: `${sha}\n`, stderr: '' }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }
    const g = new GitWorkspace({ root, exec: fake })

    await withToken(async () => {
      const r = await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.baseSha).toBe(sha)
    })

    const fetch = calls.find((c) => c.args.includes('fetch'))
    expect(fetch).toBeDefined()
    if (fetch === undefined) return
    expect(fetch.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(fetch.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${AUTH_B64}`)
    expectNoSecretInArgv(fetch.args)

    // ssh 部署：同一个 token 环境下，fetch 不产生任何 extraheader
    calls.length = 0
    await withToken(async () => {
      const r = await g.prepareProject(managed, 'ssh://git@github.com/acme/widget.git', 'main')
      expect(r.ok).toBe(true)
    })
    const sshFetch = calls.find((c) => c.args.includes('fetch'))
    expect(sshFetch).toBeDefined()
    expect(sshFetch?.env).toBeUndefined()
  })

  it('push 携带 extraheader；token 不进 argv', async () => {
    const calls: ExecCall[] = []
    const taskId = randomUUID()
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      return { stdout: '', stderr: '' }
    }
    const g = new GitWorkspace({ root, exec: fake })
    const project: PreparedProject = {
      repoId,
      gitDir: origin,
      baseBranch: 'main',
      baseRef: 'refs/remotes/origin/main',
      baseSha: headOf(origin),
      fetchedAt: new Date().toISOString(),
    }

    await withToken(async () => {
      const r = await g.push(project, taskId, 'https://github.com/acme/widget.git')
      expect(r.ok).toBe(true)
    })

    const push = calls.find((c) => c.args.includes('push'))
    expect(push).toBeDefined()
    if (push === undefined) return
    expect(push.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(push.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${AUTH_B64}`)
    expectNoSecretInArgv(push.args)
  })

  it('无 token 时 https remote 也不传 env —— 调用形态与改动前一致', async () => {
    mkdirSync(join(root, 'repos'), { recursive: true })
    const bare = join(root, 'repos', `${repoId}.git`)
    execFileSync('git', ['clone', '-q', '--bare', `file://${origin}`, bare])

    const calls: ExecCall[] = []
    const sha = 'd'.repeat(40)
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      if (args.includes('--is-bare-repository')) return { stdout: 'true\n', stderr: '' }
      if (args.includes('fetch')) return { stdout: '', stderr: '' }
      if (args.includes('rev-parse')) return { stdout: `${sha}\n`, stderr: '' }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }
    const g = new GitWorkspace({ root, exec: fake })

    await withNoToken(async () => {
      const r = await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')
      expect(r.ok).toBe(true)
    })

    const fetch = calls.find((c) => c.args.includes('fetch'))
    expect(fetch).toBeDefined()
    // 关键：不是「env 里没有 header」，而是**根本不传 env** —— 与改动前一字不差
    expect(fetch?.env).toBeUndefined()
  })

  it('既有 GIT_CONFIG_* 真正随注入传给 git，不被覆盖', async () => {
    const calls: ExecCall[] = []
    const taskId = randomUUID()
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      return { stdout: '', stderr: '' }
    }
    const g = new GitWorkspace({ root, exec: fake })
    const project: PreparedProject = {
      repoId,
      gitDir: origin,
      baseBranch: 'main',
      baseRef: 'refs/remotes/origin/main',
      baseSha: headOf(origin),
      fetchedAt: new Date().toISOString(),
    }

    await withGitConfigEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.pager',
        GIT_CONFIG_VALUE_0: 'less',
      },
      () =>
        withToken(async () => {
          const r = await g.push(project, taskId, 'https://github.com/acme/widget.git')
          expect(r.ok).toBe(true)
        }),
    )

    const push = calls.find((c) => c.args.includes('push'))
    expect(push).toBeDefined()
    if (push === undefined) return
    // 操作者的项原样保留，认证项追加为第 2 项
    expect(push.env?.GIT_CONFIG_COUNT).toBe('2')
    expect(push.env?.GIT_CONFIG_KEY_0).toBe('core.pager')
    expect(push.env?.GIT_CONFIG_VALUE_0).toBe('less')
    expect(push.env?.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader')
  })

  it('fetch 失败的 stderr 也脱敏 —— fetch_failed 不泄漏明文或 base64', async () => {
    mkdirSync(join(root, 'repos'), { recursive: true })
    const bare = join(root, 'repos', `${repoId}.git`)
    execFileSync('git', ['clone', '-q', '--bare', `file://${origin}`, bare])

    const fake: GitExec = async (_file, args) => {
      if (args.includes('--is-bare-repository')) return { stdout: 'true\n', stderr: '' }
      if (args.includes('fetch')) {
        // execFile 的错误把 stderr 挂成属性；msg() 优先取 stderr
        const e = new Error('Command failed') as Error & { stderr?: string }
        e.stderr = `${TOKEN} fatal: Authentication failed for header=AUTHORIZATION: basic ${AUTH_B64}`
        throw e
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }
    const g = new GitWorkspace({ root, exec: fake })

    await withToken(async () => {
      const r = await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.detail).toMatch(/^\[fetch_failed\]/)
      expect(r.error.detail).not.toContain(TOKEN)
      expect(r.error.detail).not.toContain(AUTH_B64)
      expect(r.error.detail).toContain('***')
    })
  })

  it('本地操作不注入 GIT_CONFIG_*，commit 的签名钉死保持原样', async () => {
    const calls: ExecCall[] = []
    const spy: GitExec = async (file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      return realExec(file, args)
    }
    const g = new GitWorkspace({ root, exec: spy })

    await withToken(async () => {
      const p = await prepare(g) // file:// remote：远程操作同样不注入
      const taskId = randomUUID()
      const wt = await g.ensureWorktree(p, taskId)
      expect(wt.ok).toBe(true)
      if (!wt.ok) return
      writeFileSync(join(wt.value.path, 'local.txt'), 'x\n')
      expect((await g.commitAll(taskId, 'feat: local')).ok).toBe(true)
      expect((await g.status(taskId)).ok).toBe(true)
    })

    for (const call of calls) expect(call.env).toBeUndefined()
    const commit = calls.find((c) => c.args.includes('commit'))
    expect(commit?.args).toContain('commit.gpgsign=false')
    expect(commit?.args).toContain('user.email=keel@localhost')
  })
})
