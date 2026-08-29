/**
 * keel run-task —— 驱动单 task 到终态(issue #27)。
 *
 * 组装 worktree workspace(临时 git 根 + ensureBareRepo from remote_url),
 * 接线 runTaskToCompletion,输出终态 + 转移轨迹。
 *
 * `--ci real` 接真实 GitHub(PR 网关 + CI 网关);缺省仍是 `passed`(模拟结果)——
 * 缺省值刻意不动:一个不带参数的 run-task 不应该悄悄打真实 API 建 PR。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { HarnessAdapter } from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion, type StepRecord } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { ClaudeCodeAdapter, requireClaudeReady } from '../execution/adapters/claude-code.js'
import { DEFAULT_OMP_MODEL, OmpAdapter } from '../execution/adapters/omp.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asRole } from '../fact/db.js'
import { GitWorkspace } from '../fact/git-workspace.js'
import { GitHubProvider, readTokenFromEnv } from '../fact/github-provider.js'
import type { TaskStatus } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { statusMain } from './status.js'

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

export interface RunTaskOptions {
  readonly maxSteps?: number
  readonly ci?: CiMode
  /** 单次 run 墙钟上限秒(默认 180)。验收/慢模型可抬高,不改全局默认。 */
  readonly wallClockS?: number
  /**
   * `--model` 原值。omp：省略则 KEEL_MODEL / 缺省 deepseek；
   * claude：省略则不传 `--model`。空白拒绝。
   */
  readonly model?: string | number | boolean
  /** `--harness` 原值。省略则 KEEL_HARNESS / 缺省 omp。 */
  readonly harness?: string | number | boolean
}

export interface RunTaskResult {
  readonly finalStatus: TaskStatus
  readonly steps: readonly StepRecord[]
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

  const gateway = resolveCiGateway(ci)
  if (!gateway.ok) return gateway

  const harness = resolveHarness(opts.harness, process.env.KEEL_HARNESS)
  if (!harness.ok) return harness

  if (harness.value === 'claude') {
    const ready = requireClaudeReady()
    if (!ready.ok) return ready
  }

  const model = resolveModelForHarness(harness.value, opts.model, process.env.KEEL_MODEL)
  if (!model.ok) return model

  // 读 task + repo(remote_url)。以 keel_control 身份读 —— asOwner 按 db.ts
  // 的纪律只留给测试装置与迁移,生产命令不该用属主权限读生产数据。
  const info = await asRole('keel_control', (c) =>
    c.query<{ repo_id: string; base_branch: string; remote_url: string }>(
      `SELECT t.repo_id, t.base_branch, r.remote_url
       FROM task t JOIN repo r ON r.id = t.repo_id WHERE t.id = $1`,
      [taskId],
    ),
  )
  const row = info.rows[0]
  if (row === undefined) {
    return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))
  }

  // 临时 git 根 → 从 remote 克隆裸仓库 → worktree binding
  const root = mkdtempSync(join(tmpdir(), 'keel-cli-'))
  const git = new GitWorkspace({ root })
  const bare = await git.ensureBareRepo(row.repo_id, row.remote_url)
  if (!bare.ok) return bare

  const binding = { git, repoId: row.repo_id, baseBranch: row.base_branch }
  const now = () => new Date().toISOString()

  const result = await runTaskToCompletion(
    taskId,
    {
      driver: new WorkflowDriver(
        new RuleBasedPolicyEngine(DEFAULT_RULESET),
        binding,
        gateway.value,
      ),
      sessions: new HarnessSessionManager(),
      adapter: createHarnessAdapter(harness.value, model.value),
      workspace: { mode: 'worktree', ...binding },
      now,
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
    prUrl: await readPrUrl(taskId),
  })
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

export function printRunResult(result: RunTaskResult): void {
  console.log(`finalStatus: ${result.finalStatus}`)
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

export async function runTaskMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel run-task <taskId> [--max-steps N] [--ci passed|failed|real] [--model <id>] [--harness omp|claude]

驱动单 task 到终态(真实 harness + worktree)。--ci 缺省 passed(模拟 CI 结果);
--ci real 接真实 GitHub PR / CI,需要 KEEL_GITHUB_TOKEN。
--harness 缺省 omp，也可设 KEEL_HARNESS；非法值拒绝（不静默回退）。
--model 对 omp 缺省 ${DEFAULT_OMP_MODEL}，也可设 KEEL_MODEL；空白值拒绝（不静默回退）。
claude 未指定 --model / KEEL_MODEL 时不传 --model（不把 omp 缺省塞给 claude）。`)
    return
  }
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
  const model = resolveModelForHarness(harness.value, flags.model, process.env.KEEL_MODEL)
  if (!model.ok) {
    console.error(`run-task: ${model.error.detail}`)
    process.exitCode = 1
    return
  }

  const result = await runTask(taskId, {
    maxSteps,
    ci: ci.value,
    harness: harness.value,
    ...(model.value === undefined ? {} : { model: model.value }),
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
