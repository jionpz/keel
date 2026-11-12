/**
 * JT-07 readiness / support matrix.
 *
 * 只做本地探测：不调用模型、不访问 GitHub、不认领队列。把“二进制存在”、
 * “凭据可能可用”、“真实生产验收已完成”分开报告，避免把单测或兼容烟测
 * 冒充 Harness 生产支持。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '../contracts/errors.js'
import type { TrialEvaluation } from '../control/trial.js'
import { readTrialStatus } from '../control/trial-store.js'
import { CLAUDE_CAPABILITIES } from '../execution/adapters/claude-code.js'
import { DEFAULT_OMP_MODEL, OMP_CAPABILITIES } from '../execution/adapters/omp.js'
import { PI_CAPABILITIES } from '../execution/adapters/pi.js'
import { tierOf } from '../execution/adapters/tier.js'
import { selectManagedPiModel } from '../execution/isolation/managed-env.js'
import { DEFAULT_SANDBOX_EXEC, type OsSandboxBackend } from '../execution/isolation/os-sandbox.js'
import { asRole } from '../fact/db.js'
import { resolveGitHubToken } from '../fact/github-auth.js'
import type { CapabilityId, HarnessTier } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { type HarnessId, resolveHarness } from './run-task.js'

type CommandOutcome = { readonly ok: boolean; readonly output: string }
type CredentialStatus = 'ready' | 'missing' | 'unknown'
type Verification = 'native-live' | 'compat-live' | 'deterministic-only'
export type DoctorScope = 'full' | 'ticket'

export interface HarnessReadiness {
  readonly id: HarnessId
  readonly binary: string
  readonly available: boolean
  readonly version: string | null
  readonly tier: HarnessTier
  readonly capabilities: readonly CapabilityId[]
  readonly credentials: {
    readonly status: CredentialStatus
    readonly method: string
  }
  readonly verification: Verification
  readonly evidence: string
  readonly limits: readonly string[]
}

export interface DoctorDatabase {
  readonly status: 'ready' | 'partial' | 'unavailable'
  readonly worker_health_ready: boolean
  readonly trial_schema_ready: boolean
  readonly detail: string | null
}

export interface DoctorReport {
  readonly format: 'keel-doctor/v1'
  readonly observed_at: string
  readonly scope: DoctorScope
  readonly environment: {
    readonly platform: NodeJS.Platform
    readonly arch: string
    readonly node: string
    readonly git: boolean
    readonly pg_dump: boolean
  }
  readonly selected_harness: HarnessId
  readonly ok: boolean
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
  readonly database: DoctorDatabase
  readonly github: {
    readonly host: string
    readonly credential: 'available' | 'missing'
  }
  readonly managed_read: {
    readonly supported: boolean
    readonly detail: string
  }
  readonly managed_write: {
    readonly supported: boolean
    readonly backend: OsSandboxBackend | null
    readonly detail: string
  }
  readonly harnesses: readonly HarnessReadiness[]
  readonly trial: TrialEvaluation | null
}

export interface DoctorDeps {
  readonly run?: (bin: string, args: readonly string[]) => CommandOutcome
  readonly database?: () => Promise<DoctorDatabase>
  readonly githubToken?: (host: string) => Promise<string | undefined>
  readonly trial?: (now: string) => Promise<Result<TrialEvaluation>>
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly nodeVersion?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => string
  readonly piModels?: () => unknown
}

interface HarnessSpec {
  readonly id: HarnessId
  readonly bin: string
  readonly capabilities: readonly CapabilityId[]
  readonly verification: Verification
  readonly evidence: string
  readonly limits: readonly string[]
}

const SPECS: readonly HarnessSpec[] = [
  {
    id: 'omp',
    bin: 'omp',
    capabilities: OMP_CAPABILITIES,
    verification: 'native-live',
    evidence:
      'JT-01 Linux 原生 OMP 真实模型烟测、SIGKILL 恢复与工具负例；见 #86 与 implementation.md。',
    limits: [
      'managed 受控文件读取只在 Linux /proc/self/fd 下启用。',
      '模型凭据只能由适配器能力与本地配置间接判断，doctor 不读取 token。',
    ],
  },
  {
    id: 'pi',
    bin: 'pi',
    capabilities: PI_CAPABILITIES,
    verification: 'compat-live',
    evidence: 'JT-01 Pi 兼容 runner 真实烟测已通过；原生 Pi managed 写执行仍需在目标环境单独验收。',
    limits: [
      '不声明 CAP-RESUME 与 CAP-STRUCTURED_OUTPUT。',
      'headless 没有逐次审批通道；manual 模式明确拒绝。',
    ],
  },
  {
    id: 'claude',
    bin: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    verification: 'deterministic-only',
    evidence:
      'Claude Code adapter 的契约、事件解析与 spawn 门禁有确定性测试；原生 managed 真实 E2E 尚未完成。',
    limits: [
      '未声明 CAP-STRUCTURED_OUTPUT；输出走 post_validate。',
      '--bare 不读 OAuth/系统钥匙串，需要环境凭据或 Claude 自身配置登录态。',
    ],
  },
]

const HARNESS_LABEL: Readonly<Record<HarnessId, string>> = {
  omp: 'OMP',
  pi: 'Pi',
  claude: 'Claude Code',
}

function defaultRun(bin: string, args: readonly string[]): CommandOutcome {
  try {
    const output = execFileSync(bin, [...args], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    })
    return { ok: true, output: String(output) }
  } catch (error) {
    const output =
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof error.stdout === 'string'
        ? error.stdout
        : ''
    return { ok: false, output }
  }
}

function cleanVersion(raw: string): string | null {
  const line = raw
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value !== '')
  return line === undefined ? null : line.slice(0, 160)
}

function credentialFromEnv(env: NodeJS.ProcessEnv): CredentialStatus {
  return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].some(
    (value) => value !== undefined && value.trim() !== '',
  )
    ? 'ready'
    : 'unknown'
}

function claudeCredentials(
  deps: DoctorDeps,
  run: (bin: string, args: readonly string[]) => CommandOutcome,
): HarnessReadiness['credentials'] {
  const envStatus = credentialFromEnv(deps.env ?? process.env)
  if (envStatus === 'ready')
    return { status: 'ready', method: 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN' }
  const result = run('claude', ['auth', 'status', '--json'])
  if (!result.ok) return { status: 'unknown', method: 'claude auth status 不可判定' }
  try {
    const parsed = JSON.parse(result.output) as { loggedIn?: unknown }
    return parsed.loggedIn === true
      ? { status: 'ready', method: 'claude auth status' }
      : { status: 'missing', method: 'claude auth status' }
  } catch {
    return { status: 'unknown', method: 'claude auth status 输出不可解析' }
  }
}

function piCredentials(
  run: (bin: string, args: readonly string[]) => CommandOutcome,
  model: string,
  deps: DoctorDeps,
): HarnessReadiness['credentials'] {
  let provider: string
  try {
    const models =
      deps.piModels?.() ??
      JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'))
    provider = selectManagedPiModel(models, model).name
  } catch {
    return { status: 'missing', method: 'Pi managed 模型配置不可用；未探测凭据' }
  }
  const result = run('pi', [
    'auth',
    'check',
    '--provider',
    provider,
    '--model',
    model,
    '--json',
    '--no-refresh',
  ])
  try {
    const parsed = JSON.parse(result.output) as { status?: unknown }
    if (parsed.status === 'ready') return { status: 'ready', method: `pi auth check ${provider}` }
    if (parsed.status === 'not_ready' || parsed.status === 'invalid')
      return { status: 'missing', method: `pi auth check ${provider}` }
  } catch {
    // fall through
  }
  return { status: 'unknown', method: `pi auth check ${provider} 不可判定` }
}

function ompCredentials(
  run: (bin: string, args: readonly string[]) => CommandOutcome,
  model: string,
): HarnessReadiness['credentials'] {
  const result = run('omp', ['models', '--json'])
  if (!result.ok) return { status: 'unknown', method: 'OMP 模型目录不可读取' }
  try {
    const parsed = JSON.parse(result.output) as { models?: readonly { selector?: unknown }[] }
    const found = parsed.models?.some((entry) => entry.selector === model) === true
    return {
      status: found ? 'unknown' : 'missing',
      method: found
        ? `OMP 模型目录含 ${model}；凭据未读取`
        : `OMP 模型目录不含 ${model}；未读取凭据`,
    }
  } catch {
    return { status: 'unknown', method: 'OMP 模型目录输出不可解析' }
  }
}

function probeHarness(spec: HarnessSpec, deps: DoctorDeps, model: string): HarnessReadiness {
  const run = deps.run ?? defaultRun
  const versionResult = run(spec.bin, ['--version'])
  const version = versionResult.ok ? cleanVersion(versionResult.output) : null
  const available = versionResult.ok && version !== null
  const credentials = !available
    ? { status: 'unknown' as const, method: '二进制不可用，未探测凭据' }
    : spec.id === 'claude'
      ? claudeCredentials(deps, run)
      : spec.id === 'pi'
        ? piCredentials(run, model, deps)
        : ompCredentials(run, model)
  return {
    id: spec.id,
    binary: spec.bin,
    available,
    version,
    tier: tierOf(spec.capabilities),
    capabilities: spec.capabilities,
    credentials,
    verification: spec.verification,
    evidence: spec.evidence,
    limits: spec.limits,
  }
}

function safeDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://***').slice(0, 1000)
}

function managedWriteReadiness(
  platform: NodeJS.Platform,
  run: (bin: string, args: readonly string[]) => CommandOutcome,
): DoctorReport['managed_write'] {
  if (platform !== 'darwin') {
    return {
      supported: false,
      backend: null,
      detail: `managed 写执行需要 macOS sandbox-exec；当前 ${platform} 尚未接入`,
    }
  }
  const probe = run(DEFAULT_SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'])
  if (!probe.ok) {
    return {
      supported: false,
      backend: null,
      detail: `无法启动 ${DEFAULT_SANDBOX_EXEC}；managed 写执行拒绝无沙箱运行`,
    }
  }
  return {
    supported: true,
    backend: 'macos-sandbox-exec',
    detail: 'macOS sandbox-exec 可启动；实际文件、网络与凭据边界仍需真实负例验证',
  }
}

async function defaultDatabase(): Promise<DoctorDatabase> {
  try {
    return await asRole('keel_control', async (c) => {
      await c.query(
        `SELECT status,reason_code,detail,checkpoint,instance_id,pid,started_at,last_success_at
         FROM worker_health LIMIT 0`,
      )
      const trial = await c.query<{ present: boolean }>(
        `SELECT to_regclass('public.managed_trial') IS NOT NULL AS present`,
      )
      const trialReady = trial.rows[0]?.present === true
      return {
        status: trialReady ? 'ready' : 'partial',
        worker_health_ready: true,
        trial_schema_ready: trialReady,
        detail: trialReady ? null : '缺少 JT-07 试运行迁移（managed_trial）',
      } as const
    })
  } catch (error) {
    return {
      status: 'unavailable',
      worker_health_ready: false,
      trial_schema_ready: false,
      detail: safeDetail(error),
    }
  }
}

function trialSummary(trial: TrialEvaluation | null, warnings: string[]): TrialEvaluation | null {
  if (trial === null) return null
  if (trial.state === 'NOT_STARTED') warnings.push('尚未开始 JT-07 真实试运行。')
  else if (trial.state === 'STOPPED') warnings.push('JT-07 试运行已停止；需要重新开始一轮。')
  else if (!trial.eligible_for_owner_review)
    warnings.push(
      `试运行尚未达到 owner 复核门槛：days=${trial.elapsed_days}/7 ` +
        `delegated=${trial.metrics.delegated_decisions}/30 ` +
        `completed=${trial.metrics.completed_tasks}/5。`,
    )
  return trial
}

export async function collectDoctorReport(
  selectedHarness: HarnessId,
  deps: DoctorDeps = {},
  scope: DoctorScope = 'full',
): Promise<DoctorReport> {
  const run = deps.run ?? defaultRun
  const now = deps.now ?? (() => new Date().toISOString())
  const observedAt = now()
  const model = (deps.env ?? process.env).KEEL_MODEL?.trim() || DEFAULT_OMP_MODEL
  const harnesses = SPECS.map((spec) => probeHarness(spec, deps, model))
  const selected = harnesses.find((harness) => harness.id === selectedHarness)
  if (selected === undefined) throw new Error(`未知 harness：${selectedHarness}`)
  const databaseRaw = await (deps.database ?? defaultDatabase)()
  const database: DoctorDatabase = {
    ...databaseRaw,
    detail: databaseRaw.detail === null ? null : safeDetail(databaseRaw.detail),
  }
  const githubToken = await (deps.githubToken ?? resolveGitHubToken)('github.com')
  const platform = deps.platform ?? process.platform
  const managedRead =
    platform === 'linux'
      ? { supported: true, detail: 'Linux /proc/self/fd 受控读取可用' }
      : {
          supported: false,
          detail: `managed 受控读取需要 Linux /proc/self/fd；当前 ${platform}`,
        }
  const managedWrite = managedWriteReadiness(platform, run)
  const blockers: string[] = []
  const warnings: string[] = []

  if (database.status !== 'ready')
    blockers.push(`数据库 schema 未就绪：${database.detail ?? database.status}`)
  if (!selected.available)
    blockers.push(`选定 Harness（${HARNESS_LABEL[selected.id]}）不可用：${selected.binary}`)
  if (selected.credentials.status === 'missing')
    blockers.push(
      `选定 Harness（${HARNESS_LABEL[selected.id]}）模型或凭据不可用：${selected.credentials.method}`,
    )
  if (selected.verification === 'deterministic-only')
    blockers.push(`选定 Harness（${HARNESS_LABEL[selected.id]}）尚未完成原生 live 验收`)
  if (scope === 'full' && !managedRead.supported)
    blockers.push(`managed_read：${managedRead.detail}`)
  if (!managedWrite.supported) blockers.push(`managed_write：${managedWrite.detail}`)
  if (platform !== 'linux')
    warnings.push(
      scope === 'full'
        ? '调查读取只支持 Linux，写沙箱只支持 macOS；当前没有完整范围就绪的平台。'
        : 'ticket 范围不覆盖 Linux-only 调查读取；调查能力仍报告不支持。',
    )
  if (githubToken === undefined) blockers.push('GitHub 凭据不可用，ingress 与 PR 网关会阻断')
  if (selected.credentials.status === 'unknown')
    warnings.push(`选定 Harness 凭据未验证：${selected.credentials.method}`)
  if (selected.id === 'claude')
    warnings.push('Claude Code 只有确定性契约证据，不应在支持矩阵标为生产已验证。')
  if (selected.id === 'pi') warnings.push('Pi 兼容烟测不等同原生 Pi managed 写执行验收。')
  if (run('pg_dump', ['--version']).ok === false) blockers.push('缺少 pg_dump，无法执行一致性备份')
  const git = run('git', ['--version']).ok
  if (!git) blockers.push('缺少 git，无法执行工作树与 PR 流程')

  let trial: TrialEvaluation | null = null
  if (database.status === 'ready') {
    const result = await (deps.trial ?? readTrialStatus)(observedAt)
    if (result.ok) trial = trialSummary(result.value, warnings)
    else warnings.push(`试运行状态不可读取：${result.error.detail}`)
  }
  return {
    format: 'keel-doctor/v1',
    observed_at: observedAt,
    scope,
    environment: {
      platform,
      arch: deps.arch ?? process.arch,
      node: deps.nodeVersion ?? process.version,
      git,
      pg_dump: run('pg_dump', ['--version']).ok,
    },
    selected_harness: selected.id,
    ok: blockers.length === 0,
    blockers,
    warnings,
    database,
    github: {
      host: 'github.com',
      credential: githubToken === undefined ? 'missing' : 'available',
    },
    managed_read: managedRead,
    managed_write: managedWrite,
    harnesses,
    trial,
  }
}

function printHuman(report: DoctorReport): void {
  console.log(
    `keel doctor: ${report.ok ? 'READY' : 'BLOCKED'} harness=${report.selected_harness} ` +
      `scope=${report.scope} platform=${report.environment.platform}/${report.environment.arch} ` +
      `database=${report.database.status} managed_read=${report.managed_read.supported} ` +
      `managed_write=${report.managed_write.supported}`,
  )
  for (const harness of report.harnesses) {
    console.log(
      `- ${harness.id}: ${harness.available ? (harness.version ?? 'available') : 'missing'} ` +
        `tier=${harness.tier} credentials=${harness.credentials.status} ` +
        `verification=${harness.verification}`,
    )
  }
  for (const blocker of report.blockers) console.log(`blocker: ${blocker}`)
  for (const warning of report.warnings) console.log(`warning: ${warning}`)
}

export async function doctorMain(argv: readonly string[], deps: DoctorDeps = {}): Promise<void> {
  try {
    const { positionals, flags } = parseArgs(argv)
    if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(' ')}`)
    if (flags.help === true) {
      console.log(`用法: keel doctor [--harness omp|claude|pi] [--scope full|ticket] [--json]

只读探测数据库 schema、Harness 二进制/凭据、GitHub 凭据、备份工具、
managed 平台能力与试运行门槛。--scope full（默认）同时要求调查读取与
ticket 写执行；--scope ticket 只要求写执行。不会调用模型、访问 GitHub 或认领队列。`)
      return
    }
    for (const key of Object.keys(flags)) {
      if (!['harness', 'scope', 'json'].includes(key)) throw new Error(`未知选项：--${key}`)
    }
    const harnessRaw = flags.harness
    if (harnessRaw !== undefined && typeof harnessRaw !== 'string')
      throw new Error('--harness 需要 omp|claude|pi')
    const selected = resolveHarness(harnessRaw, (deps.env ?? process.env).KEEL_HARNESS)
    if (!selected.ok) throw new Error(selected.error.detail)
    const scopeRaw = flags.scope
    if (scopeRaw !== undefined && scopeRaw !== 'full' && scopeRaw !== 'ticket')
      throw new Error('--scope 需要 full|ticket')
    const report = await collectDoctorReport(selected.value, deps, scopeRaw ?? 'full')
    if (flags.json === true) console.log(JSON.stringify(report, null, 2))
    else printHuman(report)
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    console.error(`doctor: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
