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
  createDriveScheduler,
  createStopToken,
  DEFAULT_DRIVE_CONCURRENCY,
  type DriveRequest,
  interruptibleSleep,
  type PollerDeps,
  type PollerSignalSource,
  type PollIssueInput,
  type PollIssueOutcome,
  pollOnce,
  type RepoRow,
  runPollerForever,
  scanOnce,
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

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 调度器的输入形状；ref 与 issue URL 保持真实格式，便于断言日志 */
function drive(number: number): DriveRequest {
  return {
    externalRef: `acme/alpha#${number}`,
    input: {
      issueUrl: `https://github.com/acme/alpha/issues/${number}`,
      repoId: 'repo-a',
      label: 'keel',
    },
  }
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
      // 扫描先于驱动完成（scanOnce + 顺序驱动），所以这里只放一个仓库，
      // 让 scanned 断言仍只反映「本轮看到几个 issue」。
      listRepos: async () => [REPO_A],
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

describe('scanOnce · 只扫描不驱动', () => {
  it('返回待驱动请求，但不调用 runIssue', async () => {
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1), listed(2)]),
    })

    const scan = await scanOnce(h.deps)

    expect(scan.drives.map((d) => d.externalRef)).toEqual(['acme/alpha#1', 'acme/alpha#2'])
    expect(h.runCalls).toHaveLength(0)
    expect(scan.stopped).toBe(false)
  })

  it('停止信号在扫描中生效：不收集后续 issue，也不再扫后面的仓库', async () => {
    let stop = false
    const h = harness({
      listRepos: async () => [REPO_A, REPO_B],
      listIssues: async () => issueList([listed(1), listed(2)]),
      taskStatus: async (ref) => {
        if (ref === 'acme/alpha#1') stop = true
        return undefined
      },
    })

    const scan = await scanOnce(h.deps, { shouldStop: () => stop })

    expect(scan.stopped).toBe(true)
    // 停止前已收集的那一个保留；同仓库的下一个 issue 与下一个仓库都不再收集
    expect(scan.drives.map((d) => d.externalRef)).toEqual(['acme/alpha#1'])
    expect(h.runCalls).toHaveLength(0)
  })
})

describe('createDriveScheduler · 有界并发与在途集合', () => {
  it('N+1 个可驱动 issue：最多 N 个同时启动，其余 at_capacity', async () => {
    const h = harness()
    const gates: Deferred<Result<PollIssueOutcome>>[] = []
    const scheduler = createDriveScheduler(
      {
        ...h.deps,
        runIssue: (input) => {
          h.runCalls.push(input)
          const gate = deferred<Result<PollIssueOutcome>>()
          gates.push(gate)
          return gate.promise
        },
      },
      { concurrency: 2 },
    )

    expect(scheduler.schedule(drive(1))).toBe('scheduled')
    expect(scheduler.schedule(drive(2))).toBe('scheduled')
    expect(scheduler.schedule(drive(3))).toBe('at_capacity')

    expect(scheduler.inFlight).toBe(2)
    expect(h.runCalls).toHaveLength(2)

    for (const gate of gates) gate.resolve(ok<PollIssueOutcome>({ created: false }))
    await scheduler.drain()

    expect(scheduler.inFlight).toBe(0)
    expect(h.logs.filter((l) => l.event === 'issue_driven')).toHaveLength(2)
  })

  it('同一 externalRef 在驱动未结束时再次调度 → in_flight，不双跑', async () => {
    const h = harness()
    const gates: Deferred<Result<PollIssueOutcome>>[] = []
    const scheduler = createDriveScheduler(
      {
        ...h.deps,
        runIssue: (input) => {
          h.runCalls.push(input)
          const gate = deferred<Result<PollIssueOutcome>>()
          gates.push(gate)
          return gate.promise
        },
      },
      { concurrency: 3 },
    )

    expect(scheduler.schedule(drive(1))).toBe('scheduled')
    expect(scheduler.schedule(drive(1))).toBe('in_flight')
    expect(h.runCalls).toHaveLength(1)

    gates[0]?.resolve(ok<PollIssueOutcome>({ created: false }))
    await scheduler.drain()

    // 驱动结束后同一个 ref 可以再次被调度（幂等由 runIssue / feedback 唯一键保证）
    expect(scheduler.schedule(drive(1))).toBe('scheduled')
    expect(h.runCalls).toHaveLength(2)
    gates[1]?.resolve(ok<PollIssueOutcome>({ created: false }))
    await scheduler.drain()
  })

  it('drain 等在途驱动收尾；集合为空时立即 resolve', async () => {
    const h = harness()
    const gate = deferred<Result<PollIssueOutcome>>()
    const scheduler = createDriveScheduler(
      { ...h.deps, runIssue: () => gate.promise },
      {
        concurrency: 1,
      },
    )

    expect(scheduler.schedule(drive(1))).toBe('scheduled')

    let drained = false
    const draining = scheduler.drain().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(drained).toBe(false)

    gate.resolve(ok<PollIssueOutcome>({ created: false }))
    await draining
    expect(drained).toBe(true)
    expect(scheduler.inFlight).toBe(0)

    // 空集合：立即完成
    await scheduler.drain()
  })

  it('停止后 schedule 返回 stopped，不再启动新驱动', () => {
    const h = harness()
    let stopped = false
    const scheduler = createDriveScheduler(h.deps, {
      concurrency: 2,
      shouldStop: () => stopped,
    })

    stopped = true
    expect(scheduler.schedule(drive(1))).toBe('stopped')
    expect(h.runCalls).toHaveLength(0)
  })

  it('驱动返回 err → issue_error（detail 脱敏），其它驱动照常成功', async () => {
    const saved = process.env.KEEL_GITHUB_TOKEN
    process.env.KEEL_GITHUB_TOKEN = 'ghp_super_secret'
    try {
      const h = harness({
        runIssue: async (input) => {
          h.runCalls.push(input)
          if (input.issueUrl.endsWith('/1')) {
            return err(makeError('AUTH_FAILED', '认证失败: Bearer ghp_super_secret 被拒绝'))
          }
          return ok<PollIssueOutcome>({ created: false })
        },
      })
      const scheduler = createDriveScheduler(h.deps, { concurrency: 2 })

      expect(scheduler.schedule(drive(1))).toBe('scheduled')
      expect(scheduler.schedule(drive(2))).toBe('scheduled')
      await scheduler.drain()

      expect(h.logs.filter((l) => l.event === 'issue_error')).toHaveLength(1)
      expect(h.logs.filter((l) => l.event === 'issue_driven')).toHaveLength(1)
      const text = logText(h.logs)
      expect(text).not.toContain('ghp_super_secret')
      expect(text).toContain('***')
    } finally {
      if (saved === undefined) delete process.env.KEEL_GITHUB_TOKEN
      else process.env.KEEL_GITHUB_TOKEN = saved
    }
  })

  it('驱动抛异常 → 只记首个 fatal、onFatal 请求停止，drain 仍能收尾', async () => {
    const h = harness()
    const boom = new Error('数据库连接断了')
    const gates: Deferred<Result<PollIssueOutcome>>[] = []
    let stopped = false
    const onFatal = vi.fn(() => {
      stopped = true
    })
    const scheduler = createDriveScheduler(
      {
        ...h.deps,
        runIssue: (input) => {
          h.runCalls.push(input)
          const gate = deferred<Result<PollIssueOutcome>>()
          gates.push(gate)
          return gate.promise
        },
      },
      { concurrency: 2, shouldStop: () => stopped, onFatal },
    )

    expect(scheduler.schedule(drive(1))).toBe('scheduled')
    expect(scheduler.schedule(drive(2))).toBe('scheduled')

    gates[0]?.reject(boom)
    gates[1]?.reject(new Error('第二个异常不作为 fatal'))
    await scheduler.drain()

    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(scheduler.takeFatal()).toEqual({ value: boom })
    expect(scheduler.takeFatal()).toBeUndefined()

    // fatal 已请求停止：后续 schedule 不再启动
    expect(scheduler.schedule(drive(3))).toBe('stopped')
    expect(h.runCalls).toHaveLength(2)
    // 抛异常不冒充可预期的 issue_error
    expect(h.logs.some((l) => l.event === 'issue_error')).toBe(false)
  })
})

describe('runPollerForever · 扫描与驱动解耦', () => {
  it('一个永不返回的驱动不阻塞后续轮扫描，同一 ref 跨轮不双跑', async () => {
    const signals = fakeSignals()
    const slow = deferred<Result<PollIssueOutcome>>()
    let rounds = 0
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => {
        rounds += 1
        return issueList(rounds === 1 ? [listed(1)] : [listed(1), listed(2)])
      },
      runIssue: (input) => {
        h.runCalls.push(input)
        if (input.issueUrl.endsWith('/1')) return slow.promise
        return Promise.resolve(ok<PollIssueOutcome>({ created: false }))
      },
    })

    let sleeps = 0
    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        sleeps += 1
        if (sleeps === 2) signals.fire('SIGTERM')
        await Promise.resolve()
      },
    })

    await vi.waitFor(() => {
      expect(h.logs.some((l) => l.event === 'issue_driven' && l.ref === 'acme/alpha#2')).toBe(true)
    })

    expect(rounds).toBeGreaterThanOrEqual(2)
    // 第二轮看到 #1，但它在途 → 只记 skipped，不重复驱动
    const polls = h.logs.filter((l) => l.event === 'poll')
    expect(polls[1]).toMatchObject({ scheduled: 1, deferred: 0, inFlight: 2, skipped: 1 })
    expect(h.runCalls.filter((c) => c.issueUrl.endsWith('/1'))).toHaveLength(1)
    // 慢驱动仍在途：进程还没退出
    expect(h.logs.some((l) => l.event === 'poller')).toBe(false)

    slow.resolve(ok<PollIssueOutcome>({ created: true }))
    await running

    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  })

  it('SIGTERM 后不再调度新 issue，等在途驱动结束后才退出', async () => {
    const signals = fakeSignals()
    const slow = deferred<Result<PollIssueOutcome>>()
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1), listed(2)]),
      runIssue: (input) => {
        h.runCalls.push(input)
        // 第一条驱动开始的瞬间收到信号：第二个 issue 不得再被调度
        signals.fire('SIGTERM')
        return slow.promise
      },
    })

    let finished = false
    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        throw new Error('SIGTERM 后不应再进入 sleep')
      },
    }).then(() => {
      finished = true
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.runCalls).toHaveLength(1)
    expect(finished).toBe(false)

    slow.resolve(ok<PollIssueOutcome>({ created: false }))
    await running

    expect(finished).toBe(true)
    expect(h.logs.at(-1)).toMatchObject({ event: 'poller', state: 'stopped' })
  })

  it('并发上限生效：排不下的 issue 记为 deferred 且不启动', async () => {
    const signals = fakeSignals()
    const slow = deferred<Result<PollIssueOutcome>>()
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1), listed(2)]),
      runIssue: (input) => {
        h.runCalls.push(input)
        return slow.promise
      },
    })

    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      concurrency: 1,
      sleep: async () => {
        signals.fire('SIGTERM')
      },
    })

    await vi.waitFor(() => expect(h.logs.some((l) => l.event === 'poll')).toBe(true))
    expect(h.logs.find((l) => l.event === 'poll')).toMatchObject({
      scheduled: 1,
      deferred: 1,
      inFlight: 1,
    })
    expect(h.runCalls).toHaveLength(1)

    slow.resolve(ok<PollIssueOutcome>({ created: false }))
    await running
  })

  it('驱动抛异常 → 等在途收尾后照常抛出，不打 stopped 行', async () => {
    const signals = fakeSignals()
    const boom = new Error('数据库挂了')
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1)]),
      runIssue: () => Promise.reject(boom),
    })

    await expect(
      runPollerForever(h.deps, {
        intervalMs: 1,
        signals: signals.source,
        // fatal 会通过 onFatal 请求停止；给微任务一个窗口让循环看到停止位
        sleep: async () => {
          await Promise.resolve()
        },
      }),
    ).rejects.toBe(boom)

    expect(h.logs.some((l) => l.event === 'poller')).toBe(false)
    expect(h.logs.some((l) => l.event === 'issue_error')).toBe(false)
  })

  it('驱动抛 undefined 也不被吞：仍以抛出结束，不打 stopped 行', async () => {
    const signals = fakeSignals()
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList([listed(1)]),
      // `Promise.reject()` 不带值也是合法的抛出值；不能被当成「没有 fatal」
      runIssue: () => Promise.reject(),
    })

    await expect(
      runPollerForever(h.deps, {
        intervalMs: 1,
        signals: signals.source,
        sleep: async () => {
          await Promise.resolve()
        },
      }),
    ).rejects.toBeUndefined()

    expect(h.logs.some((l) => l.event === 'poller')).toBe(false)
  })

  it('扫描抛错：在途驱动仍收尾后才抛出（drain 在 finally）', async () => {
    const signals = fakeSignals()
    const slow = deferred<Result<PollIssueOutcome>>()
    const boom = new Error('repo 表不可读')
    let rounds = 0
    const h = harness({
      listRepos: async () => {
        rounds += 1
        if (rounds === 2) throw boom
        return [REPO_A]
      },
      listIssues: async () => issueList([listed(1)]),
      runIssue: (input) => {
        h.runCalls.push(input)
        return slow.promise
      },
    })

    let settled = false
    let caught: unknown
    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        await Promise.resolve()
      },
    }).catch((e: unknown) => {
      settled = true
      caught = e
    })

    await vi.waitFor(() => expect(rounds).toBe(2))
    // 第二轮扫描已抛错，但第一轮的在途驱动还没结束：finally 里的 drain 必须等它
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    slow.resolve(ok<PollIssueOutcome>({ created: false }))
    await running

    expect(settled).toBe(true)
    expect(caught).toBe(boom)
    // 抛错退出不打正常停止行
    expect(h.logs.some((l) => l.event === 'poller')).toBe(false)
  })

  it('缺省并发与 DEFAULT_DRIVE_CONCURRENCY 一致（N+1 时只启动 N 个）', async () => {
    const signals = fakeSignals()
    const slow = deferred<Result<PollIssueOutcome>>()
    const issues = Array.from({ length: DEFAULT_DRIVE_CONCURRENCY + 1 }, (_, i) => listed(i + 1))
    const h = harness({
      listRepos: async () => [REPO_A],
      listIssues: async () => issueList(issues),
      runIssue: (input) => {
        h.runCalls.push(input)
        return slow.promise
      },
    })

    const running = runPollerForever(h.deps, {
      intervalMs: 1,
      signals: signals.source,
      sleep: async () => {
        signals.fire('SIGTERM')
      },
    })

    await vi.waitFor(() => expect(h.logs.some((l) => l.event === 'poll')).toBe(true))
    expect(h.logs.find((l) => l.event === 'poll')).toMatchObject({
      scheduled: DEFAULT_DRIVE_CONCURRENCY,
      deferred: 1,
      inFlight: DEFAULT_DRIVE_CONCURRENCY,
    })
    expect(h.runCalls).toHaveLength(DEFAULT_DRIVE_CONCURRENCY)

    slow.resolve(ok<PollIssueOutcome>({ created: false }))
    await running
  })
})
