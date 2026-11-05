/**
 * keel run-task —— 驱动单 task 到终态(issue #27)。
 *
 * 组装 worktree workspace(持久项目根 + prepareProject from remote_url),
 * 接线 runTaskToCompletion,输出终态 + 转移轨迹。
 *
 * `--ci real` 接真实 GitHub(PR 网关 + CI 网关);缺省仍是 `passed`(模拟结果)——
 * 缺省值刻意不动:一个不带参数的 run-task 不应该悄悄打真实 API 建 PR。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { HarnessAdapter } from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { type LivenessMode, livenessMode } from '../control/liveness/policy.js'
import { LivenessStore } from '../control/liveness/store.js'
import {
  runTaskToCompletion,
  type StepRecord,
  type StopReason,
} from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import {
  type ClaudeAuthProbe,
  ClaudeCodeAdapter,
  requireClaudeReady,
} from '../execution/adapters/claude-code.js'
import { DEFAULT_OMP_MODEL, OmpAdapter } from '../execution/adapters/omp.js'
import {
  type ModelProfile,
  parseAllowlist,
  parseProfile,
  preflightModelRouting,
} from '../execution/model-routing.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asRole } from '../fact/db.js'
import { GitHubProvider, readTokenFromEnv } from '../fact/github-provider.js'
import type { TaskStatus } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'
import { statusMain } from './status.js'
import { loadTaskWorkspace } from './task-workspace.js'

export const CI_MODES = ['passed', 'failed', 'real'] as const
export type CiMode = (typeof CI_MODES)[number]

export const HARNESS_IDS = ['omp', 'claude'] as const
export type HarnessId = (typeof HARNESS_IDS)[number]

export function parseCiMode(raw: string): Result<CiMode> {
  const found = CI_MODES.find((m) => m === raw)
  if (found === undefined) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `--ci 只接受 ${CI_MODES.join(' | ')},收到:${raw}。` +
          '拼错的取值不能静默退化成模拟 CI —— 那会让人以为跑了真实 CI。',
      ),
    )
  }
  return ok(found)
}

export { DEFAULT_OMP_MODEL }

/**
 * 解析模型 id，**不**套缺省。CLI `--model` > env `KEEL_MODEL`；都没有 → `undefined`。
 * 空白 / 只写标志 → `CAPABILITY_UNSUPPORTED`。
 *
 * omp 用 `resolveModel` 再套 `DEFAULT_OMP_MODEL`；claude 用本函数，
 * 未指定则不传 `--model`（禁止把 deepseek 缺省塞给 claude）。
 */
export function resolveOptionalModel(
  cli: string | number | boolean | undefined,
  env: string | undefined,
): Result<string | undefined> {
  if (cli !== undefined) {
    const r = parseModelToken(cli, '--model')
    return r.ok ? ok(r.value) : r
  }
  if (env !== undefined) {
    const r = parseModelToken(env, 'KEEL_MODEL')
    return r.ok ? ok(r.value) : r
  }
  return ok(undefined)
}

export function resolveModel(
  cli: string | number | boolean | undefined,
  env: string | undefined,
): Result<string> {
  const r = resolveOptionalModel(cli, env)
  if (!r.ok) return r
  return ok(r.value ?? DEFAULT_OMP_MODEL)
}

/**
 * `--harness` > `KEEL_HARNESS` > 缺省 `omp`。
 * 非法 / 空白 / 只写标志 → `CAPABILITY_UNSUPPORTED`，不静默回退 omp。
 */
export function resolveHarness(
  cli: string | number | boolean | undefined,
  env: string | undefined,
): Result<HarnessId> {
  if (cli !== undefined) return parseHarnessToken(cli, '--harness')
  if (env !== undefined) return parseHarnessToken(env, 'KEEL_HARNESS')
  return ok('omp')
}

function parseHarnessToken(
  raw: string | number | boolean,
  source: '--harness' | 'KEEL_HARNESS',
): Result<HarnessId> {
  if (typeof raw === 'boolean') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `${source} 需要 omp 或 claude。只写标志没有值等同空白，` +
          '空白 harness 会静默回退缺省 omp，拒绝。',
      ),
    )
  }
  const trimmed = String(raw).trim()
  if (trimmed === '') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `${source} 为空。空白 harness 会静默回退缺省 omp，拒绝。`,
      ),
    )
  }
  const found = HARNESS_IDS.find((id) => trimmed === id)
  if (found === undefined) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `${source} 只接受 ${HARNESS_IDS.join(' | ')},收到:${trimmed}。` +
          '拼错的取值不能静默退化成 omp。',
      ),
    )
  }
  return ok(found)
}

/**
 * 按 harness 解析模型。omp 套缺省；claude 不套（禁止 deepseek 进 --model）。
 * 新增 harness 必须加 case —— 没有 default 回退。
 */
export function resolveModelForHarness(
  harness: HarnessId,
  cli: string | number | boolean | undefined,
  env: string | undefined,
): Result<string | undefined> {
  switch (harness) {
    case 'omp': {
      const r = resolveModel(cli, env)
      return r.ok ? ok(r.value) : r
    }
    case 'claude':
      return resolveOptionalModel(cli, env)
  }
}

export function createHarnessAdapter(
  harness: HarnessId,
  model: string | undefined,
): HarnessAdapter {
  switch (harness) {
    case 'claude':
      return new ClaudeCodeAdapter(model === undefined ? {} : { model })
    case 'omp':
      return new OmpAdapter({ model: model ?? DEFAULT_OMP_MODEL })
  }
}

function parseModelToken(
  raw: string | number | boolean,
  source: '--model' | 'KEEL_MODEL',
): Result<string> {
  if (typeof raw === 'boolean') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `${source} 需要一个非空模型 id。只写标志没有值等同空白，` +
          '空白模型会静默回退缺省，拒绝。',
      ),
    )
  }
  const trimmed = String(raw).trim()
  if (trimmed === '') {
    return err(
      makeError('CAPABILITY_UNSUPPORTED', `${source} 为空。空白模型会静默回退缺省，拒绝。`),
    )
  }
  return ok(trimmed)
}

/**
 * `--ci real` 的凭据前置检查。
 *
 * 缺 token 时在**进 loop 之前**失败:否则要跑完 brainstorm→develop 几分钟、
 * 花掉真实 token,才在 CreatePullRequest 撞上 AUTH_FAILED。
 *
 * 返回 undefined 表示模拟模式(passed/failed),此时 CreatePullRequest 仍记意图。
 */
export function resolveCiGateway(ci: CiMode): Result<GitHubProvider | undefined> {
  if (ci !== 'real') return ok(undefined)
  if (readTokenFromEnv() === undefined) {
    return err(
      makeError(
        'AUTH_FAILED',
        '--ci real 需要 GitHub 凭据。设置方式:`export KEEL_GITHUB_TOKEN="$(gh auth token)"`',
      ),
    )
  }
  return ok(new GitHubProvider())
}

/**
 * 解析 `--wall-clock <秒>`。
 *
 * 只接受正整数，其余一律拒绝 —— 与 `--ci` / `--harness` 同一条纪律：
 * 拼错的值静默退化成默认 180，会让人以为「上限已经抬高了」，然后在真机跑满
 * 三分钟时被带走。省略则返回 undefined，交给下游默认值。
 */
export function parseWallClock(raw: unknown): Result<number | undefined> {
  if (raw === undefined) return ok(undefined)
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return ok(raw)
  return err(
    makeError(
      'CAPABILITY_UNSUPPORTED',
      `--wall-clock 只接受正整数秒（例如 600），收到:${stringifyArg(raw)}。` +
        '非法值不会静默回退到默认 180 —— 那会让人以为上限已经调过。',
    ),
  )
}

/** 把 argv 里的原值转成人能读的样子（布尔 true 表示旗标后面没跟值） */
function stringifyArg(raw: unknown): string {
  if (raw === true) return '（缺少秒数）'
  return `「${String(raw)}」`
}

/**
 * 启动期校验 `KEEL_LIVENESS_MODE`。
 *
 * 不把异常留给全局处理：一条清楚的 `keel run-task: KEEL_LIVENESS_MODE=... 非法`
 * 比堆栈有用，也保证在任何数据库动作之前就停下。
 */
export function readLivenessMode(command: string): LivenessMode | undefined {
  try {
    return livenessMode()
  } catch (error) {
    console.error(`${command}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return undefined
  }
}

export interface ModelRoutingEnv {
  readonly profile: ModelProfile
  readonly allowlist: readonly string[]
}

/**
 * 启动期校验模型路由环境变量。
 *
 * 非法值必须在进入驱动之前失败：常驻 poller 否则会在每轮认领之后才暴露
 * 同一个拼写错误，而运行中的每个 run 都已按缺省模型跑掉了。
 */
export function readModelRoutingEnv(command: string): ModelRoutingEnv | undefined {
  const profile = parseProfile(process.env.KEEL_MODEL_PROFILE)
  if (!profile.ok) {
    console.error(`${command}: ${profile.error.detail}`)
    process.exitCode = 1
    return undefined
  }
  const allowlist = parseAllowlist(process.env.KEEL_MODEL_ALLOWLIST)
  if (!allowlist.ok) {
    console.error(`${command}: ${allowlist.error.detail}`)
    process.exitCode = 1
    return undefined
  }
  return { profile: profile.value, allowlist: allowlist.value }
}

/**
 * 显式 `--wall-clock` 会覆盖所有 stage 硬上限 —— 这是逃生阀，但必须说出来，
 * 否则使用者会以为 stage 策略还在生效。
 */
export function warnWallClockOverride(
  command: string,
  explicitS: number,
  mode: LivenessMode,
): void {
  const fallback =
    mode === 'wallclock'
      ? 'wallclock 模式默认 180s'
      : 'LIVENESS_POLICY 的 stage 上限（develop 12h）'
  console.warn(`${command}: --wall-clock ${explicitS}s 覆盖 ${fallback}`)
}

export interface RunTaskOptions {
  readonly maxSteps?: number
  readonly ci?: CiMode
  /** 显式覆盖 stage 墙钟硬上限(秒)。省略时 progress 模式按 stage 策略,wallclock 模式 180s。 */
  readonly wallClockS?: number
  /**
   * `--model` 原值。omp：省略则 KEEL_MODEL / 缺省 deepseek；
   * claude：省略则不传 `--model`。空白拒绝。
   */
  readonly model?: string | number | boolean
  /** `--harness` 原值。省略则 KEEL_HARNESS / 缺省 omp。 */
  readonly harness?: string | number | boolean
  /**
   * 测试注入：claude 认证探测。省略则读本机 `claude auth status --json`。
   * 不注入会让断言依赖「本机是否装了 claude、是否登录」。
   */
  readonly claudeAuthProbe?: ClaudeAuthProbe
  /**
   * 人工裁决 TTL（毫秒）。省略则读 `KEEL_HUMAN_REVIEW_TTL_H`；
   * `null` = 关闭调度。注入点让测试不必改全局 env。
   */
  readonly humanReviewTtlMs?: number | null
}

export interface RunTaskResult {
  readonly finalStatus: TaskStatus
  readonly steps: readonly StepRecord[]
  /** 为什么停下来 —— 与 finalStatus 一起读才答得出「是在等人，还是已经做完」 */
  readonly stopReason: StopReason
  /** 真实模式下建/复用的 PR;模拟模式与未到 S-PR_OPEN 时为 null */
  readonly prUrl: string | null
}

/**
 * run-task 主体 —— run-issue 复用这一段,不复制接线逻辑。
 */
export async function runTask(
  taskId: string,
  opts: RunTaskOptions = {},
): Promise<Result<RunTaskResult>> {
  const ci = opts.ci ?? 'passed'
  const maxSteps = opts.maxSteps ?? 30

  // 非法模式在任何数据库动作前失败；巡检语义不能被一次拼写错误悄悄关掉。
  const mode = livenessMode()

  // 人工裁决 TTL 与 --ci / --harness 同一条纪律：拼错的值启动即报错，
  // 不静默回退默认 24h（那会让人以为「超时已关掉」或「已调长」）。
  const humanReviewTtl =
    opts.humanReviewTtlMs === undefined
      ? resolveHumanReviewTtlMs(process.env.KEEL_HUMAN_REVIEW_TTL_H)
      : ok<number | null>(opts.humanReviewTtlMs)
  if (!humanReviewTtl.ok) return humanReviewTtl

  const gateway = resolveCiGateway(ci)
  if (!gateway.ok) return gateway

  const harness = resolveHarness(opts.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) return harness

  if (harness.value === 'claude') {
    const ready =
      opts.claudeAuthProbe === undefined
        ? requireClaudeReady()
        : requireClaudeReady('claude', opts.claudeAuthProbe)
    if (!ready.ok) return ready
  }

  // 模型路由：非法 profile / allowlist 在任何数据库动作前失败（R6）。
  const profile = parseProfile(process.env.KEEL_MODEL_PROFILE)
  if (!profile.ok) return profile
  const allowlist = parseAllowlist(process.env.KEEL_MODEL_ALLOWLIST)
  if (!allowlist.ok) return allowlist
  // 只有显式 --model / KEEL_MODEL 才是 override。omp 的缺省由
  // resolveStageModel 按 profile 补齐；在这里提前套缺省会让 enterprise 永远失效。
  // adapter 也只拿显式值：omp 的 fallback 用同一个 DEFAULT_OMP_MODEL，
  // 编排器则用 spec.model 覆盖它 —— 模型解析只有 resolveStageModel 一处。
  const override = resolveOptionalModel(opts.model, process.env.KEEL_MODEL)
  if (!override.ok) return override

  // allowlist 必须覆盖本次 profile 下所有可能 spawn 的模型 —— 否则会在
  // 认领之后才失败；这里在任何数据库动作前用同一套解析预检。
  const preflight = preflightModelRouting({
    harnessId: harness.value,
    profile: profile.value,
    allowlist: allowlist.value,
    ...(override.value === undefined ? {} : { override: override.value }),
  })
  if (!preflight.ok) return preflight

  // 持久项目根 → 绑定项目 → 同步基线。失败即不创建 run。
  const loaded = await loadTaskWorkspace(taskId)
  if (!loaded.ok) return loaded
  const binding = loaded.value
  const now = () => new Date().toISOString()

  // progress 模式下巡检在另一个进程里，只能通过 run_liveness 看到这个 run。
  // 不接 store 时 supervisor 仍能保护活进程，但进程崩溃后的孤儿无人收割。
  const livenessStore = mode === 'progress' ? new LivenessStore() : undefined
  try {
    const result = await runTaskToCompletion(
      taskId,
      {
        driver: new WorkflowDriver(
          new RuleBasedPolicyEngine(DEFAULT_RULESET),
          binding,
          gateway.value,
          humanReviewTtl.value,
        ),
        sessions: new HarnessSessionManager(),
        adapter: createHarnessAdapter(harness.value, override.value),
        workspace: { mode: 'worktree', ...binding },
        now,
        modelProfile: profile.value,
        modelAllowlist: allowlist.value,
        ...(override.value === undefined ? {} : { modelOverride: override.value }),
        ...(livenessStore === undefined ? {} : { livenessStore }),
        ...(opts.wallClockS === undefined ? {} : { wallClockS: opts.wallClockS }),
      },
      {
        maxSteps,
        ...(gateway.value === undefined
          ? { externalCi: async () => (ci === 'failed' ? 'failed' : 'passed') }
          : { ci: gateway.value }),
      },
    )
    if (!result.ok) return result

    return ok({
      finalStatus: result.value.finalStatus,
      steps: result.value.steps,
      stopReason: result.value.stopReason,
      prUrl: await readPrUrl(taskId),
    })
  } finally {
    await livenessStore?.close()
  }
}

/**
 * 从事件流取 PR URL。
 *
 * 首次创建落 `SideEffectApplied`、幂等复用落 `SideEffectSkipped`,
 * 两者 payload 同构(见 src/control/driver/effects.ts 的 createPullRequest)——
 * 只认 Applied 会让重入的 run 打印不出 PR。
 */
export async function readPrUrl(taskId: string): Promise<string | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ pr_url: string | null }>(
      `SELECT payload->>'pr_url' AS pr_url FROM event
       WHERE task_id = $1
         AND type IN ('SideEffectApplied', 'SideEffectSkipped')
         AND payload->>'kind' = 'CreatePullRequest'
       ORDER BY seq DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0]?.pr_url ?? null
}

/**
 * 停止原因的人话。
 *
 * 与 `finalStatus` 分开打，是因为两者回答的是不同问题：「走到哪」与「为什么停」。
 * 旧输出只有前者，于是「卡住」和「等人」长得一样（见 loop.ts 阶段态分支）。
 */
const STOP_REASON_TEXT: Readonly<Record<StopReason, string>> = {
  terminal: '已到终态',
  paused: '控制模式不是 auto（预算熔断或人工接管），恢复后可从这里继续',
  'awaiting-clarification': '等人工回答澄清问题',
  'awaiting-external-ci': '等外部 CI 结果',
  'awaiting-human': '等人工审批（批准 / 驳回 / 回炉）',
  'capability-denied': '能力请求被拒，需要人工或外部介入',
  cancelled: '最近一次 run 被人工撤回，等恢复',
}

export function printRunResult(result: RunTaskResult): void {
  console.log(`finalStatus: ${result.finalStatus}`)
  console.log(`stopped: ${result.stopReason}（${STOP_REASON_TEXT[result.stopReason]}）`)
  if (result.prUrl !== null) {
    console.log(`prUrl: ${result.prUrl}`)
  }
  console.log('steps:')
  for (const s of result.steps) {
    console.log(`  ${s.status_before} -${s.transition ?? '?'}-> ${s.status_after} [${s.note}]`)
  }
}

/**
 * 非 S-DONE 收尾时的如实报告。
 *
 * 停在 S-HUMAN_REVIEW / S-REJECTED 是**设计内**结果(高风险 RFC 保留人工闸门),
 * 不是编排失败 —— 所以打现状而不是改退出码。输出直接复用 keel status,
 * 不在这里写第二份事件读取。
 */
export async function printNonDoneReport(taskId: string, finalStatus: TaskStatus): Promise<void> {
  console.log(`\n未到 S-DONE(停在 ${finalStatus})—— 以下是该 task 现状(同 keel status):`)
  await statusMain([taskId, '--events', '12'])
}

/**
 * 测试注入点。默认用真实实现 —— 只为让「旗标真的落进 `runTask` 的
 * `wallClockS`」可被断言,不必起真进程(AC6)。
 */
export interface RunTaskMainDeps {
  readonly runTask?: typeof runTask
}

export async function runTaskMain(
  argv: readonly string[],
  deps: RunTaskMainDeps = {},
): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel run-task <taskId> [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude] [--wall-clock <秒>]

驱动单 task 到终态(真实 harness + worktree)。--ci 缺省 passed(模拟 CI 结果);
--ci real 接真实 GitHub PR / CI,需要 KEEL_GITHUB_TOKEN。
--harness 缺省 omp，也可设 KEEL_HARNESS；非法值拒绝（不静默回退）。
--model 对 omp 缺省 ${DEFAULT_OMP_MODEL}，也可设 KEEL_MODEL；空白值拒绝（不静默回退）。
claude 未指定 --model / KEEL_MODEL 时不传 --model（不把 omp 缺省塞给 claude）。
KEEL_MODEL_PROFILE 可选 default|enterprise（缺省 default）：enterprise 按阶段使用企业网关目录；
非法值启动即报错。KEEL_MODEL_ALLOWLIST 可选逗号分隔的允许模型；必须覆盖 profile 下所有阶段
可能 spawn 的模型，否则启动即拒绝（不会等 run 认领后才失败）。
--wall-clock 显式覆盖 stage 墙钟硬上限（秒）；缺省按 stage 策略（develop 12h）；只接受正整数，非法值拒绝。
KEEL_HUMAN_REVIEW_TTL_H 控制 S-HUMAN_REVIEW 的超时自动弃单（小时，缺省 24；0 = 关闭；非法值启动即报错）。`)
    return
  }
  const mode = readLivenessMode('run-task')
  if (mode === undefined) return
  // 模型路由的拼写错误同样要在进入驱动之前暴露
  if (readModelRoutingEnv('run-task') === undefined) return
  const taskId = positionals[0] as string
  const maxSteps =
    typeof flags['max-steps'] === 'number'
      ? flags['max-steps']
      : typeof flags['max-steps'] === 'string'
        ? Number(flags['max-steps'])
        : 30
  const ci = parseCiMode(typeof flags.ci === 'string' ? flags.ci : 'passed')
  if (!ci.ok) {
    console.error(`run-task: ${ci.error.detail}`)
    process.exitCode = 1
    return
  }
  const harness = resolveHarness(flags.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) {
    console.error(`run-task: ${harness.error.detail}`)
    process.exitCode = 1
    return
  }
  // 只把**显式** --model / KEEL_MODEL 传给 runTask；omp 缺省由模型路由补齐
  const model = resolveOptionalModel(flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`run-task: ${model.error.detail}`)
    process.exitCode = 1
    return
  }
  const wallClock = parseWallClock(flags['wall-clock'])
  if (!wallClock.ok) {
    console.error(`run-task: ${wallClock.error.detail}`)
    process.exitCode = 1
    return
  }
  if (wallClock.value !== undefined) warnWallClockOverride('run-task', wallClock.value, mode)

  const run = deps.runTask ?? runTask
  const result = await run(taskId, {
    maxSteps,
    ci: ci.value,
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(wallClock.value === undefined ? {} : { wallClockS: wallClock.value }),
  })
  if (!result.ok) {
    console.error(`run-task: ${result.error.detail}`)
    process.exitCode = 1
    return
  }
  printRunResult(result.value)
  if (result.value.finalStatus !== 'S-DONE') {
    await printNonDoneReport(taskId, result.value.finalStatus)
  }
}
