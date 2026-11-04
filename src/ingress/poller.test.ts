/**
 * 轮询核心单测 —— 全部注入依赖，不碰数据库、不碰真实 GitHub。
 *
 * 覆盖 PRD 的行为面：仓库级 label、新 / 终态 / 非终态、失败隔离、
 * 结构化日志脱敏、SIGTERM 后不再认领。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { IssueList, ListedIssue } from '../fact/github-provider.js'
import {
  createStopToken,
  interruptibleSleep,
  type PollerDeps,
  type PollerSignalSource,
  type PollIssueInput,
  type PollIssueOutcome,
  pollOnce,
  type RepoRow,
  runPollerForever,
} from './poller.js'

const REPO_A: RepoRow = {
  id: 'repo-a',
  remote_url: 'https://github.com/acme/alpha.git',
  default_branch: 'main',
  issue_label: 'keel',
}

const REPO_B: RepoRow = {
  id: 'repo-b',
  remote_url: 'git@github.com:acme/beta.git',
  default_branch: 'main',
  issue_label: 'triage',
}

function listed(number: number): ListedIssue {
  return { number, title: `issue ${number}`, state: 'open', isPullRequest: false, labels: [] }
}

function issueList(issues: readonly ListedIssue[], truncated = false): Result<IssueList> {
  return ok({ issues, truncated })
}

interface Harness {
  readonly deps: PollerDeps
  readonly logs: Record<string, unknown>[]
  readonly runCalls: PollIssueInput[]
}

function harness(overrides: Partial<PollerDeps> = {}): Harness {
  const logs: Record<string, unknown>[] = []
  const runCalls: PollIssueInput[] = []
  const deps: PollerDeps = {
    listRepos: async () => [REPO_A, REPO_B],
    listIssues: async () => issueList([]),
    taskStatus: async () => undefined,
    runIssue: async (input) => {
      runCalls.push(input)
      return ok<PollIssueOutcome>({ created: true })
    },
    now: () => '2026-11-04T00:00:00.000Z',
    log: (line) => logs.push(line),
    ...overrides,
  }
  return { deps, logs, runCalls }
}

function logText(logs: readonly Record<string, unknown>[]): string {
  return logs.map((line) => JSON.stringify(line)).join('\n')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pollOnce · 仓库级 label 与驱动判定', () => {
  it('每个仓库用自己的 issue_label 扫描，runIssue 带上同一个 label', async () => {
    const seen: { repo: string; label: string }[] = []
    const h = harness({
      listIssues: async (repo) => {
        seen.push({ repo: repo.id, label: repo.issue_label })
        return issueList([listed(1)])
      },
    })

    await pollOnce(h.deps)

    expect(seen).toEqual([
      { repo: 'repo-a', label: 'keel' },
      { repo: 'repo-b', label: 'triage' },
    ])
    expect(h.runCalls).toEqual([
      { issueUrl: 'https://github.com/acme/alpha/issues/1', repoId: 'repo-a', label: 'keel' },
      { issueUrl: 'https://github.com/acme/beta/issues/1', repoId: 'repo-b', label: 'triage' },
    ])
  })

  it('新 issue → 调 runIssue；终态 task 跳过；非终态继续驱动', async () => {
    const statuses: Record<string, 'S-DONE' | 'S-QA' | undefined> = {
      'acme/alpha#1': 'S-DONE',
      'acme/alpha#2': 'S-QA',
      // #3 没有 task
    }
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1), listed(2), listed(3)]),
      taskStatus: async (ref) => statuses[ref],
    })

    const round = await pollOnce(h.deps)

    expect(h.runCalls.map((c) => c.issueUrl)).toEqual([
      'https://github.com/acme/alpha/issues/2',
      'https://github.com/acme/alpha/issues/3',
    ])
    expect(round.stats.skipped).toBe(1)
    expect(round.stats.driven).toBe(2)
  })

  it('重复 tick 不双跑已终态 task —— 第二次 round 全部 skipped', async () => {
    let driven = false
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1)]),
      // 模拟第一轮创建 task 并走到终态
      taskStatus: async () => (driven ? 'S-DONE' : undefined),
      runIssue: async (input) => {
        h.runCalls.push(input)
        driven = true
        return ok<PollIssueOutcome>({ created: true })
      },
    })

    const first = await pollOnce(h.deps)
    const second = await pollOnce(h.deps)

    expect(first.stats.driven).toBe(1)
    expect(second.stats.driven).toBe(0)
    expect(second.stats.skipped).toBe(1)
    expect(h.runCalls).toHaveLength(1)
  })

  it('单个 issue 失败不终止整轮，后续继续驱动', async () => {
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1), listed(2)]),
      runIssue: async (input) => {
        h.runCalls.push(input)
        if (input.issueUrl.endsWith('/1')) {
          return err(makeError('WORKSPACE_ERROR', 'clone 失败'))
        }
        return ok<PollIssueOutcome>({ created: false })
      },
    })

    const round = await pollOnce(h.deps)

    expect(round.stats.errors).toBe(1)
    expect(round.stats.driven).toBe(1)
    expect(h.runCalls).toHaveLength(2)
    expect(h.logs.some((l) => l.event === 'issue_error')).toBe(true)
  })

  it('单个仓库列出失败不影响其它仓库', async () => {
    const h = harness({
      listIssues: async (repo) =>
        repo.id === 'repo-a'
          ? err(makeError('HARNESS_UNAVAILABLE', 'rate limited'))
          : issueList([listed(1)]),
    })

    const round = await pollOnce(h.deps)

    expect(round.stats.repos).toBe(2)
    expect(round.stats.errors).toBe(1)
    expect(round.stats.driven).toBe(1)
    expect(h.logs.filter((l) => l.event === 'repo_error')).toHaveLength(1)
  })

  it('日志含聚合字段；任一仓库 truncated 时聚合为 true', async () => {
    const h = harness({
      listIssues: async (repo) =>
        repo.id === 'repo-a' ? issueList([listed(1)], true) : issueList([listed(2)]),
    })

    const round = await pollOnce(h.deps)
    const aggregate = h.logs.find((l) => l.event === 'poll')

    expect(round.stats.truncated).toBe(true)
    expect(aggregate).toMatchObject({
      event: 'poll',
      repos: 2,
      scanned: 2,
      ingested: 2,
      driven: 2,
      skipped: 0,
      errors: 0,
      truncated: true,
      stopped: false,
    })
  })

  it('error detail 经 redactSecrets 脱敏，日志不含 token', async () => {
    const saved = process.env.KEEL_GITHUB_TOKEN
    process.env.KEEL_GITHUB_TOKEN = 'ghp_super_secret'
    try {
      const h = harness({
        listIssues: async () => issueList([listed(1)]),
        runIssue: async (input) => {
          h.runCalls.push(input)
          return err(makeError('AUTH_FAILED', '认证失败: Bearer ghp_super_secret 被拒绝'))
        },
      })

      await pollOnce(h.deps)

      const text = logText(h.logs)
      expect(text).not.toContain('ghp_super_secret')
      expect(text).toContain('***')
      // issue body 不是扫描层的数据，日志里也不该出现
      expect(text).not.toContain('"body"')
    } finally {
      if (saved === undefined) delete process.env.KEEL_GITHUB_TOKEN
      else process.env.KEEL_GITHUB_TOKEN = saved
    }
  })

  it('停止信号在 issue 之间生效：不再认领下一个 issue', async () => {
    let stop = false
    const h = harness({
      listIssues: async () => issueList([listed(1), listed(2)]),
      runIssue: async (input) => {
        h.runCalls.push(input)
        stop = true
        return ok<PollIssueOutcome>({ created: true })
      },
    })

    const round = await pollOnce(h.deps, { shouldStop: () => stop })

    expect(h.runCalls).toHaveLength(1)
    expect(round.stopped).toBe(true)
    expect(round.stats.scanned).toBe(2)
  })

  it('同一轮内同一 issue 只认领一次（重复 repo 行指向同一 remote）', async () => {
    const h = harness({
      // remote_url 没有唯一索引，两条 repo 行可能指向同一个仓库
      listRepos: async () => [REPO_A, { ...REPO_A, id: 'repo-a-duplicate' }],
      listIssues: async () => issueList([listed(7)]),
    })

    const round = await pollOnce(h.deps)

    expect(h.runCalls).toHaveLength(1)
    expect(round.stats.scanned).toBe(2)
    expect(round.stats.driven).toBe(1)
  })

  it('repo_error 的 repo 字段剥掉 userinfo，不把内嵌凭据写进日志', async () => {
    const h = harness({
      listRepos: async () => [
        { ...REPO_A, remote_url: 'https://user:ghp_in_remote@gitlab.com/acme/alpha.git' },
      ],
    })

    await pollOnce(h.deps)

    const text = logText(h.logs)
    expect(h.logs.some((l) => l.event === 'repo_error')).toBe(true)
    expect(text).not.toContain('ghp_in_remote')
    expect(text).toContain('***@gitlab.com')
  })
})

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

describe('runPollerForever · 信号与生命周期', () => {
  it('SIGTERM 后不再开始新轮，打 stopped 行并退出', async () => {
    const signals = fakeSignals()
    let rounds = 0
    const h = harness({
      listRepos: async () => {
        rounds += 1
        return [REPO_A]
      },
      listIssues: async () => issueList([listed(1)]),
      runIssue: async () => {
        signals.fire('SIGTERM')
        return ok<PollIssueOutcome>({ created: true })
      },
    })

    await runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        throw new Error('收到信号后不应再进入 sleep')
      },
    })

    expect(rounds).toBe(1)
    expect(h.logs.find((l) => l.event === 'poll')).toBeDefined()
    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  })

  it('正常轮次之间继续扫描，信号后退出', async () => {
    const signals = fakeSignals()
    let rounds = 0
    let sleeps = 0
    const h = harness({
      listRepos: async () => {
        rounds += 1
        return [REPO_A]
      },
      listIssues: async () => issueList([]),
    })

    await runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        sleeps += 1
        // 第二轮之后停止
        if (sleeps === 2) signals.fire('SIGINT')
      },
    })

    expect(rounds).toBe(2)
    expect(sleeps).toBe(2)
    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  })

  it('缺省 sleep 可被信号打断 —— 不必等满 interval', async () => {
    const signals = fakeSignals()
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([]),
    })

    const running = runPollerForever(h.deps, { intervalMs: 60_000, signals: signals.source })
    // 第一轮结束后进入 60s 的 sleep，10ms 后打断它
    const timer = setTimeout(() => signals.fire('SIGTERM'), 10)
    // 若 interruptibleSleep 没清理 timer，这里会挂满 60s
    await running
    clearTimeout(timer)

    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  }, 2_000)
})

/**
 * 常驻进程的资源行为。
 *
 * 旧实现每轮往**同一个永不 resolve 的 promise** 上挂 `.then`，reaction 只在
 * 该 promise settle 时才被丢弃 —— 7×24 常驻下每天泄漏 1440 个闭包。
 * `listenerCount` 是这个问题的可观测口径：它必须回到 0，不能随轮次增长。
 */
describe('interruptibleSleep · 订阅不随轮次累积', () => {
  it('N 轮之后未结算订阅数回到 0', async () => {
    const stop = createStopToken()
    const counts: number[] = []
    for (let i = 0; i < 50; i += 1) {
      await interruptibleSleep(1, stop)
      counts.push(stop.listenerCount)
    }

    expect(Math.max(...counts)).toBe(0)
    expect(stop.listenerCount).toBe(0)
  })

  it('信号叫醒等待者并清空订阅，不等满 interval', async () => {
    const stop = createStopToken()
    const sleeping = interruptibleSleep(60_000, stop)
    expect(stop.listenerCount).toBe(1)

    stop.request()
    // 没被叫醒的话这里会挂满 60s
    await sleeping

    expect(stop.listenerCount).toBe(0)
    expect(stop.requested).toBe(true)
  }, 2_000)

  it('已停止的 token 上 sleep 立即返回，不注册订阅', async () => {
    const stop = createStopToken()
    stop.request()
    await interruptibleSleep(60_000, stop)
    expect(stop.listenerCount).toBe(0)
  }, 2_000)

  it('runPollerForever 多轮之后订阅数不随轮次增长', async () => {
    const signals = fakeSignals()
    const stop = createStopToken()
    let rounds = 0
    const h = harness({
      listRepos: async () => {
        rounds += 1
        return [REPO_A]
      },
      listIssues: async () => issueList([]),
    })

    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      stopToken: stop,
    })
    // 常驻期间任何时刻最多一个等待者（当前轮的 sleep）
    await vi.waitFor(() => {
      expect(rounds).toBeGreaterThan(5)
      expect(stop.listenerCount).toBeLessThanOrEqual(1)
    })
    signals.fire('SIGTERM')
    await running

    expect(stop.listenerCount).toBe(0)
    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  }, 5_000)
})
