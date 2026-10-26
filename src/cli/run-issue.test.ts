/**
 * run-issue 的组合语义 —— 确定性部分。
 *
 * 真实闭环(ingest → OMP 各阶段 → 真实 PR → 真实 CI)在
 * `src/acceptance/issue-e2e.acceptance.test.ts`,不在默认 check 里。
 * 这里只钉住不依赖模型、也不依赖真实 GitHub 的两条:
 *
 *   1. `--ci real` 缺凭据时**先于 ingest** 失败 —— 不留下一个已 ingest
 *      却驱动不了的 task(库里零写入);
 *   2. ingest 侧失败(如 repo 未注册)原样冒泡,不被组合命令吞成成功。
 */

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok } from '../contracts/errors.js'
import { asOwner, closePool } from '../fact/db.js'
import { GitHubProvider } from '../fact/github-provider.js'
import { registerRepoMain } from './register-repo.js'
import { runIssue, runIssueMain } from './run-issue.js'

const NOW = '2026-08-27T12:00:00Z'
const ISSUE_URL = 'https://github.com/acme/widget/issues/42'
const REMOTE = 'https://github.com/acme/widget.git'

const ENV_KEYS = ['KEEL_GITHUB_TOKEN', 'GITHUB_TOKEN'] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
const savedModel = process.env.KEEL_MODEL
const savedHarness = process.env.KEEL_HARNESS
const savedAnthropic = process.env.ANTHROPIC_API_KEY
const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN

let server: Server
let baseUrl: string

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k]
  delete process.env.KEEL_MODEL
  delete process.env.KEEL_HARNESS
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN

  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )

  // 一个**本应能通过闸门**的 Issue:这样「零写入」只可能来自凭据闸门
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        number: 42,
        title: 'Add date filter to export',
        body: 'Users need to filter exports by date range.',
        state: 'open',
        labels: [{ name: 'keel' }],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterAll(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  if (savedModel === undefined) {
    delete process.env.KEEL_MODEL
  } else {
    process.env.KEEL_MODEL = savedModel
  }
  if (savedHarness === undefined) {
    delete process.env.KEEL_HARNESS
  } else {
    process.env.KEEL_HARNESS = savedHarness
  }
  if (savedAnthropic === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = savedAnthropic
  }
  if (savedAuthToken === undefined) {
    delete process.env.ANTHROPIC_AUTH_TOKEN
  } else {
    process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken
  }
  await closePool()
})

function github(): GitHubProvider {
  return new GitHubProvider({ apiRoot: baseUrl, token: 'test' })
}

async function countRows(table: 'feedback' | 'task'): Promise<number> {
  const r = await asOwner((c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
  return Number(r.rows[0]?.n ?? 0)
}

describe('run-issue 组合命令', () => {
  it('--ci real 缺 token → AUTH_FAILED 且零写入(凭据闸门先于 ingest)', async () => {
    await registerRepoMain([REMOTE])

    const r = await runIssue({ issueUrl: ISSUE_URL, ci: 'real', github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    // 已 ingest 再失败 = 库里留一个驱动不了的 task,重跑时状态含糊
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })

  it('ingest 侧失败(repo 未注册)原样冒泡,不被组合成功', async () => {
    const r = await runIssue({ issueUrl: ISSUE_URL, ci: 'passed', github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
    expect(r.error.detail).toMatch(/register-repo/)
    expect(await countRows('task')).toBe(0)
  })

  /**
   * ingest 成功、驱动失败:task 已经在库里了 —— 错误信息必须点出是哪个 task,
   * 否则库里多一个 task 而命令输出从未提过它。
   *
   * 用一个指向不存在路径的 remote 触发确定性失败(git clone 立即报错,不碰网络);
   * repoId 显式传入,所以 remote_url 不必与 Issue URL 同源。
   */
  it('驱动失败时错误里带上已 ingest 的 taskId', async () => {
    const repoId = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
         VALUES ($1, 'github', $2, 'main')`,
        [repoId, `file:///nonexistent/keel-${repoId}.git`],
      ),
    )

    const r = await runIssue({
      issueUrl: ISSUE_URL,
      ci: 'passed',
      repoId,
      github: github(),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')

    const taskRow = await asOwner((c) => c.query<{ id: string }>('SELECT id FROM task'))
    const taskId = taskRow.rows[0]?.id
    expect(taskId, 'ingest 应已建好 task').toBeDefined()
    expect(r.error.detail).toContain(taskId ?? '/无 task/')
    // 原始原因不能被外层信息盖掉
    expect(r.error.cause?.kind).toBe('WORKSPACE_ERROR')
  })

  it('空白 model 先于 ingest 失败(CAPABILITY_UNSUPPORTED 且零写入)', async () => {
    await registerRepoMain([REMOTE])

    const r = await runIssue({
      issueUrl: ISSUE_URL,
      ci: 'passed',
      model: '   ',
      github: github(),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/空白/)
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })

  it('非法 harness 先于 ingest 失败(零写入、不回退 omp)', async () => {
    await registerRepoMain([REMOTE])

    const r = await runIssue({
      issueUrl: ISSUE_URL,
      ci: 'passed',
      harness: 'codex',
      github: github(),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })

  it('harness=claude 未登录先于 ingest 失败(AUTH_FAILED 且零写入)', async () => {
    await registerRepoMain([REMOTE])

    const r = await runIssue({
      issueUrl: ISSUE_URL,
      ci: 'passed',
      harness: 'claude',
      claudeAuthProbe: () => false,
      github: github(),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.detail).toMatch(/--bare/)
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })
})

describe('runIssueMain · --wall-clock 闸门', () => {
  it('600 透传进 runIssue 的 wallClockS（注入替身，不起真进程）', async () => {
    const seen: number[] = []
    const stub: typeof runIssue = async (opts) => {
      seen.push(opts.wallClockS ?? -1)
      return ok({
        taskId: 't',
        feedbackId: 'f',
        created: false,
        finalStatus: 'S-DONE',
        steps: [],
        stopReason: 'terminal',
        prUrl: null,
      })
    }
    await runIssueMain([ISSUE_URL, '--wall-clock', '600'], { runIssue: stub })
    expect(seen).toEqual([600])
  })

  it('非法墙钟在 ingest 之前拒绝(退出码 1，零写入)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prevCode = process.exitCode
    try {
      await runIssueMain([ISSUE_URL, '--wall-clock', '0'])
      expect(process.exitCode).toBe(1)
      expect(errSpy.mock.calls.flat().join(' ')).toContain('正整数')
    } finally {
      errSpy.mockRestore()
      process.exitCode = prevCode
    }
    // 闸门在 ingest 之前:不能因为参数写错而留下一个 task
    expect(await countRows('task')).toBe(0)
    expect(await countRows('feedback')).toBe(0)
  })
})
