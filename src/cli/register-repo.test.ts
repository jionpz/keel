/**
 * register-repo 的绑定语义。
 *
 * 全部用真实临时 git 仓库与真实数据库，不 mock：
 * 这条命令的价值就在「校验 + 唯一约束 + 更新语义」三者的交界，
 * 任一环用 mock 都会把真正会出问题的地方替换成假设。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asOwner, closePool } from '../fact/db.js'
import { registerRepoMain } from './register-repo.js'

let sandbox: string

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'keel-register-')))
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(sandbox, { recursive: true, force: true })
})

afterAll(closePool)

function remote(name: string): string {
  return `https://github.com/acme/${name}.git`
}

function gitRepo(name: string, origin: string): string {
  const dir = join(sandbox, name)
  mkdirSync(dir)
  execFileSync('git', ['init', '--quiet', dir])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin])
  return dir
}

interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | string | undefined
}

async function run(args: readonly string[]): Promise<RunResult> {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...v: unknown[]) => {
    out.push(v.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...v: unknown[]) => {
    err.push(v.map(String).join(' '))
  })
  process.exitCode = undefined
  await registerRepoMain(args)
  return {
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    exitCode: process.exitCode,
  }
}

async function repoRow(
  remoteUrl: string,
): Promise<{ id: string; local_path: string | null; issue_label: string }> {
  const r = await asOwner((c) =>
    c.query<{ id: string; local_path: string | null; issue_label: string }>(
      `SELECT id, local_path, issue_label FROM repo WHERE remote_url = $1`,
      [remoteUrl],
    ),
  )
  const row = r.rows[0]
  if (row === undefined) throw new Error(`repo 不存在：${remoteUrl}`)
  return row
}

async function repoCount(): Promise<number> {
  const r = await asOwner((c) => c.query('SELECT id FROM repo'))
  return r.rows.length
}

async function defaultBranchOf(remoteUrl: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ default_branch: string }>(`SELECT default_branch FROM repo WHERE remote_url = $1`, [
      remoteUrl,
    ]),
  )
  const row = r.rows[0]
  if (row === undefined) throw new Error(`repo 不存在：${remoteUrl}`)
  return row.default_branch
}

describe('首次注册与绑定', () => {
  it('Issue 回写默认 off，显式更新并在不传参数时保留，非法值零写入', async () => {
    const url = remote('writeback')
    await run([url])
    const mode = () =>
      asOwner(
        async (client) =>
          (await client.query('SELECT issue_writeback FROM repo WHERE remote_url=$1', [url]))
            .rows[0]?.issue_writeback,
      )
    expect(await mode()).toBe('off')
    await run([url, '--issue-writeback', 'comment_and_close'])
    await run([url, '--issue-label', 'ready'])
    expect(await mode()).toBe('comment_and_close')
    const invalid = await run([url, '--issue-writeback', 'yes'])
    expect(invalid.exitCode).toBe(1)
    expect(await mode()).toBe('comment_and_close')
    expect(await repoCount()).toBe(1)
  })
  it('合法目录 + 匹配 origin → 写入规范化后的绝对路径', async () => {
    const dir = gitRepo('widgets', 'https://github.com/acme/widgets')
    const r = await run([remote('widgets'), '--local-path', `${dir}/`])

    expect(r.exitCode).toBeUndefined()
    expect(r.stdout).toContain('repoId: ')
    expect(r.stdout).toContain(`localPath: ${dir}`)
    const row = await repoRow(remote('widgets'))
    expect(row.local_path).toBe(dir)
  })

  it('不带 --local-path → managed 模式（local_path 为 NULL）', async () => {
    const r = await run([remote('plain')])
    expect(r.exitCode).toBeUndefined()
    const row = await repoRow(remote('plain'))
    expect(row.local_path).toBeNull()
  })
})

describe('校验失败 → 零写入', () => {
  it('目录不存在 → local_path_missing', async () => {
    const r = await run([remote('x'), '--local-path', join(sandbox, 'absent')])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[local_path_missing\]/)
    expect(await repoCount()).toBe(0)
  })

  it('不是 git 工作树 → not_a_git_worktree', async () => {
    const dir = join(sandbox, 'plain')
    mkdirSync(dir)
    const r = await run([remote('x'), '--local-path', dir])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[not_a_git_worktree\]/)
    expect(await repoCount()).toBe(0)
  })

  it('origin 不匹配 → origin_mismatch，且不注册', async () => {
    const dir = gitRepo('other', 'https://github.com/acme/other')
    const r = await run([remote('x'), '--local-path', dir])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[origin_mismatch\]/)
    expect(r.stderr).toContain('actual="https://github.com/acme/other"')
    expect(await repoCount()).toBe(0)
  })
})

describe('重复注册与更新', () => {
  it('同一 remote 不带 flag → 幂等，保留原绑定', async () => {
    const dir = gitRepo('widgets', 'https://github.com/acme/widgets')
    await run([remote('widgets'), '--local-path', dir])
    const first = await repoRow(remote('widgets'))

    const again = await run([remote('widgets')])
    expect(again.exitCode).toBeUndefined()
    expect(again.stdout).toContain(`repoId: ${first.id}`)
    expect((await repoRow(remote('widgets'))).local_path).toBe(dir)
    expect(await repoCount()).toBe(1)
  })

  it('managed → attached：先无 flag 注册，再绑定', async () => {
    const dir = gitRepo('widgets', 'https://github.com/acme/widgets')
    const first = await run([remote('widgets')])
    expect((await repoRow(remote('widgets'))).local_path).toBeNull()

    await run([remote('widgets'), '--local-path', dir])
    const row = await repoRow(remote('widgets'))
    expect(row.id).toBe((await repoRow(remote('widgets'))).id)
    expect(row.local_path).toBe(dir)
    expect(first.stdout).toContain(row.id)
  })

  it('attached → 新路径：更新成功并释放旧路径', async () => {
    const oldDir = gitRepo('old', 'https://github.com/acme/widgets')
    const newDir = gitRepo('new', 'https://github.com/acme/widgets')

    await run([remote('widgets'), '--local-path', oldDir])
    await run([remote('widgets'), '--local-path', newDir])
    expect((await repoRow(remote('widgets'))).local_path).toBe(newDir)

    // 旧路径已释放：另一个 remote 可以绑定它（需要 origin 匹配）
    execFileSync('git', ['-C', oldDir, 'remote', 'set-url', 'origin', remote('other')])
    const other = await run([remote('other'), '--local-path', oldDir])
    expect(other.exitCode).toBeUndefined()
    expect((await repoRow(remote('other'))).local_path).toBe(oldDir)
  })

  it('校验失败时已有绑定保持原值', async () => {
    const good = gitRepo('good', 'https://github.com/acme/widgets')
    const bad = gitRepo('bad', 'https://github.com/acme/elsewhere')
    await run([remote('widgets'), '--local-path', good])

    const r = await run([remote('widgets'), '--local-path', bad])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[origin_mismatch\]/)
    expect((await repoRow(remote('widgets'))).local_path).toBe(good)
  })
})

describe('仓库级 issue_label', () => {
  it('新建不带 --issue-label → 默认 keel', async () => {
    const r = await run([remote('plain')])
    expect(r.exitCode).toBeUndefined()
    expect((await repoRow(remote('plain'))).issue_label).toBe('keel')
  })

  it('新建带 --issue-label → 写入显式值（并 trim）', async () => {
    const r = await run([remote('widgets'), '--issue-label', '  需 review  '])
    expect(r.exitCode).toBeUndefined()
    expect(r.stdout).toContain('issueLabel: 需 review')
    expect((await repoRow(remote('widgets'))).issue_label).toBe('需 review')
  })

  it('重复注册不带 flag → 保留原 label', async () => {
    await run([remote('widgets'), '--issue-label', 'triage'])
    await run([remote('widgets')])
    expect((await repoRow(remote('widgets'))).issue_label).toBe('triage')
  })

  it('重复注册带不同 label → 更新；只改 label 不影响 local_path', async () => {
    const dir = gitRepo('widgets', 'https://github.com/acme/widgets')
    await run([remote('widgets'), '--local-path', dir, '--issue-label', 'triage'])

    const r = await run([remote('widgets'), '--issue-label', 'keel'])
    expect(r.exitCode).toBeUndefined()
    const row = await repoRow(remote('widgets'))
    expect(row.issue_label).toBe('keel')
    expect(row.local_path).toBe(dir)
  })

  it('纯数字 label 也是合法名称（argv 会把它解析成 number）', async () => {
    const r = await run([remote('widgets'), '--issue-label', '2024'])
    expect(r.exitCode).toBeUndefined()
    expect((await repoRow(remote('widgets'))).issue_label).toBe('2024')
  })

  it('空白 label → 写库前拒绝，零写入', async () => {
    for (const bad of ['', '   ']) {
      const r = await run([remote('x'), '--issue-label', bad])
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toMatch(/^register-repo: --issue-label 不能为空白/)
    }
    expect(await repoCount()).toBe(0)
  })

  it('--issue-label 不带值 → 拒绝', async () => {
    const r = await run([remote('x'), '--issue-label'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/--issue-label 需要一个非空 label/)
    expect(await repoCount()).toBe(0)
  })
})

describe('--default-branch 的取值纪律（argv 空白串不再归零后的回归）', () => {
  it('省略 → main', async () => {
    await run([remote('plain')])
    expect(await defaultBranchOf(remote('plain'))).toBe('main')
  })

  it('纯数字分支名（argv 会解析成 number）不被静默换成 main', async () => {
    const r = await run([remote('release'), '--default-branch', '2024'])
    expect(r.exitCode).toBeUndefined()
    expect(await defaultBranchOf(remote('release'))).toBe('2024')
  })

  it('空白值 / 只写标志 → 拒绝，零写入', async () => {
    for (const args of [
      [remote('x'), '--default-branch', '   '],
      [remote('x'), '--default-branch'],
    ]) {
      const r = await run(args)
      expect(r.exitCode).toBe(1)
      expect(r.stderr).toMatch(/^register-repo: --default-branch /)
    }
    expect(await repoCount()).toBe(0)
  })
})

describe('路径唯一性', () => {
  it('同一 canonical path 绑定第二个 repo → 错误含两个 repoId', async () => {
    const dir = gitRepo('shared', 'https://github.com/acme/widgets')
    await run([remote('widgets'), '--local-path', dir])
    const first = await repoRow(remote('widgets'))

    // 让目录的 origin 匹配第二个 remote，确保拦住它的是唯一索引而不是 origin 校验
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', remote('gadgets')])
    await run([remote('gadgets')])
    const second = await repoRow(remote('gadgets'))

    const r = await run([remote('gadgets'), '--local-path', dir])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[local_path_taken\]/)
    expect(r.stderr).toContain(`repo="${second.id}"`)
    expect(r.stderr).toContain(`occupied_by="${first.id}"`)
    expect((await repoRow(remote('gadgets'))).local_path).toBeNull()
  })

  it('用路径别名二次绑定同样被拒绝', async () => {
    const dir = gitRepo('shared', 'https://github.com/acme/widgets')
    await run([remote('widgets'), '--local-path', dir])
    const first = await repoRow(remote('widgets'))

    // 同上：绕开 origin 校验，让规范化后的同一路径去撞唯一索引
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', remote('gadgets')])

    const r = await run([remote('gadgets'), '--local-path', `${dir}/./`])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[local_path_taken\]/)
    expect(r.stderr).toContain(`occupied_by="${first.id}"`)
    expect(r.stderr).toContain(dir)
    // 别名没有被当成第二个路径写进去
    expect(await repoCount()).toBe(1)
  })

  it('符号链接别名 → 解析成同一真实路径，撞唯一索引', async () => {
    const dir = gitRepo('shared', remote('widgets'))
    await run([remote('widgets'), '--local-path', dir])
    const first = await repoRow(remote('widgets'))

    // 同上：让 origin 匹配第二个 remote，确保拦住它的是唯一索引
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', remote('gadgets')])
    const link = join(sandbox, 'link-to-shared')
    symlinkSync(dir, link, 'dir')

    const r = await run([remote('gadgets'), '--local-path', link])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/^register-repo: \[local_path_taken\]/)
    expect(r.stderr).toContain(`occupied_by="${first.id}"`)
    // 报出的是真实路径 —— 用户给的是链接名，但绑定的是同一个目录
    expect(r.stderr).toContain(dir)
    expect(r.stderr).not.toContain(link)
    expect(await repoCount()).toBe(1)
  })
})
