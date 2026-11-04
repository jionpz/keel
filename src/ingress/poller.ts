/**
 * 常驻 poller 的轮询核心（任务 08-29-ingress-poller，issue #70 §2）。
 *
 * 边界：本模块只做「扫描 + 组合」，是接入层，不参与状态机决策。
 *   - ingest / 驱动全部走注入的 `runIssue`（它内部完成 ingest + runTask），
 *     这里不复制任何一段；
 *   - 不引入队列 / 并发框架：Agent 驱动是重操作，顺序处理更容易诊断；
 *   - 不处理 wall-clock timer —— 那是 timer-worker 的职责（PRD R10）。
 *
 * 全部依赖可注入，所以轮询逻辑可以脱离数据库与 GitHub 单测。
 */

import type { Result } from '../contracts/errors.js'
import { gitAuthSecrets, readTokenFromEnv, redactSecrets } from '../fact/github-auth.js'
import { type IssueList, issueUrlFor, parseRemoteUrl } from '../fact/github-provider.js'
import { isTerminal, type TaskStatus } from '../shared/ids.js'

export const DEFAULT_INTERVAL_MS = 60_000

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
   * 返回 undefined = 还没有 task；终态判定由 pollOnce 用 TERMINAL_STATUSES 做。
   */
  readonly taskStatus: (externalRef: string) => Promise<TaskStatus | undefined>
  readonly runIssue: (input: PollIssueInput) => Promise<Result<PollIssueOutcome>>
  readonly now: () => string
  /** 单行结构化日志出口；实现方负责 JSON.stringify */
  readonly log: (line: Record<string, unknown>) => void
}

export interface PollStats {
  /** 本轮查询的 repo 数 */
  readonly repos: number
  /** 本轮看到的 open issue 数（已排除 PR） */
  readonly scanned: number
  /** 新建 task 数 */
  readonly ingested: number
  /** 驱动成功数（含新建 —— 新 issue 也会被驱动到当前可停处） */
  readonly driven: number
  /** 已终态、直接跳过的数 */
  readonly skipped: number
  /** repo 级 + issue 级可预期失败数 */
  readonly errors: number
  /** 任一仓库触到分页上限 */
  readonly truncated: boolean
}

export interface PollRoundResult {
  readonly stats: PollStats
  /** 收到停止信号，本轮没有走完 */
  readonly stopped: boolean
}

export interface PollOnceOptions {
  /** SIGTERM/SIGINT 后返回 true：不再认领新 issue，当前 run 结束后退出 */
  readonly shouldStop?: () => boolean
}

/**
 * 跑一轮：逐仓库扫描 → 逐 issue 判断 → 驱动的交给 `runIssue`。
 *
 * 单个 repo / issue 的可预期失败只记 errors 并继续（PRD R11）；
 * 不可预期异常（编程错误 / 基础设施故障）照常抛出，不在这里吞掉。
 */
export async function pollOnce(
  deps: PollerDeps,
  opts: PollOnceOptions = {},
): Promise<PollRoundResult> {
  const shouldStop = opts.shouldStop ?? (() => false)
  const secrets = gitAuthSecrets(readTokenFromEnv())
  // detail / remote 里可能有凭据：环境 token 走 redactSecrets，
  // remote URL 里内嵌的 userinfo（`https://user:token@host/...`）单独剥掉 ——
  // redactSecrets 只认「本进程已知的 token」，认不出别人写进 remote 的密码。
  const safeDetail = (detail: string): string => redactSecrets(stripUserinfo(detail), secrets)

  const stats = {
    repos: 0,
    scanned: 0,
    ingested: 0,
    driven: 0,
    skipped: 0,
    errors: 0,
    truncated: false,
  }
  let stopped = false

  const repos = await deps.listRepos()
  stats.repos = repos.length

  /**
   * 同一轮内已认领过的 external_ref。
   *
   * 仓库注册表的 `remote_url` 没有唯一索引（见 database-guidelines.md 的已知限制），
   * 两条 repo 行指向同一个 remote 时，同一个 issue 会在一轮里被看到两次。
   * 单进程顺序执行不会并发双跑，但会把同一个 task 连驱动两次 ——
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

      // 终态 task 跳过；没有 task 或非终态都继续驱动（PRD R5）。
      const status = await deps.taskStatus(externalRef)
      if (status !== undefined && isTerminal(status)) {
        stats.skipped += 1
        continue
      }

      const driven = await deps.runIssue({
        issueUrl: issueUrlFor(parsed.value, issue.number),
        repoId: repo.id,
        label: repo.issue_label,
      })
      if (!driven.ok) {
        stats.errors += 1
        deps.log({
          ts: deps.now(),
          event: 'issue_error',
          ref: externalRef,
          kind: driven.error.kind,
          detail: safeDetail(driven.error.detail),
        })
        continue
      }

      stats.driven += 1
      if (driven.value.created) stats.ingested += 1
    }

    if (stopped) break
  }

  deps.log({ ts: deps.now(), event: 'poll', ...stats, stopped })
  return { stats, stopped }
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
 * 常驻循环。SIGTERM / SIGINT 只保证：
 *   1. 不再认领新 issue（每轮开始、每个 repo、每个 issue 之间检查）；
 *   2. 当前 `runIssue` 结束后退出。
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

  signals.on('SIGTERM', onSignal)
  signals.on('SIGINT', onSignal)
  try {
    while (!stop.requested) {
      await pollOnce(deps, { shouldStop: () => stop.requested })
      if (stop.requested) break
      await sleep(intervalMs, stop)
    }
  } finally {
    signals.off('SIGTERM', onSignal)
    signals.off('SIGINT', onSignal)
  }

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
 * 剥掉 URL 里的 userinfo（`scheme://user:pass@host` → `scheme://***@host`）。
 *
 * 日志纪律要求 token 不出现在结构化日志里（PRD R8）。`redactSecrets` 只认识
 * 本进程环境里的 token；`repo.remote_url` 是用户注册时给的，可能自带
 * `https://user:token@host/...` 这种写法，不能指望它被环境 token 匹配到。
 */
function stripUserinfo(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@')
}
