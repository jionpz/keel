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
import { asRole, closePool } from '../fact/db.js'
import { GitHubProvider, type IssueList, readTokenFromEnv } from '../fact/github-provider.js'
import {
  DEFAULT_INTERVAL_MS,
  type PollerDeps,
  type PollerSignalSource,
  type PollIssueInput,
  type PollIssueOutcome,
  type RepoRow,
  runPollerForever,
  type StopToken,
} from '../ingress/poller.js'
import type { TaskStatus } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { runIssue } from './run-issue.js'
import {
  type CiMode,
  DEFAULT_OMP_MODEL,
  parseCiMode,
  parseWallClock,
  readLivenessMode,
  resolveHarness,
  resolveModelForHarness,
  warnWallClockOverride,
} from './run-task.js'

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

function describeArg(raw: unknown): string {
  if (raw === true) return '（缺少毫秒数）'
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
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [externalRef],
    )
    return r.rows[0]?.status
  })
}

export interface PollerMainDeps {
  readonly listRepos?: () => Promise<readonly RepoRow[]>
  readonly listIssues?: (repo: RepoRow) => Promise<Result<IssueList>>
  readonly taskStatus?: (externalRef: string) => Promise<TaskStatus | undefined>
  readonly runIssue?: (input: PollIssueInput) => Promise<Result<PollIssueOutcome>>
  readonly now?: () => string
  readonly log?: (line: Record<string, unknown>) => void
  readonly signals?: PollerSignalSource
  readonly sleep?: (ms: number, stop: StopToken) => Promise<void>
  /** 退出前关闭数据库连接池；测试用它断言「进程真的会退出」 */
  readonly closeDb?: () => Promise<void>
}

const HELP = `用法: keel poller [--interval <ms>] [--ci passed|failed|real] [--model <id>]
                   [--harness omp|claude] [--wall-clock <秒>]

常驻扫描所有已注册 github repo 中带各自 issue_label 的 open issue，
自动 ingest 并驱动到当前可停处(SIGTERM / SIGINT 后不再认领新 issue)。

选项:
  --interval <ms>      两轮之间的等待毫秒数(默认 ${DEFAULT_INTERVAL_MS});只接受正整数
  --ci passed|failed|real
                       缺省 real;real 需要 KEEL_GITHUB_TOKEN
  --model <id>         对 omp 缺省 ${DEFAULT_OMP_MODEL},也可设 KEEL_MODEL;空白值拒绝
  --harness omp|claude 缺省 omp,也可设 KEEL_HARNESS;非法值拒绝
  --wall-clock <秒>    显式覆盖 stage 墙钟硬上限;缺省按 stage 策略(develop 12h);只接受正整数

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
  // 常驻进程启动时就校验：非法模式不能让它在每轮认领后才失败
  const mode = readLivenessMode('poller')
  if (mode === undefined) return

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
  const model = resolveModelForHarness(harness.value, flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`poller: ${model.error.detail}`)
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

  // 列出 issue 必须有凭据（provider 在无 token 时直接 AUTH_FAILED）。
  // 前置检查避免「每轮每个仓库一条 AUTH_FAILED，进程还在常驻」的空转。
  // 空白值也算缺：`KEEL_GITHUB_TOKEN=''` 会覆盖 GITHUB_TOKEN 又不产生有效 header，
  // 让 poller 在常驻状态里每轮撞 401。
  if ((readTokenFromEnv() ?? '').trim() === '') {
    console.error(
      'poller: 扫描 issue 需要 GitHub 凭据。设置方式:`export KEEL_GITHUB_TOKEN="$(gh auth token)"`',
    )
    process.exitCode = 1
    return
  }

  const provider = new GitHubProvider()
  const pollerDeps: PollerDeps = {
    listRepos: deps.listRepos ?? loadGithubRepos,
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
          ci: ci.value,
          harness: harness.value,
          ...(model.value === undefined ? {} : { model: model.value }),
          ...(wallClock.value === undefined ? {} : { wallClockS: wallClock.value }),
        })),
    now: deps.now ?? (() => new Date().toISOString()),
    log: deps.log ?? ((line) => console.log(JSON.stringify(line))),
  }

  try {
    await runPollerForever(pollerDeps, {
      intervalMs: interval.value,
      ...(deps.signals === undefined ? {} : { signals: deps.signals }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    })
  } finally {
    // 常驻循环结束后**必须**收掉连接池：`pg` 的 idle client 默认保持 socket，
    // 不关池的话 main() 返回后事件循环仍有句柄，进程不会退出 ——
    // 表现就是「SIGTERM 之后不再干活了，但进程还挂着」。
    await (deps.closeDb ?? closePool)().catch(() => undefined)
  }
}
