/**
 * keel poller —— 常驻接入自动化（任务 08-29-ingress-poller，issue #70 §2）。
 *
 * 这一层只做接线：参数校验、真实依赖（数据库 / GitHubProvider / runIssue）、
 * 单行 JSON 日志。轮询逻辑本身在 `src/ingress/poller.ts`，可脱离数据库单测。
 *
 * 刻意不提供 `--label`：label 的唯一事实源是 `repo.issue_label`，
 * 多项目可以用不同 label，全局开关无法表达且会与仓库配置漂移。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { DEFAULT_MAX_RUNNING_RUNS } from '../control/concurrency/limits.js'
import { collectIssueClarifications } from '../control/issue-clarification.js'
import { drainIssueWriteback } from '../control/issue-writeback.js'
import { preflightModelRouting } from '../execution/model-routing.js'
import { asRole, closePool } from '../fact/db.js'
import { resolveGitHubToken, type TokenResolver } from '../fact/github-auth.js'
import { GitHubProvider, type IssueList, parseRemoteUrl } from '../fact/github-provider.js'
import { acquireResidentLock, lockErrorMessage, type ResidentLock } from '../fact/resident-lock.js'
import {
  createSafeDetail,
  DEFAULT_INTERVAL_MS,
  type PollerDeps,
  type PollerSignalSource,
  type PollIssueInput,
  type PollIssueOutcome,
  type PrOpenTask,
  type RepoRow,
  runPollerForever,
  type StopToken,
} from '../ingress/poller.js'
import type { CancelOutcome, IngestedTask, IssueState } from '../ingress/reconcile.js'
import { findRedriveCandidate, type RedriveCandidate } from '../ingress/redrive.js'
import { type TaskStatus, TERMINAL_STATUSES } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { runIssue } from './run-issue.js'
import {
  type CiMode,
  DEFAULT_OMP_MODEL,
  type HarnessId,
  parseCiMode,
  parseWallClock,
  readLivenessMode,
  readModelRoutingEnv,
  resolveHarness,
  resolveOptionalModel,
  warnWallClockOverride,
} from './run-task.js'
import { cleanupDriverIfNeeded, plainDriver } from './task-driver.js'

/** `--interval <ms>`：只接受正整数，非法值不静默回退缺省 60000 */
export function parseIntervalMs(raw: unknown): Result<number> {
  if (raw === undefined) return ok(DEFAULT_INTERVAL_MS)
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return ok(raw)
  return err(
    makeError(
      'CAPABILITY_UNSUPPORTED',
      `--interval 只接受正整数毫秒（例如 60000），收到:${describeArg(raw)}。` +
        '非法值不会静默回退到 60000 —— 那会让人以为轮询间隔已经改过。',
    ),
  )
}

/**
 * `--concurrency <n>`：缺省取全局 RUNNING 上限。
 *
 * 超过上限不会让吞吐变好：claim 的 N4 检查会直接拒绝，只制造可重试 CONFLICT 噪音。
 * 所以这里在启动期就拒绝，而不是让常驻进程每轮刷错误。
 */
export function parseConcurrency(raw: unknown): Result<number> {
  if (raw === undefined) return ok(DEFAULT_MAX_RUNNING_RUNS)
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    if (raw <= DEFAULT_MAX_RUNNING_RUNS) return ok(raw)
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `--concurrency 不能超过全局 RUNNING 上限 ${DEFAULT_MAX_RUNNING_RUNS}，收到:${describeArg(raw)}。` +
          `要同时跑更多任务，请先调整 N4 全局上限（${DEFAULT_MAX_RUNNING_RUNS}），` +
          '否则超出部分的 claim 只会得到可重试 CONFLICT。',
      ),
    )
  }
  return err(
    makeError(
      'CAPABILITY_UNSUPPORTED',
      `--concurrency 只接受 1-${DEFAULT_MAX_RUNNING_RUNS} 的整数，收到:${describeArg(raw)}。` +
        '非法值不会静默回退到全局上限 —— 那会让人以为并发已经改过。',
    ),
  )
}

function describeArg(raw: unknown): string {
  if (raw === true) return '（缺少数值）'
  return `「${String(raw)}」`
}

/** 所有已注册的 github repo —— poller 的扫描范围（PRD R3） */
export async function loadGithubRepos(): Promise<readonly RepoRow[]> {
  return asRole('keel_control', async (c) => {
    const r = await c.query<RepoRow>(
      `SELECT id, remote_url, default_branch, issue_label
       FROM repo
       WHERE provider = 'github'
       ORDER BY created_at, id`,
    )
    return r.rows
  })
}

/**
 * 按 external_ref 反查 task 状态。
 *
 * 去重的事实来源是 `feedback(source, external_ref)` 唯一键（PRD R6）；
 * 这里沿 feedback → task_feedback → task 读出状态，终态判定交给调用方。
 */
export async function findTaskStatusByExternalRef(
  externalRef: string,
): Promise<TaskStatus | undefined> {
  return asRole('keel_control', async (c) => {
    const r = await c.query<{ status: TaskStatus }>(
      `SELECT t.status
       FROM feedback f
       JOIN task_feedback tf ON tf.feedback_id = f.id
       JOIN task t ON t.id = tf.task_id
       WHERE f.source = 'github' AND f.external_ref = $1
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1`,
      [externalRef],
    )
    return r.rows[0]?.status
  })
}

/**
 * 所有仍在 S-PR_OPEN 的 GitHub 任务。
 *
 * 这些任务不能只靠 open issue 扫描推进：`Closes #n` 生效后 issue 会自动关闭，
 * 而 PR 的 merged 事实仍需要被观察。
 */
export async function loadPrOpenGithubTasks(): Promise<readonly PrOpenTask[]> {
  return asRole('keel_control', async (c) => {
    const r = await c.query<{
      task_id: string
      external_ref: string
      repo_id: string
      remote_url: string
    }>(
      `SELECT DISTINCT ON (t.id)
              t.id AS task_id, f.external_ref, r.id AS repo_id, r.remote_url
       FROM task t
       JOIN task_feedback tf ON tf.task_id=t.id
       JOIN feedback f ON f.id=tf.feedback_id
       JOIN repo r ON r.id=t.repo_id
       WHERE t.status='S-PR_OPEN'
         AND f.source='github'
         AND f.external_ref ~ '^[^#]+#[1-9][0-9]*$'
         AND r.provider='github'
       ORDER BY t.id, f.received_at`,
    )
    return r.rows.map((row) => ({
      taskId: row.task_id,
      externalRef: row.external_ref,
      repoId: row.repo_id,
      remoteUrl: row.remote_url,
    }))
  })
}

export function redriveCandidateFor(externalRef: string): Promise<RedriveCandidate | undefined> {
  return findRedriveCandidate(externalRef)
}

/**
 * 已 ingest、非终态的 GitHub issue 任务 —— issue 关闭对账的输入。
 *
 * 只取注册在案的 github repo（与扫描范围一致）；终态用 `TERMINAL_STATUSES`
 * 而不是 SQL 里再抄一遍状态名，避免两处漂移。
 */
export async function loadIngestedGithubTasks(): Promise<readonly IngestedTask[]> {
  return asRole('keel_control', async (c) => {
    const r = await c.query<{
      task_id: string
      status: TaskStatus
      external_ref: string
      remote_url: string
    }>(
      `SELECT DISTINCT ON (t.id)
              t.id AS task_id, t.status, f.external_ref, r.remote_url
       FROM task t
       JOIN task_feedback tf ON tf.task_id = t.id
       JOIN feedback f ON f.id = tf.feedback_id
       JOIN repo r ON r.id = t.repo_id
       WHERE f.source = 'github'
         AND f.external_ref ~ '^[^#]+#[1-9][0-9]*$'
         AND r.provider = 'github'
         AND NOT (t.status = ANY($1::text[]))
       ORDER BY t.id`,
      [[...TERMINAL_STATUSES]],
    )
    return r.rows.map((row) => ({
      taskId: row.task_id,
      status: row.status,
      externalRef: row.external_ref,
      remoteUrl: row.remote_url,
    }))
  })
}

/**
 * 把「issue 已关闭」落成 T-040 的 `Cancelled`。
 *
 * 有工作树时注入真实 workspace —— T-040 的 CleanWorkspace 才会真的移除它；
 * 准备失败（仓库不可达等）**不阻断取消**：issue 关闭是外部事实，
 * 不被网络卡住。此时 CleanWorkspace 会如实记一条 `SideEffectIntent`，
 * 工作树留给运维手工清理。
 *
 * 刻意不解析 `KEEL_HUMAN_REVIEW_TTL_H`：T-040 只取消 timer、不武装 timer，
 * 传 `null`（关闭调度）不会改变任何行为，也不让一个无关的 env 挡住取消。
 */
export async function cancelClosedIssue(
  task: IngestedTask,
  issue: IssueState,
  now: string,
): Promise<Result<CancelOutcome>> {
  const driver = (await cleanupDriverIfNeeded(task.taskId, null)) ?? plainDriver(null)
  const advanced = await driver.advance(
    task.taskId,
    { type: 'Cancelled', reason: 'issue_closed', closed_at: issue.closedAt },
    now,
  )
  if (!advanced.ok) return advanced
  return ok({
    advanced: advanced.value.advanced,
    transitionId: advanced.value.transition_id,
    reason: advanced.value.reason,
  })
}

export interface PollerMainDeps {
  readonly listRepos?: () => Promise<readonly RepoRow[]>
  readonly listIssues?: (repo: RepoRow) => Promise<Result<IssueList>>
  readonly taskStatus?: (externalRef: string) => Promise<TaskStatus | undefined>
  readonly runIssue?: (input: PollIssueInput) => Promise<Result<PollIssueOutcome>>
  readonly listPrOpenTasks?: () => Promise<readonly PrOpenTask[]>
  readonly redriveCandidate?: (externalRef: string) => Promise<RedriveCandidate | undefined>
  readonly now?: () => string
  readonly log?: (line: Record<string, unknown>) => void
  readonly signals?: PollerSignalSource
  readonly sleep?: (ms: number, stop: StopToken) => Promise<void>
  /** 退出前关闭数据库连接池；测试用它断言「进程真的会退出」 */
  readonly closeDb?: () => Promise<void>
  /**
   * 测试注入：GitHub token 解析器。省略则 env → `gh auth token --hostname <host>`。
   * 启动期预检与 provider 都用它 —— 测试绝不依赖开发机的 gh 登录态。
   */
  readonly tokenResolver?: TokenResolver
  /**
   * 单实例锁；测试注入后不碰真实数据库锁。
   * 返回 `null` 表示同库已有 poller 在运行（明确的启动失败，不等待）。
   */
  readonly acquireLock?: () => Promise<ResidentLock | null>
  /** 测试注入：issue 关闭对账的三段依赖。省略则走真实数据库 / provider / driver */
  readonly listIngestedTasks?: () => Promise<readonly IngestedTask[]>
  readonly issueState?: (remoteUrl: string, issueNumber: number) => Promise<Result<IssueState>>
  readonly cancelTask?: (
    task: IngestedTask,
    issue: IssueState,
    now: string,
  ) => Promise<Result<CancelOutcome>>
}

const HELP = `用法: keel poller [--interval <ms>] [--concurrency <n>] [--ci passed|failed|real]
                   [--model <id>] [--harness omp|claude|pi] [--wall-clock <秒>]

常驻扫描所有已注册 github repo 中带各自 issue_label 的 open issue，
自动 ingest 并驱动到当前可停处(SIGTERM / SIGINT 后不再认领新 issue)。
扫描节奏与单任务时长无关:一轮只负责扫描与调度,有界并发驱动。

选项:
  --interval <ms>      两轮之间的等待毫秒数(默认 ${DEFAULT_INTERVAL_MS});只接受正整数
  --concurrency <n>    同时在途的驱动数(默认 ${DEFAULT_MAX_RUNNING_RUNS},即全局 RUNNING 上限);
                       排不下的 issue 记为 deferred,下一轮重扫;只接受 1-${DEFAULT_MAX_RUNNING_RUNS} 的整数
  --ci passed|failed|real
                       缺省 real;real 需要 GitHub 凭据(KEEL_GITHUB_TOKEN / GITHUB_TOKEN / gh auth login)
  --model <id>         对 omp 缺省 ${DEFAULT_OMP_MODEL},也可设 KEEL_MODEL;空白值拒绝
  --harness omp|claude|pi
                       缺省 omp,也可设 KEEL_HARNESS;非法值拒绝
  --wall-clock <秒>    显式覆盖 stage 墙钟硬上限;缺省按 stage 策略(develop 12h);只接受正整数

环境变量:
  KEEL_MODEL_PROFILE   default|enterprise(缺省 default);enterprise 按阶段使用企业网关目录
  KEEL_MODEL_ALLOWLIST 逗号分隔的允许模型;必须覆盖 profile 下所有阶段可能 spawn 的模型,
                      否则启动即失败(不会等每轮 ingest 写库后才在 run 上失败)

label 从 repo.issue_label 读取,不提供 --label:每个仓库可以不同。
timer-worker 负责到期收割,poller 不处理 wall-clock timer。`

/** `--ci` 缺省 real；只写标志（解析成 true）不静默落到 real —— 那会悄悄打真实 GitHub */
function resolveCiFlag(raw: string | number | boolean | undefined): Result<CiMode> {
  if (raw === undefined) return parseCiMode('real')
  if (typeof raw !== 'string') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        '--ci 需要 passed / failed / real。只写标志等同空白，拒绝静默回退缺省 real。',
      ),
    )
  }
  return parseCiMode(raw)
}

/**
 * 启动期预检：从已注册仓库的 remote 收集唯一 host，逐个确认有可用 token。
 *
 * - repos 为空 → 返回空集：没有可扫描的仓库，就不该因为缺凭据拒绝启动；
 * - remote 解析失败 → 跳过：它会在每轮扫描时被记为 `repo_error`，
 *   凭据预检不冒充 Git 语法校验；
 * - 空白 token 视为缺（`KEEL_GITHUB_TOKEN=''` 不得遮蔽 gh 登录态）。
 */
async function missingTokenHosts(
  listRepos: () => Promise<readonly RepoRow[]>,
  tokenResolver: TokenResolver | undefined,
): Promise<readonly string[]> {
  const resolve = tokenResolver ?? resolveGitHubToken

  const hosts = new Set<string>()
  for (const repo of await listRepos()) {
    const parsed = parseRemoteUrl(repo.remote_url)
    if (parsed.ok) hosts.add(parsed.value.host)
  }

  const missing: string[] = []
  for (const host of hosts) {
    let token: string | undefined
    try {
      token = await resolve(host)
    } catch {
      token = undefined
    }
    if ((token ?? '').trim() === '') missing.push(host)
  }
  return missing
}

/** 缺凭据文案：列出 host，并给出两条可执行修复命令（不打印任何 token 片段） */
function authHelpFor(hosts: readonly string[]): string {
  const lines = [
    `poller: 扫描 issue 需要 GitHub 凭据,以下 host 没有可用 token:${hosts.join(', ')}`,
    '修复方式(任选其一):',
  ]
  for (const host of hosts) {
    lines.push(`  export KEEL_GITHUB_TOKEN="$(gh auth token --hostname ${host})"`)
    lines.push(`  gh auth login --hostname ${host}`)
  }
  return lines.join('\n')
}

export interface BuildPollerRuntimeOptions {
  readonly ci: CiMode
  readonly harness: HarnessId
  readonly model?: string
  readonly wallClockS?: number
  readonly deps?: PollerMainDeps
  readonly now?: () => string
  readonly log?: (line: Record<string, unknown>) => void
}

export interface BuiltPollerRuntime {
  readonly deps: PollerDeps
  readonly missingHosts: readonly string[]
}

/**
 * 构造 poller 的真实依赖，并做启动前凭据预检。
 *
 * `poller` CLI 与统一 `serve` 共用这一入口，避免两套 provider / 对账接线漂移。
 * 预检只解析主机与 token 是否存在，不发起 GitHub 请求。
 */
export async function buildPollerRuntime(
  options: BuildPollerRuntimeOptions,
): Promise<BuiltPollerRuntime> {
  const deps = options.deps ?? {}
  const listRepos = deps.listRepos ?? loadGithubRepos
  const provider = new GitHubProvider(
    deps.tokenResolver === undefined ? {} : { tokenResolver: deps.tokenResolver },
  )
  const now = options.now ?? deps.now ?? (() => new Date().toISOString())
  const log = options.log ?? deps.log ?? ((line) => console.log(JSON.stringify(line)))
  const pollerDeps: PollerDeps = {
    maintain: async () => {
      await drainIssueWriteback(provider, now())
      await collectIssueClarifications(provider, now())
    },
    listRepos,
    listIssues:
      deps.listIssues ?? ((repo) => provider.listOpenIssues(repo.remote_url, repo.issue_label)),
    taskStatus: deps.taskStatus ?? findTaskStatusByExternalRef,
    runIssue:
      deps.runIssue ??
      ((input) =>
        runIssue({
          issueUrl: input.issueUrl,
          label: input.label,
          repoId: input.repoId,
          ci: options.ci,
          harness: options.harness,
          ...(input.redrive === undefined ? {} : { redrive: true }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.wallClockS === undefined ? {} : { wallClockS: options.wallClockS }),
        })),
    listPrOpenTasks: deps.listPrOpenTasks ?? loadPrOpenGithubTasks,
    redriveCandidate: deps.redriveCandidate ?? redriveCandidateFor,
    now,
    log,
    reconcile: {
      listIngestedTasks: deps.listIngestedTasks ?? loadIngestedGithubTasks,
      issueState:
        deps.issueState ??
        (async (remoteUrl, issueNumber) => {
          const issue = await provider.getIssue(remoteUrl, issueNumber)
          if (!issue.ok) return issue
          return ok({ state: issue.value.state, closedAt: issue.value.closedAt })
        }),
      cancelTask: deps.cancelTask ?? cancelClosedIssue,
      redactDetail: createSafeDetail(),
      now,
      log,
    },
  }
  return {
    deps: pollerDeps,
    missingHosts: await missingTokenHosts(listRepos, deps.tokenResolver),
  }
}

export async function pollerMain(
  argv: readonly string[],
  deps: PollerMainDeps = {},
): Promise<void> {
  const { flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(HELP)
    return
  }

  // 从 run-issue 迁移过来的用户很容易顺手带上 --label。静默忽略它，用户会以为
  // 「只扫这个 label」，实际却按各仓库的 issue_label 扫描 —— 这是最坏的失败方式。
  if (flags.label !== undefined) {
    console.error(
      'poller: 不支持 --label。label 的唯一事实源是 repo.issue_label：' +
        '用 `keel register-repo <remoteUrl> --issue-label <name>` 按仓库配置。',
    )
    process.exitCode = 1
    return
  }

  const interval = parseIntervalMs(flags.interval)
  if (!interval.ok) {
    console.error(`poller: ${interval.error.detail}`)
    process.exitCode = 1
    return
  }
  const concurrency = parseConcurrency(flags.concurrency)
  if (!concurrency.ok) {
    console.error(`poller: ${concurrency.error.detail}`)
    process.exitCode = 1
    return
  }
  // 常驻进程启动时就校验：非法模式不能让它在每轮认领后才失败
  const mode = readLivenessMode('poller')
  if (mode === undefined) return
  // 模型路由的拼写错误同理：常驻期间不能每轮都用缺省模型静默跑
  const routing = readModelRoutingEnv('poller')
  if (routing === undefined) return

  const ci = resolveCiFlag(flags.ci)
  if (!ci.ok) {
    console.error(`poller: ${ci.error.detail}`)
    process.exitCode = 1
    return
  }
  const harness = resolveHarness(flags.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) {
    console.error(`poller: ${harness.error.detail}`)
    process.exitCode = 1
    return
  }
  const model = resolveOptionalModel(flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`poller: ${model.error.detail}`)
    process.exitCode = 1
    return
  }
  // allowlist 必须覆盖 profile 下所有可能 spawn 的模型：常驻进程不能等每轮
  // runIssue 的 ingest 写完之后才在第一个 run 上失败。
  const preflight = preflightModelRouting({
    harnessId: harness.value,
    profile: routing.profile,
    allowlist: routing.allowlist,
    ...(model.value === undefined ? {} : { override: model.value }),
  })
  if (!preflight.ok) {
    console.error(`poller: ${preflight.error.detail}`)
    process.exitCode = 1
    return
  }
  const wallClock = parseWallClock(flags['wall-clock'])
  if (!wallClock.ok) {
    console.error(`poller: ${wallClock.error.detail}`)
    process.exitCode = 1
    return
  }
  if (wallClock.value !== undefined) warnWallClockOverride('poller', wallClock.value, mode)

  // 单实例约束先于任何数据库读取：第二个 poller 不应该先把 repo 列一遍、
  // 解析一次 token 再退出。拿不到锁是明确的启动失败，不是等待或静默跳过。
  // 锁是会话级的：正常退出显式释放，kill -9 / 掉电由 PostgreSQL 自动释放。
  let lock: ResidentLock | null
  try {
    lock = await (deps.acquireLock ?? (() => acquireResidentLock('poller')))()
  } catch (e) {
    console.error(`poller: 无法获取单实例锁：${lockErrorMessage(e)}`)
    process.exitCode = 1
    return
  }
  if (lock === null) {
    console.error(
      'poller: 已有实例在运行（同一数据库），拒绝启动第二个 poller。' +
        'poller 与 timer-worker 各自独立；崩溃后锁会自动释放，无需手工清理。',
    )
    process.exitCode = 1
    return
  }

  // 取到锁之后的一切都必须在 try/finally 之内：专用锁连接会一直占着事件循环，
  // 一旦这里抛错而没走到 release，进程既不退出也永远占着锁。
  try {
    // 列出 issue 必须有凭据（provider 在无 token 时直接 AUTH_FAILED）。
    // 预检放在第一轮扫描之前：常驻进程不能「每轮每个仓库一条 AUTH_FAILED」地空转。
    // host 从已注册仓库的 remote 推导 —— GHES 部署要按自己的 host 取登录态。
    const runtime = await buildPollerRuntime({
      ci: ci.value,
      harness: harness.value,
      ...(model.value === undefined ? {} : { model: model.value }),
      ...(wallClock.value === undefined ? {} : { wallClockS: wallClock.value }),
      deps,
    })

    // 启动期预检先于第一轮扫描；repos 为空时不需要任何 token。
    // 预检读一次仓库列表，循环内仍走 live `listRepos` —— 新注册的仓库照常生效。
    if (runtime.missingHosts.length > 0) {
      console.error(authHelpFor(runtime.missingHosts))
      process.exitCode = 1
      return
    }

    await runPollerForever(runtime.deps, {
      intervalMs: interval.value,
      concurrency: concurrency.value,
      ...(deps.signals === undefined ? {} : { signals: deps.signals }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
  } finally {
    // 释放顺序：先放锁，再关连接池。锁失败不改变退出结果；
    // 用 catch 兜底也保证「锁释放抛错」不会跳过 closeDb。
    await lock.release().catch(() => undefined)
    // 常驻循环结束后**必须**收掉连接池：`pg` 的 idle client 默认保持 socket，
    // 不关池的话 main() 返回后事件循环仍有句柄，进程不会退出 ——
    // 表现就是「SIGTERM 之后不再干活了，但进程还挂着」。
    await (deps.closeDb ?? closePool)().catch(() => undefined)
  }
}
