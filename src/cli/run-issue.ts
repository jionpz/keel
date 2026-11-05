/**
 * keel run-issue —— GitHub Issue → task → 驱动到终态(AC5 / AC6)。
 *
 * 刻意只做**组合**:ingest 那一段是 `ingestIssue`(子任务 1),驱动那一段是
 * `runTask`。两段主体都不在这里重写 —— 否则「Issue 闸门」「真实 CI 接线」
 * 这类规则会有两份实现,修一处忘一处。
 *
 * 终态不是 S-DONE(如 S-HUMAN_REVIEW:高风险 RFC 保留人工闸门)时**如实报告并
 * 退出码 0**:编排如实走完了,是流程要求人来看,不是命令失败。只有编排本身
 * 出错(找不到 task、克隆失败、超步数)才非 0。
 */

import type { Result } from '../contracts/errors.js'
import { err, makeError, ok } from '../contracts/errors.js'
import { type ClaudeAuthProbe, requireClaudeReady } from '../execution/adapters/claude-code.js'
import { parseAllowlist, parseProfile, preflightModelRouting } from '../execution/model-routing.js'
import type { TokenResolver } from '../fact/github-auth.js'
import { type GitHubProvider, parseIssueUrl } from '../fact/github-provider.js'
import { parseArgs } from './argv.js'
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'
import { ingestIssue } from './ingest-issue.js'
import {
  type CiMode,
  DEFAULT_OMP_MODEL,
  parseCiMode,
  parseWallClock,
  printNonDoneReport,
  printRunResult,
  type RunTaskResult,
  readLivenessMode,
  readModelRoutingEnv,
  requireGitHubToken,
  resolveCiGateway,
  resolveHarness,
  resolveOptionalModel,
  runTask,
  warnWallClockOverride,
} from './run-task.js'

export interface RunIssueOptions {
  readonly issueUrl: string
  readonly label?: string
  readonly repoId?: string
  readonly maxSteps?: number
  readonly ci?: CiMode
  /** 透传 runTask;显式覆盖 stage 墙钟硬上限 */
  readonly wallClockS?: number
  /** 透传 runTask 的 `--model`；省略则按 harness 解析 */
  readonly model?: string | number | boolean
  /** 透传 runTask 的 `--harness`；省略则 KEEL_HARNESS / 缺省 omp */
  readonly harness?: string | number | boolean
  /** 测试注入 stub provider(只作用于 ingest 侧读 Issue) */
  readonly github?: GitHubProvider
  /** 测试注入：claude 认证探测(默认读本机 `claude auth status`) */
  readonly claudeAuthProbe?: ClaudeAuthProbe
  /** 人工裁决 TTL（毫秒）；省略则读 `KEEL_HUMAN_REVIEW_TTL_H`。`null` = 关闭 */
  readonly humanReviewTtlMs?: number | null
  /**
   * 测试注入：GitHub token 解析器。省略则 env → `gh auth token --hostname <host>`。
   * 同时用于 ingest 侧预检（未注入 `github` 时）与 `--ci real` 的网关检查。
   */
  readonly tokenResolver?: TokenResolver
  readonly now?: string
}

export interface RunIssueResult extends RunTaskResult {
  readonly taskId: string
  readonly feedbackId: string
  readonly created: boolean
}

export async function runIssue(opts: RunIssueOptions): Promise<Result<RunIssueResult>> {
  const ci = opts.ci ?? 'passed'

  // TTL 配置先于 ingest 校验：不能让库里多一个「已 ingest 但驱动不了」的 task。
  const humanReviewTtl =
    opts.humanReviewTtlMs === undefined
      ? resolveHumanReviewTtlMs(process.env.KEEL_HUMAN_REVIEW_TTL_H)
      : ok<number | null>(opts.humanReviewTtlMs)
  if (!humanReviewTtl.ok) return humanReviewTtl

  // 凭据前置于 ingest:缺 token 时不留下一个「已 ingest 但驱动不了」的 task。
  // host 取自 Issue URL —— GHES 部署要按自己的 host 解析 token。
  // 注入 `opts.github` 时跳过：ingest 侧的认证由那个 provider 自己负责。
  const target = parseIssueUrl(opts.issueUrl)
  if (!target.ok) return target
  const issueHost = new URL(target.value.remoteUrl).hostname

  if (opts.github === undefined) {
    const token = await requireGitHubToken(issueHost, opts.tokenResolver)
    if (!token.ok) return token
  }

  // 同一个检查函数,不是第二份 token 逻辑。
  const gateway = await resolveCiGateway(ci, issueHost, opts.tokenResolver)
  if (!gateway.ok) return gateway

  const harness = resolveHarness(opts.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) return harness

  // 模型 / claude 凭据+二进制闸门先于 ingest:不能留下一个已 ingest 却驱动不了的 task。
  if (harness.value === 'claude') {
    const ready =
      opts.claudeAuthProbe === undefined
        ? requireClaudeReady()
        : requireClaudeReady('claude', opts.claudeAuthProbe)
    if (!ready.ok) return ready
  }

  // 只把**显式**模型传下去；omp 缺省由 runTask 里的模型路由按 profile 补齐。
  const model = resolveOptionalModel(opts.model, process.env.KEEL_MODEL)
  if (!model.ok) return model

  // profile / allowlist 同样先于 ingest：非法配置不能让库里多一个驱动不了的 task。
  const profile = parseProfile(process.env.KEEL_MODEL_PROFILE)
  if (!profile.ok) return profile
  const allowlist = parseAllowlist(process.env.KEEL_MODEL_ALLOWLIST)
  if (!allowlist.ok) return allowlist
  // 清单必须覆盖本次调用所有可能 spawn 的模型 —— 否则要到驱动第一个 run 才失败，
  // 而那时 ingest 已经写入了 feedback / task。
  const preflight = preflightModelRouting({
    harnessId: harness.value,
    profile: profile.value,
    allowlist: allowlist.value,
    ...(model.value === undefined ? {} : { override: model.value }),
  })
  if (!preflight.ok) return preflight

  const ingested = await ingestIssue({
    issueUrl: opts.issueUrl,
    ...(opts.label === undefined ? {} : { label: opts.label }),
    ...(opts.repoId === undefined ? {} : { repoId: opts.repoId }),
    ...(opts.github === undefined ? {} : { github: opts.github }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  if (!ingested.ok) return ingested

  const run = await runTask(ingested.value.taskId, {
    ...(opts.maxSteps === undefined ? {} : { maxSteps: opts.maxSteps }),
    ...(opts.wallClockS === undefined ? {} : { wallClockS: opts.wallClockS }),
    ...(opts.claudeAuthProbe === undefined ? {} : { claudeAuthProbe: opts.claudeAuthProbe }),
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
    humanReviewTtlMs: humanReviewTtl.value,
    ...(opts.tokenResolver === undefined ? {} : { tokenResolver: opts.tokenResolver }),
    ci,
  })
  // 编排出错(克隆失败 / 超步数)时 ingest 已经落库了 —— 错误里必须带上 taskId,
  // 否则库里多了一个 task 而命令输出从未提过它,重跑还是要人去猜是哪个。
  // kind 与 cause 原样保留:retryable 由 kind 推导,不在这里另立判断。
  if (!run.ok) {
    return err(
      makeError(
        run.error.kind,
        `task ${ingested.value.taskId}(已 ingest,feedback ${ingested.value.feedbackId})驱动失败:${run.error.detail}`,
        run.error,
      ),
    )
  }

  return ok({
    ...run.value,
    taskId: ingested.value.taskId,
    feedbackId: ingested.value.feedbackId,
    created: ingested.value.created,
  })
}

/** 测试注入点(同 `RunTaskMainDeps`):断言旗标落进 `runIssue` 的 `wallClockS`。 */
export interface RunIssueMainDeps {
  readonly runIssue?: typeof runIssue
}

export async function runIssueMain(
  argv: readonly string[],
  deps: RunIssueMainDeps = {},
): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel run-issue <issueUrl> [--label <name>] [--repo <uuid>]
                          [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude]
                          [--wall-clock <秒>]

ingest 一个 GitHub Issue 并把产生的 task 驱动到终态。
需要 GitHub 凭据（KEEL_GITHUB_TOKEN / GITHUB_TOKEN / gh auth login）。
--ci 缺省 passed(模拟 CI);--ci real 接真实 GitHub PR / CI,凭据来源同上。
--harness 缺省 omp，也可设 KEEL_HARNESS；非法值拒绝（不静默回退）。
--model 对 omp 缺省 ${DEFAULT_OMP_MODEL}，也可设 KEEL_MODEL；空白值拒绝（不静默回退）。
claude 未指定 --model / KEEL_MODEL 时不传 --model。
KEEL_MODEL_PROFILE 可选 default|enterprise（缺省 default）：enterprise 按阶段使用企业网关目录；
非法值启动即报错。KEEL_MODEL_ALLOWLIST 可选逗号分隔的允许模型；必须覆盖 profile 下所有阶段
可能 spawn 的模型，否则在 ingest 之前就拒绝。
--wall-clock 显式覆盖 stage 墙钟硬上限（秒）；缺省按 stage 策略（develop 12h）；只接受正整数，非法值拒绝。
KEEL_HUMAN_REVIEW_TTL_H 控制 S-HUMAN_REVIEW 的超时自动弃单（小时，缺省 24；0 = 关闭；非法值启动即报错）。`)
    return
  }
  const mode = readLivenessMode('run-issue')
  if (mode === undefined) return
  if (readModelRoutingEnv('run-issue') === undefined) return
  const issueUrl = positionals[0] as string
  const label = typeof flags.label === 'string' ? flags.label : undefined
  const repoId = typeof flags.repo === 'string' ? flags.repo : undefined
  const maxSteps =
    typeof flags['max-steps'] === 'number'
      ? flags['max-steps']
      : typeof flags['max-steps'] === 'string'
        ? Number(flags['max-steps'])
        : undefined
  const ci = parseCiMode(typeof flags.ci === 'string' ? flags.ci : 'passed')
  if (!ci.ok) {
    console.error(`run-issue: ${ci.error.detail}`)
    process.exitCode = 1
    return
  }
  const harness = resolveHarness(flags.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) {
    console.error(`run-issue: ${harness.error.detail}`)
    process.exitCode = 1
    return
  }
  const model = resolveOptionalModel(flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`run-issue: ${model.error.detail}`)
    process.exitCode = 1
    return
  }
  const wallClock = parseWallClock(flags['wall-clock'])
  if (!wallClock.ok) {
    console.error(`run-issue: ${wallClock.error.detail}`)
    process.exitCode = 1
    return
  }
  if (wallClock.value !== undefined) warnWallClockOverride('run-issue', wallClock.value, mode)

  const run = deps.runIssue ?? runIssue
  const result = await run({
    issueUrl,
    ...(label === undefined ? {} : { label }),
    ...(repoId === undefined ? {} : { repoId }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ci: ci.value,
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(wallClock.value === undefined ? {} : { wallClockS: wallClock.value }),
  })
  if (!result.ok) {
    console.error(`run-issue: ${result.error.detail}`)
    process.exitCode = 1
    return
  }

  console.log(`taskId: ${result.value.taskId}`)
  console.log(`feedbackId: ${result.value.feedbackId}`)
  console.log(`created: ${result.value.created}`)
  printRunResult(result.value)
  if (result.value.finalStatus !== 'S-DONE') {
    await printNonDoneReport(result.value.taskId, result.value.finalStatus)
  }
}
