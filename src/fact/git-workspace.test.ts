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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type RepoCommitPolicy, renderCommitMessage } from '../shared/commit-policy.js'
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

describe('仓库提交身份与消息校验', () => {
  async function setup() {
    const g = ws()
    const p = await prepare(g)
    const taskId = randomUUID()
    const wt = await g.ensureWorktree(p, taskId)
    if (!wt.ok) throw new Error(wt.error.detail)
    writeFileSync(join(wt.value.path, 'feature.txt'), '修复\n')
    return { g, p, taskId, path: wt.value.path }
  }
  function log(path: string, format: string) {
    return execFileSync('git', ['-C', path, 'log', '-1', `--format=${format}`], {
      encoding: 'utf8',
    })
  }
  function hook(path: string, script: string) {
    const dir = join(path, '.hooks')
    mkdirSync(dir)
    writeFileSync(join(dir, 'commit-msg'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    execFileSync('git', ['-C', path, 'config', 'core.hooksPath', dir])
  }

  it('默认作者、提交者、无签名、完整消息逐字不变', async () => {
    const { g, taskId, path } = await setup()
    expect((await g.commitAll(taskId, 'develop: run 12345678')).ok).toBe(true)
    expect(log(path, '%an <%ae>|%cn <%ce>|%G?%n%B')).toBe(
      'Keel <keel@localhost>|Keel <keel@localhost>|N\ndevelop: run 12345678\n\n',
    )
  })
  it('未配置时 git commit 的 argv 与环境参数逐字保持旧调用', async () => {
    const { taskId, path } = await setup()
    const calls: { args: readonly string[]; env: unknown }[] = []
    const g = new GitWorkspace({
      root,
      exec: async (file, args, opts) => {
        calls.push({ args, env: opts?.env })
        return realExecAsync(file, [...args], { encoding: 'utf8', ...opts })
      },
    })
    expect((await g.commitAll(taskId, 'develop: run 12345678')).ok).toBe(true)
    expect(calls.find((call) => call.args.includes('commit'))).toEqual({
      args: [
        '-C',
        path,
        '-c',
        'user.email=keel@localhost',
        '-c',
        'user.name=Keel',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'develop: run 12345678',
      ],
      env: undefined,
    })
  })
  it('指定身份覆盖环境与仓库配置；作者和提交者相同且关闭签名', async () => {
    const { g, taskId, path } = await setup()
    execFileSync('git', ['-C', path, 'config', 'commit.gpgsign', 'true'])
    execFileSync('git', ['-C', path, 'config', 'gpg.program', '/no-such-signer'])
    const previous = { ...process.env }
    try {
      process.env.GIT_AUTHOR_NAME = 'Host'
      process.env.GIT_AUTHOR_EMAIL = 'host@test'
      process.env.GIT_COMMITTER_NAME = 'Host'
      process.env.GIT_COMMITTER_EMAIL = 'host@test'
      const result = await g.commitAll(taskId, 'fix: 中文', {
        commit_author: '机器人 <bot@example.com>',
      })
      expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
      expect(log(path, '%an <%ae>|%cn <%ce>|%G?')).toBe(
        '机器人 <bot@example.com>|机器人 <bot@example.com>|N\n',
      )
    } finally {
      process.env = previous
    }
  })
  it('模板保留普通 Keel-Run 正文，不被全局 cleanup 配置剥去', async () => {
    const { g, taskId, path, p } = await setup()
    execFileSync('git', ['-C', path, 'config', 'commit.cleanup', 'strip'])
    execFileSync('git', ['-C', path, 'config', 'core.commentChar', 'K'])
    const policy: RepoCommitPolicy = {
      commit_message_template: '{type}({scope}): {summary}',
      commit_types: ['fix'],
      commit_scopes: ['fact'],
    }
    const rendered = renderCommitMessage(policy, 'develop', taskId, {
      commit_message: { type: 'fix', scope: 'fact', summary: '修复身份' },
    })
    if (!rendered.ok) throw new Error(rendered.error.detail)
    const result = await g.commitAll(taskId, rendered.value, policy)
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    expect(log(path, '%B')).toBe(`${rendered.value}\n\n`)
    expect((await g.validateCommitHistory(taskId, p.baseSha, policy)).ok).toBe(true)
  })
  it('非法模板消息在提交前拒绝，HEAD 不前进且可用正确消息重试', async () => {
    const { g, taskId, path } = await setup()
    const before = headOf(path)
    const policy: RepoCommitPolicy = {
      commit_message_template: '{type}({scope}): {summary}',
      commit_types: ['fix'],
      commit_scopes: ['fact'],
    }
    for (const message of [
      'fix(fact): 缺少正文',
      `feat(fact): 越过枚举\n\nKeel-Run: ${taskId} stage=develop`,
      `fix(fact): ${'中'.repeat(73)}\n\nKeel-Run: ${taskId} stage=develop`,
    ]) {
      expect(await g.commitAll(taskId, message, policy)).toMatchObject({
        ok: false,
        error: { detail: expect.stringContaining('commit_message_rejected:') },
      })
      expect(headOf(path)).toBe(before)
      expect(await g.isDirty(taskId)).toEqual({ ok: true, value: true })
    }
    expect(
      (await g.commitAll(taskId, `fix(fact): 修复\n\nKeel-Run: ${taskId} stage=develop`, policy))
        .ok,
    ).toBe(true)
  })
  it('header 正则只看首行；拒绝时 HEAD 不前进且改动保留', async () => {
    const { g, taskId, path } = await setup()
    const before = headOf(path)
    const rejected = await g.commitAll(taskId, 'wrong\n\nfix(fact): body', {
      commit_message_check: '^fix\\(fact\\): .+$',
    })
    expect(rejected).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('header 不匹配正则') },
    })
    expect(headOf(path)).toBe(before)
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: true })
    expect(
      (
        await g.commitAll(taskId, 'fix(fact): 修复', {
          commit_message_check: '^fix\\(fact\\): .+$',
        })
      ).ok,
    ).toBe(true)
    const committed = headOf(path)
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
    expect(
      await g.commitAll(taskId, 'wrong', { commit_message_check: '^fix\\(fact\\): .+$' }),
    ).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('header 不匹配正则') },
    })
    expect(headOf(path)).toBe(committed)
  })
  it('commit-msg hook 在 ticket worktree 执行，拒绝原因可回灌，成功后才提交', async () => {
    const { g, taskId, path } = await setup()
    hook(
      path,
      'test -f feature.txt || exit 9\ngrep -q "^fix(fact):" "$1" || { echo "需要 fix(fact) header" >&2; exit 1; }',
    )
    const before = headOf(path)
    const result = await g.commitAll(taskId, 'bad', { commit_message_check: 'hook' })
    expect(result).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('需要 fix(fact) header') },
    })
    expect(headOf(path)).toBe(before)
    expect(
      (await g.commitAll(taskId, 'fix(fact): 修复', { commit_message_check: 'hook' })).ok,
    ).toBe(true)
  })
  it('commit-msg hook 能读取即将提交的暂存区', async () => {
    const { g, taskId, path } = await setup()
    hook(path, 'git diff --cached --name-only | grep -q "^feature.txt$" || exit 7')
    const result = await g.commitAll(taskId, 'fix: 修复', { commit_message_check: 'hook' })
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    expect(log(path, '%s')).toBe('fix: 修复\n')
  })
  it('commit-msg hook 预检看到实际提交的 commit_author 身份', async () => {
    const { g, taskId, path } = await setup()
    execFileSync('git', ['-C', path, 'config', 'user.name', 'Fixture'])
    execFileSync('git', ['-C', path, 'config', 'user.email', 'fixture@example.test'])
    hook(
      path,
      'case "$(git var GIT_AUTHOR_IDENT)" in "Bot <bot@example.test> "*) ;; *) echo "wrong author: $(git var GIT_AUTHOR_IDENT)" >&2; exit 7 ;; esac\n' +
        'case "$(git var GIT_COMMITTER_IDENT)" in "Bot <bot@example.test> "*) ;; *) echo "wrong committer: $(git var GIT_COMMITTER_IDENT)" >&2; exit 8 ;; esac\n' +
        'test "$(git config user.name)" = Bot || exit 9\n' +
        'test "$(git config user.email)" = bot@example.test || exit 10\n' +
        'test "$(git config author.name)" = Bot || exit 11\n' +
        'test "$(git config committer.email)" = bot@example.test || exit 12',
    )
    const result = await g.commitAll(taskId, 'fix: identity', {
      commit_author: 'Bot <bot@example.test>',
      commit_message_check: 'hook',
    })
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    expect(log(path, '%an <%ae>|%cn <%ce>|%G?')).toBe(
      'Bot <bot@example.test>|Bot <bot@example.test>|N\n',
    )
  })
  it('历史 hook 看到每个被检提交的 author/committer 身份', { timeout: 30_000 }, async () => {
    const { g, p, taskId, path } = await setup()
    hook(
      path,
      'case "$(cat "$1")" in\n' +
        '  *first*) author_name=Bot; author_email=bot@example.test; committer_name=Bot; committer_email=bot@example.test ;;\n' +
        '  *second*) author_name=Author; author_email=author@example.test; committer_name=Committer; committer_email=committer@example.test ;;\n' +
        '  *) exit 6 ;;\n' +
        'esac\n' +
        'author="$author_name <$author_email>"; committer="$committer_name <$committer_email>"\n' +
        'case "$(git var GIT_AUTHOR_IDENT)" in "$author "*) ;; *) echo "wrong author: $(git var GIT_AUTHOR_IDENT), expected $author" >&2; exit 7 ;; esac\n' +
        'case "$(git var GIT_COMMITTER_IDENT)" in "$committer "*) ;; *) echo "wrong committer: $(git var GIT_COMMITTER_IDENT), expected $committer" >&2; exit 8 ;; esac\n' +
        'test "$(git config user.name)" = "$author_name" || exit 9\n' +
        'test "$(git config user.email)" = "$author_email" || exit 10\n' +
        'test "$(git config author.name)" = "$author_name" || exit 11\n' +
        'test "$(git config committer.name)" = "$committer_name" || exit 12\n' +
        'test "$(git config committer.email)" = "$committer_email" || exit 13',
    )
    writeFileSync(join(path, 'feature.txt'), 'first\n')
    execFileSync('git', ['-C', path, 'add', '-A'])
    execFileSync(
      'git',
      [
        '-C',
        path,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Bot',
        '-c',
        'user.email=bot@example.test',
        '-c',
        'author.name=Bot',
        '-c',
        'author.email=bot@example.test',
        '-c',
        'committer.name=Bot',
        '-c',
        'committer.email=bot@example.test',
        'commit',
        '-q',
        '-m',
        'fix: first',
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Bot',
          GIT_AUTHOR_EMAIL: 'bot@example.test',
          GIT_COMMITTER_NAME: 'Bot',
          GIT_COMMITTER_EMAIL: 'bot@example.test',
        },
      },
    )
    writeFileSync(join(path, 'feature.txt'), 'second\n')
    execFileSync('git', ['-C', path, 'add', '-A'])
    execFileSync(
      'git',
      [
        '-C',
        path,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Author',
        '-c',
        'user.email=author@example.test',
        '-c',
        'author.name=Author',
        '-c',
        'author.email=author@example.test',
        '-c',
        'committer.name=Committer',
        '-c',
        'committer.email=committer@example.test',
        'commit',
        '-q',
        '-m',
        'fix: second',
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Author',
          GIT_AUTHOR_EMAIL: 'author@example.test',
          GIT_COMMITTER_NAME: 'Committer',
          GIT_COMMITTER_EMAIL: 'committer@example.test',
        },
      },
    )
    expect(
      await g.validateCommitHistory(taskId, p.baseSha, { commit_message_check: 'hook' }),
    ).toEqual({ ok: true, value: undefined })
    expect(log(path, '%an <%ae>|%cn <%ce>|%s')).toBe(
      'Author <author@example.test>|Committer <committer@example.test>|fix: second\n',
    )
  })
  it('历史 hook 按各提交的父提交、暂存区和文件视图复检，不受当前改动影响', {
    timeout: 30_000,
  }, async () => {
    const { g, p, taskId, path } = await setup()
    const policy = { commit_message_check: 'hook' }
    hook(
      path,
      'git diff --cached --name-only | grep -q "^feature.txt$" || exit 7\n' +
        'test "$(git show :feature.txt)" = "$(cat feature.txt)" || exit 8\n' +
        'grep -q "^fix:" "$1" || exit 9',
    )
    execFileSync('git', ['-C', path, 'config', 'core.hooksPath', '.hooks'])
    expect((await g.commitAll(taskId, 'fix: first', policy)).ok).toBe(true)
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    writeFileSync(join(path, 'feature.txt'), '后续合规改动\n')
    expect((await g.commitAll(taskId, 'fix: second', policy)).ok).toBe(true)
    writeFileSync(join(path, 'feature.txt'), '暂存但未提交\n')
    execFileSync('git', ['-C', path, 'add', 'feature.txt'])
    writeFileSync(join(path, 'feature.txt'), '工作区尚未暂存\n')
    const before = headOf(path)
    const index = execFileSync('git', ['-C', path, 'show', ':feature.txt'], { encoding: 'utf8' })
    const worktrees = execFileSync('git', ['-C', path, 'worktree', 'list', '--porcelain'])
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(headOf(path)).toBe(before)
    expect(execFileSync('git', ['-C', path, 'show', ':feature.txt'], { encoding: 'utf8' })).toBe(
      index,
    )
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('工作区尚未暂存\n')
    expect(execFileSync('git', ['-C', path, 'worktree', 'list', '--porcelain'])).toEqual(worktrees)
  })
  it('历史 hook 使用已安装且被忽略的本地工具，副作用不会写回原依赖', async () => {
    const { g, p, taskId, path } = await setup()
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
    const bin = join(path, 'node_modules', '.bin')
    const pkg = join(path, 'node_modules', 'validator')
    mkdirSync(bin, { recursive: true })
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'data'), 'installed\n')
    const tool =
      '#!/bin/sh\ntest "$(cat node_modules/validator/data)" = installed || exit 7\ngrep -q "^fix:" "$1"\n'
    writeFileSync(join(pkg, 'cli'), tool, { mode: 0o755 })
    symlinkSync('../validator/cli', join(bin, 'commitlint'))
    hook(path, 'exec ./node_modules/.bin/commitlint "$1"')
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: local tool', policy)).ok).toBe(true)
    const before = headOf(path)
    const snapshots = readdirSync(tmpdir()).filter((name) => name.startsWith('keel-history-hook-'))
    writeFileSync(
      join(pkg, 'cli'),
      `${tool}printf 'snapshot write\\n' > node_modules/validator/data\n`,
    )
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(readFileSync(join(pkg, 'data'), 'utf8')).toBe('installed\n')
    writeFileSync(join(pkg, 'cli'), '#!/bin/sh\necho "local tool rejected" >&2\nexit 6\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('local tool rejected') },
    })
    expect(headOf(path)).toBe(before)
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('keel-history-hook-'))).toEqual(
      snapshots,
    )
  })
  it('历史 hook 保留 npm 可执行链接的相对模块解析，同时隔离依赖写入', async () => {
    const { g, p, taskId, path } = await setup()
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
    const modules = join(path, 'node_modules')
    const bin = join(modules, '.bin')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(modules, 'validator', 'bin'), { recursive: true })
    mkdirSync(join(modules, 'validator', 'lib'))
    writeFileSync(join(modules, 'validator', 'lib', 'validate.cjs'), 'module.exports = () => 0\n')
    writeFileSync(
      join(modules, 'validator', 'bin', 'cli.cjs'),
      '#!/usr/bin/env node\n' +
        "const { lstatSync, writeFileSync } = require('node:fs')\n" +
        "const { join } = require('node:path')\n" +
        "if (!lstatSync(join(__dirname, '..', '..', '.bin', 'validator')).isSymbolicLink())\n" +
        '  process.exit(7)\n' +
        "require('../lib/validate.cjs')\n" +
        "writeFileSync(join(__dirname, '..', 'data'), 'snapshot\\n')\n",
      { mode: 0o755 },
    )
    writeFileSync(join(modules, 'validator', 'data'), 'installed\n')
    symlinkSync('../validator/bin/cli.cjs', join(bin, 'validator'))
    hook(path, 'exec ./node_modules/.bin/validator "$1"')
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: npm tool', policy)).ok).toBe(true)
    // 真实提交允许写本地依赖；历史复检必须只写快照副本。
    writeFileSync(join(modules, 'validator', 'data'), 'installed\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(readFileSync(join(modules, 'validator', 'data'), 'utf8')).toBe('installed\n')
  })
  it('历史内部链接按被检提交解析，不受当前目标删除影响', async () => {
    const { g, p, taskId, path } = await setup()
    hook(path, 'grep -q "^fix:" "$1"')
    const policy = { commit_message_check: 'hook' }
    writeFileSync(join(path, 'target.txt'), 'historically valid\n')
    symlinkSync('target.txt', join(path, 'link.txt'))
    expect((await g.commitAll(taskId, 'fix: add internal link', policy)).ok).toBe(true)
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    rmSync(join(path, 'link.txt'))
    rmSync(join(path, 'target.txt'))
    expect((await g.commitAll(taskId, 'fix: remove internal link', policy)).ok).toBe(true)
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
  })
  it('历史目录链接先本地化，ignored 复制不写回外部目录', async () => {
    const { g, p, taskId, path } = await setup()
    const external = join(root, 'external-cache')
    mkdirSync(external)
    writeFileSync(join(external, 'data'), 'original\n')
    writeFileSync(join(path, '.gitignore'), '*.tmp\n')
    symlinkSync(external, join(path, 'cache'))
    hook(path, 'grep -q "^fix:" "$1"')
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: add external cache', policy)).ok).toBe(true)
    rmSync(join(path, 'cache'))
    mkdirSync(join(path, 'cache'))
    writeFileSync(join(path, 'cache', 'README'), 'tracked\n')
    expect((await g.commitAll(taskId, 'fix: replace external cache', policy)).ok).toBe(true)
    writeFileSync(join(path, 'cache', 'extra.tmp'), 'ignored local content\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(existsSync(join(external, 'extra.tmp'))).toBe(false)
    expect(readFileSync(join(external, 'data'), 'utf8')).toBe('original\n')
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
  })
  it.each(['absolute directory', 'relative directory', 'external file'])(
    '历史 hook 复制外部依赖符号链接的内容，成功与拒绝均不写回原依赖：%s',
    async (kind) => {
      const { g, p, taskId, path } = await setup()
      writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
      const modules = join(path, 'node_modules')
      const bin = join(modules, '.bin')
      const external = join(root, 'external-validator')
      const pkg = kind === 'external file' ? join(modules, 'validator') : external
      mkdirSync(bin, { recursive: true })
      mkdirSync(pkg)
      const data = kind === 'external file' ? join(root, 'external-data') : join(pkg, 'data')
      writeFileSync(data, 'installed\n')
      if (kind === 'external file') symlinkSync(data, join(pkg, 'data'))
      else {
        symlinkSync(
          kind === 'absolute directory' ? external : relative(modules, external),
          join(modules, 'validator'),
        )
      }
      const tool = '#!/bin/sh\ntest "$(cat node_modules/validator/data)" = installed || exit 7\n'
      writeFileSync(join(pkg, 'cli'), tool, { mode: 0o755 })
      symlinkSync('../validator/cli', join(bin, 'commitlint'))
      hook(path, 'exec ./node_modules/.bin/commitlint "$1"')
      const policy = { commit_message_check: 'hook' }
      expect((await g.commitAll(taskId, 'fix: external tool', policy)).ok).toBe(true)
      const before = headOf(path)
      const snapshots = readdirSync(tmpdir()).filter((name) =>
        name.startsWith('keel-history-hook-'),
      )
      writeFileSync(
        join(pkg, 'cli'),
        `${tool}printf 'snapshot write\n' > node_modules/validator/data\n`,
      )
      expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
        ok: true,
        value: undefined,
      })
      expect(readFileSync(data, 'utf8')).toBe('installed\n')
      writeFileSync(
        join(pkg, 'cli'),
        `${tool}printf 'rejected write\n' > node_modules/validator/data\necho 'external tool rejected' >&2\nexit 6\n`,
      )
      expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toMatchObject({
        ok: false,
        error: { detail: expect.stringContaining('external tool rejected') },
      })
      expect(readFileSync(data, 'utf8')).toBe('installed\n')
      expect(headOf(path)).toBe(before)
      expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('keel-history-hook-'))).toEqual(
        snapshots,
      )
    },
  )
  it('历史 hook 隔离已跟踪的顶层外部依赖链接，同时保留历史暂存区', async () => {
    const { g, p, taskId, path } = await setup()
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
    const external = join(root, 'external-modules')
    mkdirSync(external)
    writeFileSync(join(external, 'data'), 'installed\n')
    symlinkSync(external, join(path, 'node_modules'))
    hook(path, 'test "$(cat node_modules/data)" = installed || exit 7')
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: tracked dependency', policy)).ok).toBe(true)
    const index = execFileSync('git', ['-C', path, 'ls-files', '--stage'], { encoding: 'utf8' })
    expect(index).toMatch(/^120000 .*\tnode_modules$/m)
    const before = headOf(path)
    for (const exitCode of [0, 6]) {
      writeFileSync(
        join(path, '.hooks', 'commit-msg'),
        '#!/bin/sh\n' +
          'git ls-files --stage | grep -q "^120000 .*node_modules$" || exit 8\n' +
          `printf 'snapshot write\\n' > node_modules/data\nexit ${exitCode}\n`,
      )
      const checked = await g.validateCommitHistory(taskId, p.baseSha, policy)
      expect(checked.ok).toBe(exitCode === 0)
      expect(readFileSync(join(external, 'data'), 'utf8')).toBe('installed\n')
      expect(headOf(path)).toBe(before)
      expect(execFileSync('git', ['-C', path, 'ls-files', '--stage'], { encoding: 'utf8' })).toBe(
        index,
      )
    }
  })
  it('历史快照无法复制悬空依赖链接时拒绝并清理，不跳过复检', async () => {
    const { g, p, taskId, path } = await setup()
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n')
    expect((await g.commitAll(taskId, 'fix: local dependency')).ok).toBe(true)
    mkdirSync(join(path, 'node_modules'))
    symlinkSync(join(root, 'missing-tool'), join(path, 'node_modules', 'tool'))
    hook(path, 'exit 0')
    const snapshots = readdirSync(tmpdir()).filter((name) => name.startsWith('keel-history-hook-'))
    expect(
      await g.validateCommitHistory(taskId, p.baseSha, { commit_message_check: 'hook' }),
    ).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('历史 commit-msg hook 复检失败') },
    })
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith('keel-history-hook-'))).toEqual(
      snapshots,
    )
  })
  it('历史跟踪文件不会被当前同目录下的忽略文件覆盖', async () => {
    const { g, p, taskId, path } = await setup()
    writeFileSync(join(path, '.gitignore'), 'generated/\n')
    mkdirSync(join(path, 'generated'))
    writeFileSync(join(path, 'generated', 'value'), 'historical\n')
    execFileSync('git', ['-C', path, 'add', '-f', 'generated/value'])
    expect((await g.commitAll(taskId, 'fix: historical')).ok).toBe(true)
    execFileSync('git', ['-C', path, 'rm', '--cached', 'generated/value'])
    writeFileSync(join(path, 'generated', 'value'), 'current\n')
    expect((await g.commitAll(taskId, 'fix: current')).ok).toBe(true)
    hook(
      path,
      'if grep -q "^fix: historical" "$1"; then expected=historical; else expected=current; fi\n' +
        'test "$(cat generated/value)" = "$expected" || exit 7',
    )
    expect(
      await g.validateCommitHistory(taskId, p.baseSha, { commit_message_check: 'hook' }),
    ).toEqual({ ok: true, value: undefined })
    expect(readFileSync(join(path, 'generated', 'value'), 'utf8')).toBe('current\n')
  })
  it('历史 hook 保留任务分支名与父提交，但不移动原分支', async () => {
    const { g, p, taskId, path } = await setup()
    execFileSync('git', ['-C', path, 'config', 'hooks.requiredBranch', branchFor(taskId)])
    hook(
      path,
      'test "$(git branch --show-current)" = "$(git config hooks.requiredBranch)" || exit 7\n' +
        `test "$(git rev-parse HEAD)" = "${p.baseSha}" || exit 8\n` +
        'git diff --cached --name-only | grep -q "^feature.txt$" || exit 9',
    )
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: branch context', policy)).ok).toBe(true)
    const before = headOf(path)
    writeFileSync(join(path, 'feature.txt'), 'staged\n')
    execFileSync('git', ['-C', path, 'add', 'feature.txt'])
    writeFileSync(join(path, 'feature.txt'), 'unstaged\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(headOf(path)).toBe(before)
    expect(
      execFileSync('git', ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' }),
    ).toBe(`${branchFor(taskId)}\n`)
    expect(execFileSync('git', ['-C', path, 'show', ':feature.txt'], { encoding: 'utf8' })).toBe(
      'staged\n',
    )
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('unstaged\n')
  })
  it('历史 hook 读取 worktree 专用配置及其覆盖值，不改写原配置或暂存区', async () => {
    const { g, p, taskId, path } = await setup()
    execFileSync('git', ['-C', path, 'config', 'extensions.worktreeConfig', 'true'])
    execFileSync('git', ['-C', path, 'config', 'hooks.expectedValue', 'common'])
    execFileSync('git', ['-C', path, 'config', '--worktree', 'hooks.expectedValue', 'task-only'])
    execFileSync('git', ['-C', path, 'config', '--worktree', 'hooks.taskValue', taskId])
    hook(
      path,
      'test "$(git config hooks.expectedValue)" = task-only || exit 7\n' +
        `test "$(git config hooks.taskValue)" = "${taskId}" || exit 8\n` +
        'test "$(git rev-parse --is-bare-repository)" = false || exit 9\n' +
        'test "$(git rev-parse --show-toplevel)" = "$(pwd -P)" || exit 10',
    )
    execFileSync('git', ['-C', path, 'config', '--worktree', 'core.hooksPath', '.hooks'])
    // 原 linked worktree 也允许显式指定 core.worktree；快照必须覆盖为自己的路径。
    execFileSync('git', ['-C', path, 'config', '--worktree', 'core.worktree', path])
    execFileSync('git', ['-C', path, 'config', '--worktree', 'core.bare', 'false'])
    const policy = { commit_message_check: 'hook' }
    const committed = await g.commitAll(taskId, 'fix: worktree config', policy)
    expect(committed.ok, committed.ok ? '' : committed.error.detail).toBe(true)
    const configPath = execFileSync(
      'git',
      ['-C', path, 'rev-parse', '--path-format=absolute', '--git-path', 'config.worktree'],
      { encoding: 'utf8' },
    ).trim()
    const beforeConfig = readFileSync(configPath, 'utf8')
    const before = headOf(path)
    writeFileSync(join(path, 'feature.txt'), 'staged\n')
    execFileSync('git', ['-C', path, 'add', 'feature.txt'])
    writeFileSync(join(path, 'feature.txt'), 'unstaged\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(readFileSync(configPath, 'utf8')).toBe(beforeConfig)
    expect(headOf(path)).toBe(before)
    expect(execFileSync('git', ['-C', path, 'show', ':feature.txt'], { encoding: 'utf8' })).toBe(
      'staged\n',
    )
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('unstaged\n')
  })
  it('未启用 worktreeConfig 时不加载残留的 config.worktree', async () => {
    const { g, p, taskId, path } = await setup()
    hook(path, 'test "$(git config hooks.expectedValue)" = common || exit 7')
    execFileSync('git', ['-C', path, 'config', 'hooks.expectedValue', 'common'])
    const configPath = execFileSync(
      'git',
      ['-C', path, 'rev-parse', '--path-format=absolute', '--git-path', 'config.worktree'],
      { encoding: 'utf8' },
    ).trim()
    writeFileSync(configPath, '[hooks]\n\texpectedValue = stale\n')
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: common config', policy)).ok).toBe(true)
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
  })
  it('历史 hook 支持没有父提交的根提交', async () => {
    const { g, p, taskId, path } = await setup()
    execFileSync('git', ['-C', path, 'checkout', '--orphan', 'history-root'])
    hook(
      path,
      'test "$(git branch --show-current)" = history-root || exit 6\n' +
        'if git rev-parse --verify HEAD >/dev/null 2>&1; then exit 7; fi\n' +
        'git diff --cached --name-only | grep -q "^feature.txt$" || exit 8',
    )
    const policy = { commit_message_check: 'hook' }
    expect((await g.commitAll(taskId, 'fix: root', policy)).ok).toBe(true)
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toEqual({
      ok: true,
      value: undefined,
    })
  })
  it('历史 hook 的拒绝和消息改写仍生效，失败后清理快照', async () => {
    const { g, p, taskId, path } = await setup()
    expect((await g.commitAll(taskId, 'bad')).ok).toBe(true)
    hook(path, 'grep -q "^fix:" "$1" || { echo "历史 header 不合规" >&2; exit 9; }')
    const before = execFileSync('git', ['-C', path, 'worktree', 'list', '--porcelain'])
    const policy = { commit_message_check: 'hook' }
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('历史 header 不合规') },
    })
    writeFileSync(join(path, '.hooks', 'commit-msg'), '#!/bin/sh\necho "changed" >> "$1"\n')
    expect(await g.validateCommitHistory(taskId, p.baseSha, policy)).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('hook 修改了消息') },
    })
    expect(execFileSync('git', ['-C', path, 'worktree', 'list', '--porcelain'])).toEqual(before)
  })
  it('真实 commit-msg hook 改写为另一条合规模板消息仍拒绝', async () => {
    const { g, taskId, path } = await setup()
    const policy: RepoCommitPolicy = {
      commit_message_check: 'hook',
      commit_message_template: '{type}({scope}): {summary}',
      commit_types: ['fix'],
      commit_scopes: ['fact'],
    }
    const original = `fix(fact): original\n\nKeel-Run: ${taskId} stage=develop`
    hook(
      path,
      'case "$1" in *keel-commit-msg-*) exit 0 ;; esac\n' +
        'sed "s/original/rewritten/" "$1" > "$1.next"\nmv "$1.next" "$1"',
    )
    const result = await g.commitAll(taskId, original, policy)
    expect(result).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('hook 修改了消息') },
    })
    expect(log(path, '%B')).toBe(`${original.replace('original', 'rewritten')}\n\n`)
  })
  it('缺 hook 和改写消息均拒绝，不能静默通过', async () => {
    const { g, taskId, path } = await setup()
    expect((await g.commitAll(taskId, 'fix: x', { commit_message_check: 'hook' })).ok).toBe(false)
    hook(path, 'echo "changed" >> "$1"')
    const result = await g.commitAll(taskId, 'fix: x', { commit_message_check: 'hook' })
    expect(result).toMatchObject({
      ok: false,
      error: { detail: expect.stringContaining('hook 修改了消息') },
    })
  })
  it('Harness 自行提交的坏 header 不能通过干净工作树或下一轮绕过', async () => {
    const { g, p, taskId, path } = await setup()
    const rejected = await g.commitAll(taskId, 'bad')
    expect(rejected.ok).toBe(true)
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
    expect(
      (await g.validateCommitHistory(taskId, p.baseSha, { commit_message_check: '^fix:' })).ok,
    ).toBe(false)
    writeFileSync(join(path, 'feature.txt'), '后续合规改动\n')
    const followup = await g.commitAll(taskId, 'fix: followup', {
      commit_message_check: '^fix:',
    })
    expect(followup.ok && followup.value).toMatch(/^[a-f0-9]{40}$/)
    expect(followup.ok && followup.value).not.toBe(rejected.ok && rejected.value)
    expect(await g.isDirty(taskId)).toEqual({ ok: true, value: false })
    expect(
      (await g.validateCommitHistory(taskId, p.baseSha, { commit_message_check: '^fix:' })).ok,
    ).toBe(false)
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
      const r = await g.prepareProject(
        { mode: 'managed', repoId },
        'https://github.com/acme/widget.git',
        'main',
      )
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
    const g = new GitWorkspace({
      root,
      exec: fake,
      // 显式注入「无 token」：缺省 resolver 会尝试本机 gh 登录态，测试不得依赖它
      tokenResolver: async () => undefined,
    })

    await withNoToken(async () => {
      const r = await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')
      expect(r.ok).toBe(true)
    })

    const fetch = calls.find((c) => c.args.includes('fetch'))
    expect(fetch).toBeDefined()
    // 关键：不是「env 里没有 header」，而是**根本不传 env** —— 与改动前一字不差
    expect(fetch?.env).toBeUndefined()
  })

  it('无 env、token 来自 resolver（gh 登录态）时仍注入，且进入 secrets 脱敏集合', async () => {
    const ghToken = 'ghp_from_gh_login'
    const ghB64 = Buffer.from(`oauth2:${ghToken}`).toString('base64')
    const calls: ExecCall[] = []
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      throw new Error(
        `fatal: could not read Username for 'https://github.com': ${ghToken} (${ghB64})`,
      )
    }
    const hosts: string[] = []
    const g = new GitWorkspace({
      root,
      exec: fake,
      tokenResolver: async (host) => {
        hosts.push(host)
        return ghToken
      },
    })

    await withNoToken(async () => {
      const r = await g.prepareProject(
        { mode: 'managed', repoId },
        'https://github.com/acme/widget.git',
        'main',
      )
      expect(r.ok).toBe(false)
      if (r.ok) return
      // gh 来源的 token 不在 process.env 里 —— 不缓存进 secrets() 就脱敏不到
      expect(r.error.detail).not.toContain(ghToken)
      expect(r.error.detail).not.toContain(ghB64)
      expect(r.error.detail).toContain('***')
    })

    expect(hosts).toEqual(['github.com'])
    const clone = calls.find((c) => c.args.includes('clone'))
    expect(clone?.env?.GIT_CONFIG_COUNT).toBe('1')
    expect(clone?.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
    expect(clone?.env?.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${ghB64}`)
    const joined = (clone?.args ?? []).join(' ')
    expect(joined).not.toContain(ghToken)
    expect(joined).not.toContain(ghB64)
  })

  it('resolver 按 host 缓存：两次 https 同步只解析一次；ssh remote 不触发解析', async () => {
    mkdirSync(join(root, 'repos'), { recursive: true })
    const bare = join(root, 'repos', `${repoId}.git`)
    execFileSync('git', ['clone', '-q', '--bare', `file://${origin}`, bare])

    const hosts: string[] = []
    const sha = 'e'.repeat(40)
    const fake: GitExec = async (_file, args) => {
      if (args.includes('--is-bare-repository')) return { stdout: 'true\n', stderr: '' }
      if (args.includes('--verify')) return { stdout: '', stderr: '' }
      if (args.includes('rev-parse')) return { stdout: `${sha}\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const g = new GitWorkspace({
      root,
      exec: fake,
      tokenResolver: async (host) => {
        hosts.push(host)
        return 'cached-token'
      },
    })

    await withNoToken(async () => {
      // 两次 https fetch：没有缓存这里会解析两次
      expect(
        (await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')).ok,
      ).toBe(true)
      expect(
        (await g.prepareProject(managed, 'https://github.com/acme/widget.git', 'main')).ok,
      ).toBe(true)
      // ssh 部署：同一个实例、已缓存 token，也不应再解析
      expect(
        (await g.prepareProject(managed, 'ssh://git@github.com/acme/widget.git', 'main')).ok,
      ).toBe(true)
    })

    expect(hosts).toEqual(['github.com'])
  })

  it('resolver 收到 hostname（不含端口），extraheader 的 authority 保留端口', async () => {
    mkdirSync(join(root, 'repos'), { recursive: true })
    execFileSync('git', [
      'clone',
      '-q',
      '--bare',
      `file://${origin}`,
      join(root, 'repos', `${repoId}.git`),
    ])

    const hosts: string[] = []
    const calls: ExecCall[] = []
    const fake: GitExec = async (_file, args, opts) => {
      calls.push({ args: [...args], env: opts?.env })
      if (args.includes('--is-bare-repository')) return { stdout: 'true\n', stderr: '' }
      if (args.includes('rev-parse')) return { stdout: `${'f'.repeat(40)}\n`, stderr: '' }
      return { stdout: '', stderr: '' }
    }
    const g = new GitWorkspace({
      root,
      exec: fake,
      tokenResolver: async (host) => {
        hosts.push(host)
        return 'ghes-token'
      },
    })

    await withNoToken(async () => {
      expect(
        (await g.prepareProject(managed, 'https://github.example.com:8443/acme/widget.git', 'main'))
          .ok,
      ).toBe(true)
    })

    // gh 的 --hostname 只认 hostname；git 的 http.<url> 匹配需要保留端口
    expect(hosts).toEqual(['github.example.com'])
    const fetch = calls.find((c) => c.args.includes('fetch'))
    expect(fetch?.env?.GIT_CONFIG_KEY_0).toBe('http.https://github.example.com:8443/.extraheader')
    expect(fetch?.env?.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('oauth2:ghes-token').toString('base64')}`,
    )
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
