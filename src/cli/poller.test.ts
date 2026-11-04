/**
 * keel poller 的接入层单测：参数校验、凭据前置、依赖接线。
 *
 * 轮询逻辑本身在 `src/ingress/poller.test.ts`；这里只确认 CLI 把正确的东西接上，
 * 且非法参数不会静默退化成缺省值。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ok } from '../contracts/errors.js'
import type { IssueList } from '../fact/github-provider.js'
import {
  DEFAULT_INTERVAL_MS,
  type PollerSignalSource,
  type PollIssueOutcome,
  type RepoRow,
} from '../ingress/poller.js'
import { parseIntervalMs, pollerMain } from './poller.js'

const REPO: RepoRow = {
  id: 'repo-a',
  remote_url: 'https://github.com/acme/alpha.git',
  default_branch: 'main',
  issue_label: 'triage',
}

interface FakeSignals {
  readonly source: PollerSignalSource
  fire(signal: 'SIGTERM' | 'SIGINT'): void
}

function fakeSignals(): FakeSignals {
  const handlers = new Map<'SIGTERM' | 'SIGINT', () => void>()
  return {
    source: {
      on: (signal, handler) => {
        handlers.set(signal, handler)
      },
      off: (signal) => {
        handlers.delete(signal)
      },
    },
    fire: (signal) => handlers.get(signal)?.(),
  }
}

const savedToken = process.env.KEEL_GITHUB_TOKEN

beforeEach(() => {
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  if (savedToken === undefined) delete process.env.KEEL_GITHUB_TOKEN
  else process.env.KEEL_GITHUB_TOKEN = savedToken
})

describe('parseIntervalMs', () => {
  it('省略 → 缺省 60000', () => {
    const r = parseIntervalMs(undefined)
    expect(r.ok && r.value).toBe(DEFAULT_INTERVAL_MS)
  })

  it('正整数原样返回', () => {
    for (const ms of [1, 5_000, 60_000]) {
      const r = parseIntervalMs(ms)
      expect(r.ok && r.value).toBe(ms)
    }
  })

  it('0 / 负数 / 小数 / 非数字 / 只写标志 → 拒绝，不静默回退', () => {
    for (const raw of [0, -1, 1.5, 'abc', true] as const) {
      const r = parseIntervalMs(raw)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
    }
  })
})

describe('pollerMain · 参数与凭据前置', () => {
  it('非法 --interval → 退出码 1，不起任何依赖', async () => {
    const listRepos = vi.fn()
    await pollerMain(['--interval', '0'], { listRepos })
    expect(process.exitCode).toBe(1)
    expect(listRepos).not.toHaveBeenCalled()
  })

  it('缺 GitHub 凭据 → 进入循环前失败，不空转', async () => {
    delete process.env.KEEL_GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    const listRepos = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await pollerMain([], { listRepos })

    expect(process.exitCode).toBe(1)
    expect(listRepos).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/KEEL_GITHUB_TOKEN/)
  })

  it('非法 --ci / --harness / --wall-clock → 拒绝', async () => {
    process.env.KEEL_GITHUB_TOKEN = 't'
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await pollerMain(['--ci', 'rael'])
    expect(process.exitCode).toBe(1)

    // 只写 --ci 不静默回退缺省 real（那会悄悄打真实 GitHub）
    process.exitCode = undefined
    await pollerMain(['--ci'])
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    await pollerMain(['--harness', 'codex'])
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    await pollerMain(['--wall-clock', '0'])
    expect(process.exitCode).toBe(1)

    expect(errSpy).toHaveBeenCalled()
  })

  it('--label 被拒绝而不是静默忽略 —— 否则用户会以为只扫这个 label', async () => {
    process.env.KEEL_GITHUB_TOKEN = 't'
    const listRepos = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await pollerMain(['--label', 'triage'], { listRepos })

    expect(process.exitCode).toBe(1)
    expect(listRepos).not.toHaveBeenCalled()
    const text = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('--label')
    expect(text).toContain('repo.issue_label')
  })

  it('空白 token 视为缺凭据（否则常驻进程每轮撞 401）', async () => {
    process.env.KEEL_GITHUB_TOKEN = '   '
    const listRepos = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await pollerMain([], { listRepos })

    expect(process.exitCode).toBe(1)
    expect(listRepos).not.toHaveBeenCalled()
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/KEEL_GITHUB_TOKEN/)
  })

  it('--help 不要求凭据', async () => {
    delete process.env.KEEL_GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await pollerMain(['--help'])

    expect(process.exitCode).toBeUndefined()
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('keel poller')
  })
})

describe('pollerMain · 依赖接线', () => {
  it('把 repo 自己的 label 与规范化 Issue URL 传给 runIssue，并输出聚合日志', async () => {
    process.env.KEEL_GITHUB_TOKEN = 'ghp_test_token'
    const signals = fakeSignals()
    const logs: Record<string, unknown>[] = []
    const runCalls: unknown[] = []

    await pollerMain(['--interval', '1'], {
      listRepos: async () => [REPO],
      listIssues: async (repo) => {
        expect(repo.issue_label).toBe('triage')
        return ok<IssueList>({
          issues: [{ number: 7, title: 't', state: 'open', isPullRequest: false, labels: [] }],
          truncated: false,
        })
      },
      taskStatus: async () => undefined,
      runIssue: async (input) => {
        runCalls.push(input)
        return ok<PollIssueOutcome>({ created: true })
      },
      log: (line) => logs.push(line),
      now: () => '2026-11-04T00:00:00.000Z',
      signals: signals.source,
      // 第一轮结束后触发 SIGTERM，避免测试进入常驻
      sleep: async () => {
        signals.fire('SIGTERM')
      },
    })

    expect(process.exitCode).toBeUndefined()
    expect(runCalls).toEqual([
      { issueUrl: 'https://github.com/acme/alpha/issues/7', repoId: 'repo-a', label: 'triage' },
    ])
    expect(logs.find((l) => l.event === 'repo')).toMatchObject({
      repo: 'acme/alpha',
      label: 'triage',
      scanned: 1,
    })
    expect(logs.find((l) => l.event === 'poll')).toMatchObject({
      repos: 1,
      scanned: 1,
      ingested: 1,
      driven: 1,
      skipped: 0,
      errors: 0,
      truncated: false,
    })
    expect(logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  })

  it('停止后关闭连接池 —— 否则 pg 的 idle client 让进程挂着不退出', async () => {
    process.env.KEEL_GITHUB_TOKEN = 'ghp_test_token'
    const signals = fakeSignals()
    const logs: Record<string, unknown>[] = []
    const closeDb = vi.fn(async () => undefined)

    await pollerMain(['--interval', '1'], {
      listRepos: async () => [],
      listIssues: async () => ok<IssueList>({ issues: [], truncated: false }),
      taskStatus: async () => undefined,
      runIssue: async () => ok<PollIssueOutcome>({ created: false }),
      log: (line) => logs.push(line),
      now: () => '2026-11-04T00:00:00.000Z',
      signals: signals.source,
      sleep: async () => {
        signals.fire('SIGTERM')
      },
      closeDb,
    })

    expect(logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
    expect(closeDb).toHaveBeenCalledTimes(1)
  })

  it('循环异常退出时也关闭连接池（不是只在优雅路径收尾）', async () => {
    process.env.KEEL_GITHUB_TOKEN = 'ghp_test_token'
    const closeDb = vi.fn(async () => undefined)

    await expect(
      pollerMain([], {
        listRepos: async () => {
          throw new Error('数据库挂了')
        },
        closeDb,
      }),
    ).rejects.toThrow('数据库挂了')

    expect(closeDb).toHaveBeenCalledTimes(1)
  })
})
