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
import { requireClaudeReady } from '../execution/adapters/claude-code.js'
import type { GitHubProvider } from '../fact/github-provider.js'
import { parseArgs } from './argv.js'
import { ingestIssue } from './ingest-issue.js'
import {
  type CiMode,
  DEFAULT_OMP_MODEL,
  parseCiMode,
  printNonDoneReport,
  printRunResult,
  type RunTaskResult,
  resolveCiGateway,
  resolveHarness,
  resolveModelForHarness,
  runTask,
} from './run-task.js'

export interface RunIssueOptions {
  readonly issueUrl: string
  readonly label?: string
  readonly repoId?: string
  readonly maxSteps?: number
  readonly ci?: CiMode
  /** 透传 runTask;验收慢模型可抬高墙钟 */
  readonly wallClockS?: number
  /** 透传 runTask 的 `--model`；省略则按 harness 解析 */
  readonly model?: string | number | boolean
  /** 透传 runTask 的 `--harness`；省略则 KEEL_HARNESS / 缺省 omp */
  readonly harness?: string | number | boolean
  /** 测试注入 stub provider(只作用于 ingest 侧读 Issue) */
  readonly github?: GitHubProvider
  readonly now?: string
}

export interface RunIssueResult extends RunTaskResult {
  readonly taskId: string
  readonly feedbackId: string
  readonly created: boolean
}

export async function runIssue(opts: RunIssueOptions): Promise<Result<RunIssueResult>> {
  const ci = opts.ci ?? 'passed'

  // 凭据前置于 ingest:缺 token 时不留下一个「已 ingest 但驱动不了」的 task。
  // 同一个检查函数,不是第二份 token 逻辑。
  const gateway = resolveCiGateway(ci)
  if (!gateway.ok) return gateway

  const harness = resolveHarness(opts.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) return harness

  // 模型 / claude 凭据+二进制闸门先于 ingest:不能留下一个已 ingest 却驱动不了的 task。
  if (harness.value === 'claude') {
    const ready = requireClaudeReady()
    if (!ready.ok) return ready
  }

  const model = resolveModelForHarness(harness.value, opts.model, process.env.KEEL_MODEL)
  if (!model.ok) return model

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
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
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

export async function runIssueMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel run-issue <issueUrl> [--label <name>] [--repo <uuid>]
                          [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude]

ingest 一个 GitHub Issue 并把产生的 task 驱动到终态。
--ci 缺省 passed(模拟 CI);--ci real 接真实 GitHub PR / CI,需要 KEEL_GITHUB_TOKEN。
--harness 缺省 omp，也可设 KEEL_HARNESS；非法值拒绝（不静默回退）。
--model 对 omp 缺省 ${DEFAULT_OMP_MODEL}，也可设 KEEL_MODEL；空白值拒绝（不静默回退）。
claude 未指定 --model / KEEL_MODEL 时不传 --model。`)
    return
  }
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
  const model = resolveModelForHarness(harness.value, flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`run-issue: ${model.error.detail}`)
    process.exitCode = 1
    return
  }

  const result = await runIssue({
    issueUrl,
    ...(label === undefined ? {} : { label }),
    ...(repoId === undefined ? {} : { repoId }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ci: ci.value,
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
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
