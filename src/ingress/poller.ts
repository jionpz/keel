/**
 * 常驻 poller 的轮询核心（任务 08-29-ingress-poller，issue #70 §2；
 * 扫描 / 驱动解耦见任务 11-06-poller-nonblocking）。
 *
 * 边界：本模块只做「扫描 + 调度」，是接入层，不参与状态机决策。
 *   - ingest / 驱动全部走注入的 `runIssue`（它内部完成 ingest + runTask），
 *     这里不复制任何一段；
 *   - 不引入队列 / 并发框架：排不下的 issue 记为 `deferred`，下一轮重新扫描时再试 ——
 *     幂等来源始终是「每轮重扫 + feedback 唯一键」，内存队列会变成第二份待办状态；
 *   - 并发只做进程内节流；真正的并发事实仍由 claim 的 N3/N4 数据库守卫保证；
 *   - 不处理 wall-clock timer —— 那是 timer-worker 的职责（PRD R10）。
 *
 * 全部依赖可注入，所以轮询逻辑可以脱离数据库与 GitHub 单测。
 */

import type { Result } from '../contracts/errors.js'
import { gitAuthSecrets, readTokenFromEnv, redactSecrets } from '../fact/github-auth.js'
import { type IssueList, issueUrlFor, parseRemoteUrl } from '../fact/github-provider.js'
import { isTerminal, type TaskStatus } from '../shared/ids.js'

export const DEFAULT_INTERVAL_MS = 60_000

/**
 * 常驻驱动的并发上限缺省值 —— 与 N4 的全局 RUNNING 上限一致
 * （`src/control/concurrency/limits.ts` 的 `DEFAULT_MAX_RUNNING_RUNS`）。
 * 接入层不 import control 平面，所以这里是同一个数值的第二处声明；
 * CLI 接线时必须用全局常量校验 `--concurrency`，两处不得漂移
 * （`src/cli/poller.test.ts` 有一条数值相等的防漂移断言）。
 */
export const DEFAULT_DRIVE_CONCURRENCY = 3

/** 扫描所需的仓库元数据；`issue_label` 是每仓库自己的 label，不是全局配置 */
export interface RepoRow {
  readonly id: string
  readonly remote_url: string
  readonly default_branch: string
  readonly issue_label: string
}

export interface PollIssueInput {
  readonly issueUrl: string
  readonly repoId: string
  /** 该仓库自己的 label —— 必须透传，ingest 的 label 闸门用它 */
  readonly label: string
}

export interface PollIssueOutcome {
  /** runIssue 是否新建了 task（false = 复用了已有 task） */
  readonly created: boolean
}

export interface PollerDeps {
  readonly listRepos: () => Promise<readonly RepoRow[]>
  readonly listIssues: (repo: RepoRow) => Promise<Result<IssueList>>
  /**
   * 按 external_ref（`owner/repo#n`）查 task 状态。
   * 返回 undefined = 还没有 task；终态判定由扫描用 TERMINAL_STATUSES 做。
   */
  readonly taskStatus: (externalRef: string) => Promise<TaskStatus | undefined>
  readonly runIssue: (input: PollIssueInput) => Promise<Result<PollIssueOutcome>>
  readonly now: () => string
  /** 单行结构化日志出口；实现方负责 JSON.stringify */
  readonly log: (line: Record<string, unknown>) => void
}

export interface ScanStats {
  /** 本轮查询的 repo 数 */
  readonly repos: number
  /** 本轮看到的 open issue 数（已排除 PR） */
  readonly scanned: number
  /** 已终态、直接跳过的数 */
  readonly skipped: number
  /** repo 级可预期失败数 */
  readonly errors: number
  /** 任一仓库触到分页上限 */
  readonly truncated: boolean
}

export interface PollStats extends ScanStats {
  /** 新建 task 数 */
  readonly ingested: number
  /** 驱动成功数（含新建 —— 新 issue 也会被驱动到当前可停处） */
  readonly driven: number
}

export interface PollRoundResult {
  readonly stats: PollStats
  /** 收到停止信号，本轮没有走完 */
  readonly stopped: boolean
}

/** 一次待驱动：`externalRef` 是调度器的去重键 */
export interface DriveRequest {
  readonly externalRef: string
  readonly input: PollIssueInput
}

export interface ScanRoundResult {
  readonly stats: ScanStats
  readonly drives: readonly DriveRequest[]
  /** 收到停止信号，扫描没有走完 */
  readonly stopped: boolean
}

export interface PollOnceOptions {
  /** SIGTERM/SIGINT 后返回 true：不再收集 / 启动新 issue；已开始的驱动自然收尾 */
  readonly shouldStop?: () => boolean
}

/**
 * 扫描一轮：逐仓库列出 open issue，筛掉终态与轮内重复，**不驱动**。
 *
 * 单个 repo 的可预期失败只记 errors 并继续（PRD R11）；
 * 不可预期异常（编程错误 / 基础设施故障）照常抛出，不在这里吞掉。
 */
export async function scanOnce(
  deps: PollerDeps,
  opts: PollOnceOptions = {},
): Promise<ScanRoundResult> {
  const shouldStop = opts.shouldStop ?? (() => false)
  const safeDetail = createSafeDetail()

  const stats = {
    repos: 0,
    scanned: 0,
    skipped: 0,
    errors: 0,
    truncated: false,
  }
  const drives: DriveRequest[] = []
  let stopped = false

  const repos = await deps.listRepos()
  stats.repos = repos.length

  /**
   * 同一轮内已认领过的 external_ref。
   *
   * 仓库注册表的 `remote_url` 没有唯一索引（见 database-guidelines.md 的已知限制），
   * 两条 repo 行指向同一个 remote 时，同一个 issue 会在一轮里被看到两次。
   * R6 要求「不双跑」，所以按 external_ref 在本轮内去重。
   */
  const claimed = new Set<string>()

  for (const repo of repos) {
    if (shouldStop()) {
      stopped = true
      break
    }

    // remote 解析失败算该仓库本轮失败，不影响其它仓库
    const parsed = parseRemoteUrl(repo.remote_url)
    if (!parsed.ok) {
      stats.errors += 1
      deps.log({
        ts: deps.now(),
        event: 'repo_error',
        repo: safeDetail(repo.remote_url),
        label: repo.issue_label,
        kind: parsed.error.kind,
        detail: safeDetail(parsed.error.detail),
      })
      continue
    }
    const slug = `${parsed.value.owner}/${parsed.value.repo}`

    const listed = await deps.listIssues(repo)
    if (!listed.ok) {
      stats.errors += 1
      deps.log({
        ts: deps.now(),
        event: 'repo_error',
        repo: slug,
        label: repo.issue_label,
        kind: listed.error.kind,
        detail: safeDetail(listed.error.detail),
      })
      continue
    }

    stats.scanned += listed.value.issues.length
    if (listed.value.truncated) stats.truncated = true
    deps.log({
      ts: deps.now(),
      event: 'repo',
      repo: slug,
      label: repo.issue_label,
      scanned: listed.value.issues.length,
      truncated: listed.value.truncated,
    })

    for (const issue of listed.value.issues) {
      if (shouldStop()) {
        stopped = true
        break
      }

      const externalRef = `${slug}#${issue.number}`

      // 本轮内重复出现（重复 repo 行 / 分页重叠）：只认领一次
      if (claimed.has(externalRef)) continue
      claimed.add(externalRef)

      // 终态 task 跳过；没有 task 或非终态都要驱动（PRD R5）。
      const status = await deps.taskStatus(externalRef)
      if (status !== undefined && isTerminal(status)) {
        stats.skipped += 1
        continue
      }

      drives.push({
        externalRef,
        input: {
          issueUrl: issueUrlFor(parsed.value, issue.number),
          repoId: repo.id,
          label: repo.issue_label,
        },
      })
    }

    if (stopped) break
  }

  return { stats, drives, stopped }
}

/**
 * 跑一轮：扫描后**顺序**驱动到各自可停处，返回聚合结果。
 *
 * 一次性语义保留给测试 / 脚本 / 诊断；常驻路径走 `scanOnce` + `createDriveScheduler`，
 * 不让最慢的 run 决定轮询节奏。
 */
export async function pollOnce(
  deps: PollerDeps,
  opts: PollOnceOptions = {},
): Promise<PollRoundResult> {
  const shouldStop = opts.shouldStop ?? (() => false)
  const safeDetail = createSafeDetail()

  const scan = await scanOnce(deps, opts)
  const stats = {
    ...scan.stats,
    ingested: 0,
    driven: 0,
  }
  let stopped = scan.stopped

  for (const req of scan.drives) {
    if (shouldStop()) {
      stopped = true
      break
    }

    const driven = await deps.runIssue(req.input)
    if (!driven.ok) {
      stats.errors += 1
      deps.log({
        ts: deps.now(),
        event: 'issue_error',
        ref: req.externalRef,
        kind: driven.error.kind,
        detail: safeDetail(driven.error.detail),
      })
      continue
    }

    stats.driven += 1
    if (driven.value.created) stats.ingested += 1
  }

  deps.log({ ts: deps.now(), event: 'poll', ...stats, stopped })
  return { stats, stopped }
}

export type ScheduleOutcome = 'scheduled' | 'in_flight' | 'at_capacity' | 'stopped'

export interface DriveScheduler {
  /** 尝试启动一次驱动；不排队，排不下就告诉调用方 */
  schedule(req: DriveRequest): ScheduleOutcome
  /** 当前在途驱动数 */
  readonly inFlight: number
  /** 等在途驱动全部收尾；集合为空时立即 resolve */
  drain(): Promise<void>
  /**
   * 取出并清空首个不可预期异常（没有则 undefined）。
   *
   * 用包装对象而不是直接返回 `unknown`：`throw undefined` / `Promise.reject()`
   * 也是合法（虽然糟糕）的抛出值，直接返回会让「没有 fatal」与「fatal 是 undefined」
   * 无法区分，从而被静默吞掉 —— R6 要求不可预期异常不被吞。
   */
  takeFatal(): DriveFatal | undefined
}

export interface DriveFatal {
  readonly value: unknown
}

export interface DriveSchedulerOptions {
  readonly concurrency: number
  /** SIGTERM / fatal 后返回 true：不再启动新驱动 */
  readonly shouldStop?: () => boolean
  /** 记录到首个不可预期异常时回调一次 —— 常驻循环用它立刻唤醒 sleep */
  readonly onFatal?: () => void
}

/**
 * 有界并发调度器：只做**进程内**节流，不读数据库。
 *
 * 真正的并发事实仍是 claim 时的 N3 乐观锁 + N4 全局上限 + 唯一索引；
 * 这里的作用是别把超过 N4 的驱动同时推上去 —— 那些只会在 claim 阶段
 * 变成可重试 CONFLICT 噪音。
 *
 * 不排队：本轮排不下的请求由调用方记为 `deferred`，下一轮重新扫描时再试。
 */
export function createDriveScheduler(
  deps: PollerDeps,
  opts: DriveSchedulerOptions,
): DriveScheduler {
  const shouldStop = opts.shouldStop ?? (() => false)
  const safeDetail = createSafeDetail()

  const inFlightRefs = new Set<string>()
  const running = new Set<Promise<void>>()
  let fatal: unknown
  let hasFatal = false

  const start = (req: DriveRequest): void => {
    inFlightRefs.add(req.externalRef)
    const run = async (): Promise<void> => {
      try {
        const driven = await deps.runIssue(req.input)
        if (!driven.ok) {
          // 可预期失败：只影响这一个 issue，不停止调度
          deps.log({
            ts: deps.now(),
            event: 'issue_error',
            ref: req.externalRef,
            kind: driven.error.kind,
            detail: safeDetail(driven.error.detail),
          })
          return
        }
        deps.log({
          ts: deps.now(),
          event: 'issue_driven',
          ref: req.externalRef,
          created: driven.value.created,
        })
      } catch (e) {
        // 编程错误 / 基础设施故障：只保留第一个，并请求停止调度
        if (!hasFatal) {
          hasFatal = true
          fatal = e
          opts.onFatal?.()
        }
      }
    }

    const task = run()
    running.add(task)
    // 完成后从在途集合摘掉：`externalRef` 决定下一次能否再次调度
    void task.finally(() => {
      inFlightRefs.delete(req.externalRef)
      running.delete(task)
    })
  }

  return {
    schedule(req) {
      if (shouldStop()) return 'stopped'
      if (inFlightRefs.has(req.externalRef)) return 'in_flight'
      if (inFlightRefs.size >= opts.concurrency) return 'at_capacity'
      start(req)
      return 'scheduled'
    },
    get inFlight() {
      return inFlightRefs.size
    },
    async drain() {
      // 正常情况下调用 drain 时已不再 schedule；循环兜住「drain 期间又加入」的边界。
      while (running.size > 0) {
        await Promise.all([...running])
      }
    },
    takeFatal() {
      if (!hasFatal) return undefined
      const value = fatal
      fatal = undefined
      hasFatal = false
      return { value }
    },
  }
}

/** 信号源抽象 —— 测试注入假实现，生产默认 process */
export interface PollerSignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
}

/**
 * 停止信号令牌 —— **订阅制**，不是「一个永不 resolve 的 promise」。
 *
 * 为什么不用 `const stopped = new Promise(...)` 那种写法：
 * 每轮 sleep 都往同一个 pending promise 上挂 `.then`，而那些 reaction 只有在
 * 该 promise **settle 时**才会被丢弃。本进程按设计 7×24 常驻、只在退出时才 settle，
 * 于是每轮泄漏一个闭包（含 timer 与 resolve），60s 一轮 ≈ 每天 1440 个、
 * 一年 50 万个，回收不了。常驻进程的「每轮挂一个监听」必须能主动反注册。
 *
 * 订阅者由 sleep 自己在结束（超时 / 被叫醒）时反注册，所以
 * `listenerCount` 在任何时刻都 ≤ 1；停止时一次性清空并叫醒所有等待者。
 */
export interface StopToken {
  readonly requested: boolean
  /** 当前未结算的订阅数 —— 用来断言「不随轮次增长」 */
  readonly listenerCount: number
  /** 订阅一次；返回反注册函数。已停止时不注册（调用方应先看 `requested`） */
  subscribe(listener: () => void): () => void
  /** 请求停止：只置位一次并清空订阅者，重复调用幂等 */
  request(): void
}

export function createStopToken(): StopToken {
  let requested = false
  const listeners = new Set<() => void>()
  return {
    get requested() {
      return requested
    },
    get listenerCount() {
      return listeners.size
    },
    subscribe(listener) {
      if (requested) return () => undefined
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    request() {
      if (requested) return
      requested = true
      const pending = [...listeners]
      listeners.clear()
      for (const listener of pending) listener()
    },
  }
}

export interface RunPollerForeverOptions {
  readonly intervalMs?: number
  readonly signals?: PollerSignalSource
  /** 可被停止信号打断的 sleep；测试注入立即返回的实现 */
  readonly sleep?: (ms: number, stop: StopToken) => Promise<void>
  /** 注入停止令牌（测试观测订阅数）；省略则每轮循环自建一个 */
  readonly stopToken?: StopToken
  /** 同时在途的驱动上限；缺省见 DEFAULT_DRIVE_CONCURRENCY */
  readonly concurrency?: number
}

const processSignals: PollerSignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler)
  },
  off: (signal, handler) => {
    process.off(signal, handler)
  },
}

/**
 * 常驻循环：每轮只扫描 + 调度，不等驱动完成 —— 轮询节奏与 run 时长解耦。
 *
 * SIGTERM / SIGINT 只保证：
 *   1. 不再调度新 issue；
 *   2. 所有在途驱动结束后退出（`drain()`）。
 *
 * **已知限制**（PRD Constraints 的 AC 调整）：正在执行的 run 没有外部取消接口，
 * 因此这里不 kill 它 —— 强杀会在库里留下 RUNNING run。硬取消留给后续任务。
 */
export async function runPollerForever(
  deps: PollerDeps,
  opts: RunPollerForeverOptions = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const signals = opts.signals ?? processSignals
  const sleep = opts.sleep ?? interruptibleSleep
  const stop = opts.stopToken ?? createStopToken()

  const onSignal = (): void => {
    stop.request()
  }

  const scheduler = createDriveScheduler(deps, {
    concurrency: opts.concurrency ?? DEFAULT_DRIVE_CONCURRENCY,
    shouldStop: () => stop.requested,
    onFatal: onSignal,
  })

  signals.on('SIGTERM', onSignal)
  signals.on('SIGINT', onSignal)
  try {
    while (!stop.requested) {
      const scan = await scanOnce(deps, { shouldStop: () => stop.requested })

      let scheduled = 0
      let deferred = 0
      let skipped = scan.stats.skipped
      for (const req of scan.drives) {
        if (stop.requested) break
        switch (scheduler.schedule(req)) {
          case 'scheduled':
            scheduled += 1
            break
          case 'at_capacity':
            deferred += 1
            break
          default:
            // in_flight（跨轮去重）/ stopped：本轮没有产生新驱动
            skipped += 1
        }
      }

      deps.log({
        ts: deps.now(),
        event: 'poll',
        ...scan.stats,
        skipped,
        scheduled,
        deferred,
        inFlight: scheduler.inFlight,
        stopped: scan.stopped || stop.requested,
      })

      if (stop.requested) break
      await sleep(intervalMs, stop)
    }
  } finally {
    signals.off('SIGTERM', onSignal)
    signals.off('SIGINT', onSignal)
    // 即使扫描 / 日志抛错，也不能留下未收尾的驱动 promise
    await scheduler.drain()
  }

  // fatal 要等在途驱动收尾后再抛出，且正常退出才打 stopped 行
  const fatal = scheduler.takeFatal()
  if (fatal !== undefined) throw fatal.value

  deps.log({ ts: deps.now(), event: 'poller', state: 'stopped' })
}

/**
 * 可被停止信号打断的等待。
 *
 * 两条必须成立的约定：
 *   - 必须 clearTimeout：否则收到 SIGTERM 后进程还要挂满一个 interval
 *     （缺省 60s）才退出，看起来像「不响应信号」；
 *   - 必须反注册：结束时（无论超时还是被叫醒）把订阅摘掉，
 *     否则 7×24 常驻进程的订阅数会随轮次线性增长。
 */
export function interruptibleSleep(ms: number, stop: StopToken): Promise<void> {
  if (stop.requested) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    timer = setTimeout(settle, ms)
    unsubscribe = stop.subscribe(settle)
  })
}

/**
 * 日志脱敏工厂：环境 token 走 `redactSecrets`，
 * remote URL 里内嵌的 userinfo（`https://user:token@host/...`）单独剥掉 ——
 * redactSecrets 只认「本进程已知的 token」，认不出别人写进 remote 的密码。
 */
function createSafeDetail(): (detail: string) => string {
  const secrets = gitAuthSecrets(readTokenFromEnv())
  return (detail) => redactSecrets(stripUserinfo(detail), secrets)
}

/**
 * 剥掉 URL 里的 userinfo（`scheme://user:pass@host` → `scheme://***@host`）。
 *
 * 日志纪律要求 token 不出现在结构化日志里（PRD R8）。`redactSecrets` 只认识
 * 本进程环境里的 token；`repo.remote_url` 是用户注册时给的，可能自带
 * `https://user:token@host/...` 这种写法，不能指望它被环境 token 匹配到。
 */
function stripUserinfo(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@')
}
