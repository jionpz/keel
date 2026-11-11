/** JT-06 统一服务入口与无副作用健康检查。 */

import { WorkflowDriver } from '../control/driver/driver.js'
import { LivenessStore } from '../control/liveness/store.js'
import type { ManagedTicketWorker } from '../control/managed/ticket-runtime.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import {
  createChecksComponent,
  createMaintenanceComponent,
  createManagedComponent,
  createMemoryComponent,
  createOutboxComponent,
} from '../control/service/components.js'
import {
  assertServiceSchema,
  readServiceStatus,
  tryRecordServiceHealth,
} from '../control/service/health.js'
import {
  runService,
  type ServiceComponent,
  type ServiceSignalSource,
  serviceReasonCode,
} from '../control/service/runtime.js'
import { createIsolatedManagedInference } from '../execution/isolated-ticket-worker.js'
import { closePool } from '../fact/db.js'
import { GitCliPushGateway } from '../fact/git-push.js'
import { GitHubProvider } from '../fact/github-provider.js'
import type { ResidentLock, ResidentRole } from '../fact/resident-lock.js'
import { acquireResidentLock, lockErrorMessage } from '../fact/resident-lock.js'
import { type PollerSignalSource, runPollerForever } from '../ingress/poller.js'
import { parseArgs } from './argv.js'
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'
import { createManagedTicketWorker } from './managed.js'
import { buildPollerRuntime } from './poller.js'
import {
  type CiMode,
  type HarnessId,
  parseCiMode,
  parseWallClock,
  resolveHarness,
  resolveOptionalModel,
} from './run-task.js'

type FlagValue = string | number | boolean

const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_CHECK_TIMEOUT_MS = 30 * 60_000

function optionalString(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} 需要非空值`)
  return value.trim()
}

function positiveInteger(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
  fallback: number,
): number {
  const value = flags[name]
  if (value === undefined) return fallback
  const raw = typeof value === 'number' ? String(value) : value
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new Error(`--${name} 必须是正整数`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} 必须是安全范围内的正整数`)
  return parsed
}

function noPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(' ')}`)
}

function ciMode(flags: Readonly<Record<string, FlagValue>>): CiMode {
  const raw = optionalString(flags, 'ci')
  const result = parseCiMode(raw ?? 'real')
  if (!result.ok) throw new Error(result.error.detail)
  return result.value
}

export interface ServiceMainDeps {
  readonly acquireLock?: (role: ResidentRole) => Promise<ResidentLock | null>
  readonly signals?: ServiceSignalSource
  readonly now?: () => string
  readonly components?: readonly ServiceComponent[]
  readonly worker?: ManagedTicketWorker
  readonly closePool?: () => Promise<void>
}

export const SERVICE_HELP = `用法: keel serve [选项]

统一常驻服务：决策/天问、ticket 与 workflow 执行、项目摘要草稿、timer/巡检、
受控 action outbox 和 required checks。SIGTERM/SIGINT 停止新认领，等待当前动作
到达安全边界后退出。

选项:
  --harness omp|claude|pi   缺省读取 KEEL_HARNESS；启动时预检可执行文件
  --model <id>              缺省读取 KEEL_MODEL
  --no-ingress              不运行 GitHub issue 接入 poller（默认运行）
  --ci passed|failed|real   ingress 使用的 CI 模式，缺省 real
  --concurrency <n>         ingress 在途驱动上限，缺省 3
  --ingress-interval <ms>   ingress 扫描间隔，缺省 60000
  --managed-interval <ms>   managed 空闲轮询间隔，缺省 1000
  --outbox-interval <ms>    outbox 空闲轮询间隔，缺省 2000
  --checks-interval <ms>    required checks 轮询间隔，缺省 10000
  --maintenance-interval <ms> timer/巡检间隔，缺省 5000
  --memory-interval <ms>    摘要草稿扫描间隔，缺省 30000
  --heartbeat-ms <ms>       角色心跳最长间隔，缺省 10000
  --wall-clock <秒>         --ingress 的 legacy stage 墙钟覆盖
  --help, -h

说明:
  ingress 仍驱动 legacy-v01 issue 任务；--no-ingress 时只管理已持久化的 managed 工作。
  摘要组件只生成 DRAFT，发布/回滚仍需 owner 显式命令。
  同一数据库只允许一个 serve；启用 ingress 时还会与独立 poller 互斥。`

function buildDefaultComponents(options: {
  readonly worker: ManagedTicketWorker
  readonly harness: HarnessId
  readonly model?: string
  readonly now: () => string
  readonly liveness: LivenessStore
  readonly intervals: {
    readonly managed: number
    readonly outbox: number
    readonly checks: number
    readonly maintenance: number
    readonly memory: number
  }
  readonly ingress?: {
    readonly intervalMs: number
    readonly concurrency: number
    readonly deps: Awaited<ReturnType<typeof buildPollerRuntime>>['deps']
  }
}): readonly ServiceComponent[] {
  const provider = new GitHubProvider()
  const ttl = resolveHumanReviewTtlMs(process.env.KEEL_HUMAN_REVIEW_TTL_H)
  if (!ttl.ok) throw new Error(ttl.error.detail)
  const components: ServiceComponent[] = [
    {
      ...createManagedComponent({
        worker: options.worker,
        infer: createIsolatedManagedInference(options.harness, options.model),
      }),
      intervalMs: options.intervals.managed,
    },
    {
      ...createMemoryComponent(),
      intervalMs: options.intervals.memory,
    },
    {
      ...createMaintenanceComponent({
        workerDeps: {
          driver: new WorkflowDriver(
            new RuleBasedPolicyEngine(DEFAULT_RULESET),
            undefined,
            undefined,
            ttl.value,
          ),
          now: options.now,
          store: options.liveness,
          humanReviewTtlMs: ttl.value,
        },
      }),
      intervalMs: options.intervals.maintenance,
    },
    {
      ...createOutboxComponent({
        deps: {
          push: new GitCliPushGateway(),
          pullRequests: provider,
          checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
        },
        intervalMs: options.intervals.outbox,
      }),
    },
    {
      ...createChecksComponent({
        deps: { checks: provider, pollIntervalMs: options.intervals.checks },
        intervalMs: options.intervals.checks,
      }),
    },
  ]

  if (options.ingress !== undefined) {
    const noSignals: PollerSignalSource = { on: () => undefined, off: () => undefined }
    const ingress = options.ingress
    components.push({
      name: 'ingress',
      intervalMs: ingress.intervalMs,
      run: (context) =>
        runPollerForever(ingress.deps, {
          intervalMs: ingress.intervalMs,
          concurrency: ingress.concurrency,
          signals: noSignals,
          stopToken: context.stop,
        }),
    })
  }
  return components
}

async function acquireLockOrThrow(
  role: ResidentRole,
  acquire: (role: ResidentRole) => Promise<ResidentLock | null>,
): Promise<ResidentLock> {
  let lock: ResidentLock | null
  try {
    lock = await acquire(role)
  } catch (error) {
    throw new Error(`无法获取 ${role} 单实例锁：${lockErrorMessage(error)}`)
  }
  if (lock === null) throw new Error(`已有 ${role} 实例在运行（同一数据库）`)
  return lock
}

/** 处理 `serve`；预检失败会写 BLOCKED 健康行并返回非零退出码。 */
export async function serveMain(
  argv: readonly string[],
  deps: ServiceMainDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const locks: ResidentLock[] = []
  let liveness: LivenessStore | undefined
  try {
    const { positionals, flags } = parseArgs(argv)
    if (flags.help === true) {
      console.log(SERVICE_HELP)
      return
    }
    noPositionals(positionals)
    const allowed = new Set([
      'harness',
      'model',
      'ingress',
      'no-ingress',
      'ci',
      'concurrency',
      'ingress-interval',
      'managed-interval',
      'outbox-interval',
      'checks-interval',
      'maintenance-interval',
      'memory-interval',
      'heartbeat-ms',
      'wall-clock',
    ])
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) throw new Error(`未知选项：--${key}`)
    }

    const harness = resolveHarness(optionalString(flags, 'harness'), process.env.KEEL_HARNESS)
    if (!harness.ok) throw new Error(harness.error.detail)
    const model = resolveOptionalModel(optionalString(flags, 'model'), process.env.KEEL_MODEL)
    if (!model.ok) throw new Error(model.error.detail)
    if (flags.ingress === true && flags['no-ingress'] === true)
      throw new Error('--ingress 与 --no-ingress 不能同时使用')
    // 单一服务入口默认覆盖接入；--no-ingress 仅用于明确只处理已持久化 managed 工作。
    const withIngress = flags['no-ingress'] !== true
    const ci = ciMode(flags)
    const concurrency = positiveInteger(flags, 'concurrency', 3)
    if (concurrency > 3) throw new Error('--concurrency 不能超过全局 RUNNING 上限 3')
    const ingressInterval = positiveInteger(flags, 'ingress-interval', 60_000)
    const wallClock = parseWallClock(flags['wall-clock'])
    if (!wallClock.ok) throw new Error(wallClock.error.detail)

    const acquire = deps.acquireLock ?? acquireResidentLock
    locks.push(await acquireLockOrThrow('keel-service', acquire))
    locks.push(await acquireLockOrThrow('timer-worker', acquire))
    if (withIngress) locks.push(await acquireLockOrThrow('poller', acquire))

    await assertServiceSchema()
    const worker =
      deps.worker ??
      (await createManagedTicketWorker({
        harness: harness.value,
        ...(model.value === undefined ? {} : { model: model.value }),
      }))

    let ingressDeps: Awaited<ReturnType<typeof buildPollerRuntime>>['deps'] | undefined
    if (withIngress) {
      const built = await buildPollerRuntime({
        ci,
        harness: harness.value,
        ...(model.value === undefined ? {} : { model: model.value }),
        ...(wallClock.value === undefined ? {} : { wallClockS: wallClock.value }),
        now,
      })
      if (built.missingHosts.length > 0) {
        const error = new Error(
          `GitHub 凭据缺失（${built.missingHosts.join(', ')}）；ingress 未认领任何 issue`,
        )
        await tryRecordServiceHealth({
          component: 'ingress',
          status: 'BLOCKED',
          now: now(),
          reasonCode: 'AUTH_FAILED',
          detail: error.message,
          checkpoint: { missing_hosts: built.missingHosts },
        })
        throw error
      }
      ingressDeps = built.deps
    }

    let components = deps.components
    if (components === undefined) {
      liveness = new LivenessStore()
      components = buildDefaultComponents({
        worker,
        harness: harness.value,
        ...(model.value === undefined ? {} : { model: model.value }),
        now,
        liveness,
        intervals: {
          managed: positiveInteger(flags, 'managed-interval', 1_000),
          outbox: positiveInteger(flags, 'outbox-interval', 2_000),
          checks: positiveInteger(flags, 'checks-interval', 10_000),
          maintenance: positiveInteger(flags, 'maintenance-interval', 5_000),
          memory: positiveInteger(flags, 'memory-interval', 30_000),
        },
        ...(ingressDeps === undefined
          ? {}
          : { ingress: { intervalMs: ingressInterval, concurrency, deps: ingressDeps } }),
      })
    }

    await runService({
      components,
      ...(deps.signals === undefined ? {} : { signals: deps.signals }),
      now,
      heartbeatMs: positiveInteger(flags, 'heartbeat-ms', DEFAULT_HEARTBEAT_MS),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await tryRecordServiceHealth({
      component: 'service',
      status: 'BLOCKED',
      now: now(),
      reasonCode: serviceReasonCode(error),
      detail,
      checkpoint: { startup_failed: true },
    })
    console.error(`serve: ${detail}`)
    process.exitCode = 1
  } finally {
    if (liveness !== undefined) await liveness.close().catch(() => undefined)
    for (const lock of locks.reverse()) await lock.release().catch(() => undefined)
    await (deps.closePool ?? closePool)().catch(() => undefined)
  }
}

function staleAfter(flags: Readonly<Record<string, FlagValue>>): number {
  return positiveInteger(flags, 'stale-ms', 30_000)
}

export async function serviceStatusMain(argv: readonly string[]): Promise<void> {
  try {
    const { positionals, flags } = parseArgs(argv)
    if (flags.help === true) {
      console.log(`用法: keel service-status [--stale-ms <ms>]

只读输出角色心跳、队列积压、待答问题、outbox 与 dead-letter 计数。`)
      return
    }
    noPositionals(positionals)
    if (Object.keys(flags).some((key) => key !== 'stale-ms'))
      throw new Error('service-status 只接受 --stale-ms')
    console.log(
      JSON.stringify(await readServiceStatus({ staleAfterMs: staleAfter(flags) }), null, 2),
    )
  } catch (error) {
    console.error(`service-status: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export async function serviceHealthMain(argv: readonly string[]): Promise<void> {
  try {
    const { positionals, flags } = parseArgs(argv)
    if (flags.help === true) {
      console.log(`用法: keel service-health [--stale-ms <ms>] [--json]

只读健康检查；不认领、不调用模型、不访问 GitHub。任一必需角色缺失/陈旧/降级，
或存在 dead-letter/uncertain action 时，退出码为 1。`)
      return
    }
    noPositionals(positionals)
    if (Object.keys(flags).some((key) => !['stale-ms', 'json'].includes(key)))
      throw new Error('service-health 只接受 --stale-ms 和 --json')
    const status = await readServiceStatus({ staleAfterMs: staleAfter(flags) })
    if (flags.json === true) {
      console.log(JSON.stringify(status, null, 2))
    } else {
      console.log(
        `keel service: ${status.state} components=${status.components.length}/${status.components.length + status.missing_components.length} ` +
          `tickets=${status.pending.tickets} workflows=${status.pending.workflows} ` +
          `questions=${status.pending.questions} outbox=${status.pending.outbox}`,
      )
    }
    if (!status.ok) process.exitCode = 1
  } catch (error) {
    console.error(`service-health: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
