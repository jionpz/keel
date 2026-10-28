/**
 * `keel status` 的**工作区段**。
 *
 * 本功能对用户的可见部分只有这里：绑在哪个项目、PR 从哪个 commit 长出来、
 * 本地工作树是否脏/偏基。测的是这段输出，不改也不重测既有的
 * task / run / events 格式。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { asOwner, closePool } from '../fact/db.js'
import { statusMain } from './status.js'

const dirs: string[] = []

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** 真 git 仓库：status 只读地跑 status/rev-list，桩一个假目录就测不到这两条 */
function gitRepo(prefix: string): string {
  const d = tempDir(prefix)
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: d })
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: d })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: d })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: d })
  writeFileSync(join(d, 'README.md'), '# base\n')
  execFileSync('git', ['add', '.'], { cwd: d })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: d })
  return d
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  await closePool()
})

async function seedTask(localPath: string | null): Promise<{ taskId: string; repoId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch, local_path)
       VALUES ($1,'local',$2,'main',$3)`,
      [repoId, `file://${tempDir('keel-status-origin-')}`, localPath],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','status 展示',$2,'main','ai/task-x')`,
      [taskId, repoId],
    )
  })
  return { taskId, repoId }
}

async function emitCreateBranch(taskId: string, payload: Record<string, unknown>): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
       VALUES ($1,'SideEffectApplied',$2::jsonb,'trace-status-test',$3)`,
      [taskId, JSON.stringify({ kind: 'CreateBranch', ...payload }), '2026-10-27T00:00:00Z'],
    ),
  )
}

async function capture(taskId: string): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    await statusMain([taskId])
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

describe('status · workspace 段', () => {
  it('managed：显示绑定模式且不出现 local_path / 本地状态', async () => {
    const { taskId, repoId } = await seedTask(null)
    const out = await capture(taskId)

    expect(out).toContain(`repo ${repoId} (managed)`)
    expect(out).toContain('base (尚无建分支记录)')
    expect(out).not.toContain('local_path')
    expect(out).not.toMatch(/local (dirty|unavailable)/)
  })

  it('attached：显示规范化后的绝对路径与本地状态', async () => {
    const dir = gitRepo('keel-status-att-')
    // 带尾斜杠与冗余分隔符 —— 输出必须是规范化后的同一个目录
    const { taskId, repoId } = await seedTask(`${dir}///`)
    writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n')

    const out = await capture(taskId)
    expect(out).toContain(`repo ${repoId} (attached)`)
    // macOS 的 /var → /private/var；规范化正是要把这层符号链接解开
    expect(out).toContain(`local_path ${realpathSync(dir)}`)
    expect(out).toContain('dirty=yes')
    expect(out).toContain('diverged=')
  })

  it('attached 但目录不存在：原样显示并标注 unresolved，不报错退出', async () => {
    const { taskId } = await seedTask('/nonexistent/keel-status-project')
    const out = await capture(taskId)

    expect(out).toContain('local_path /nonexistent/keel-status-project (unresolved)')
    expect(out).toContain('local unavailable')
  })

  it('基线证据：显示 base_ref@base_sha 与 fetched_at，重放标注 reused', async () => {
    const { taskId } = await seedTask(null)
    const sha = 'a'.repeat(40)
    await emitCreateBranch(taskId, {
      base_ref: 'refs/remotes/origin/main',
      base_sha: sha,
      fetched_at: '2026-10-27T12:00:00.000Z',
      reused: false,
    })
    await emitCreateBranch(taskId, {
      base_ref: 'refs/remotes/origin/main',
      base_sha: sha,
      fetched_at: '2026-10-27T12:00:00.000Z',
      reused: true,
    })

    const out = await capture(taskId)
    expect(out).toContain(
      `base refs/remotes/origin/main@${sha} fetched=2026-10-27T12:00:00.000Z (reused)`,
    )
  })

  it('老 task（事件无 base_sha）：如实标注「无基线证据」，不编造', async () => {
    const { taskId } = await seedTask(null)
    await emitCreateBranch(taskId, { branch: 'ai/task-legacy', worktree: '/tmp/x' })

    const out = await capture(taskId)
    expect(out).toContain('base (unknown)@(无基线证据)')
    expect(out).not.toMatch(/[0-9a-f]{40}/)
  })

  it('输出不含 remote_url（可能带凭据）', async () => {
    const { taskId, repoId } = await seedTask(gitRepo('keel-status-priv-'))
    const out = await capture(taskId)
    expect(out).toContain(`repo ${repoId}`)
    expect(out).not.toContain('file://')
  })
})
