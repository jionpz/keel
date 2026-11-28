import { type SpawnOptions, spawn } from 'node:child_process'
import { makeError } from '../contracts/errors.js'
import type { HarnessAdapter, HarnessDescriptor } from '../contracts/harness-adapter.js'
import type {
  ManagedInference,
  ManagedTicketDecisionRunner,
  ManagedTicketStageRunner,
  ManagedWorkflowPlanRunner,
} from '../contracts/managed.js'
import { ZERO_USAGE } from '../contracts/types.js'
import type { ManagedTicketWorker } from '../control/managed/ticket-runtime.js'
import { MANAGED_STAGE_TIMEOUT_MS } from '../shared/managed-limits.js'
import { ClaudeCodeAdapter } from './adapters/claude-code.js'
import { OmpAdapter } from './adapters/omp.js'
import { PI_SUBAGENT_TOOLS, PiAdapter } from './adapters/pi.js'
import {
  type ManagedExecutorEnv,
  type ManagedHarness,
  prepareManagedExecutorEnv,
} from './isolation/managed-env.js'
import { supervisedSandboxCommand } from './isolation/process-supervisor.js'
import { managedInference } from './managed-inference.js'
import {
  configuredStageTimeoutS,
  type ModelRole,
  type ModelRoutingSettings,
  type ModelStage,
  type ResolvedModelRoute,
  resolveModelRoute,
  TIMEOUT_STAGES,
} from './model-routing.js'
import {
  roleForTicketRole,
  type StageTimeoutMs,
  ticketWorkerFromAdapter,
} from './ticket-stage-runner.js'

export interface IsolatedTicketWorkerOptions {
  readonly harness: ManagedHarness
  /** 显式 `--model` / `KEEL_MODEL` 覆盖 */
  readonly model?: string
  readonly routing: ModelRoutingSettings
  /** 用宿主环境构造的探针 descriptor，只取 harness 名与工具清单。 */
  readonly descriptor: HarnessDescriptor
}

/**
 * 各阶段的墙钟上限：profile 里写了 `timeout_s` 就用它，否则用 managed 的缺省上限。
 * 部署配置只从这里进入执行面，计时器、交给 Harness 的上限和租约都由它派生。
 */
export function stageTimeoutsFor(
  routing: ModelRoutingSettings,
  harness: ManagedHarness,
): StageTimeoutMs {
  return (stage) => {
    const configured = configuredStageTimeoutS(routing, harness, stage)
    return configured === undefined ? MANAGED_STAGE_TIMEOUT_MS : configured * 1000
  }
}

/**
 * managed 写执行 worker：每个 stage attempt 和每次天问调用都新建独立
 * HOME/TMPDIR，并让 adapter 用显式 allowlist env 启动子进程。
 *
 * 这里刻意不复用长生命周期 adapter：复用会把某个 attempt 的 HOME/会话状态
 * 带进下一次 attempt，隔离边界就不再是“每次执行”。
 */
export function createIsolatedTicketWorker(
  options: IsolatedTicketWorkerOptions,
): ManagedTicketWorker & {
  readonly decide: ManagedTicketDecisionRunner
  readonly plan: ManagedWorkflowPlanRunner
} {
  const harness =
    options.descriptor.harness_id === 'claude' ? 'claude-code' : options.descriptor.harness_id
  const routeFor = (stage: ModelStage, role: ModelRole): ReturnType<typeof resolveModelRoute> =>
    resolveModelRoute({
      harness: options.harness,
      stage,
      role,
      ...(options.model === undefined ? {} : { override: options.model }),
      routing: options.routing,
    })
  const stageTimeoutMs = stageTimeoutsFor(options.routing, options.harness)
  const workerFor = (adapter: HarnessAdapter) => ticketWorkerFromAdapter(adapter, stageTimeoutMs)
  const run: ManagedTicketStageRunner = async (input) => {
    try {
      const route = routeFor(input.stage, roleForTicketRole(input.tool_plan.role))
      if (!route.ok) return { ok: false, error: route.error, usage: ZERO_USAGE }
      return await withIsolatedAdapter(options, route.value, input.workspace_path, (adapter) =>
        workerFor(adapter).run(input),
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
  const decide: ManagedTicketDecisionRunner = async (input) => {
    try {
      const route = routeFor('tianwen', 'Tianwen')
      if (!route.ok) return { ok: false, error: route.error, usage: ZERO_USAGE }
      return await withIsolatedAdapter(
        options,
        route.value,
        input.workspace_path,
        (adapter) => workerFor(adapter).decide(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
  const plan: ManagedWorkflowPlanRunner = async (input) => {
    try {
      const route = routeFor('plan', 'Architect')
      if (!route.ok) return { ok: false, error: route.error, usage: ZERO_USAGE }
      return await withIsolatedAdapter(
        options,
        route.value,
        input.workspace_path,
        (adapter) => workerFor(adapter).plan(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }

  return {
    harness,
    toolInventory: options.descriptor.tool_inventory ?? [],
    verifyTimeoutMs: stageTimeoutMs('verify'),
    // 天问固定用缺省上限，所以最长的一次运行不会短于它。
    maxRunMs: Math.max(MANAGED_STAGE_TIMEOUT_MS, ...TIMEOUT_STAGES.map(stageTimeoutMs)),
    run,
    decide,
    plan,
  }
}

/** managed 只读调查也走同一隔离边界：每次推理一个独立 HOME/TMPDIR。 */
export interface ManagedInferenceSelection {
  readonly model?: string
  readonly routing: ModelRoutingSettings
}

export function createIsolatedManagedInference(
  harness: ManagedHarness,
  selection: ManagedInferenceSelection,
): ManagedInference {
  return async (input) => {
    try {
      const route = resolveModelRoute({
        harness,
        stage: input.phase === 'tianwen' ? 'tianwen' : 'managed_investigate',
        role: input.phase === 'tianwen' ? 'Tianwen' : 'Investigator',
        ...(selection.model === undefined ? {} : { override: selection.model }),
        routing: selection.routing,
      })
      if (!route.ok) return { ok: false, error: route.error, usage: ZERO_USAGE }
      return await withIsolatedAdapter(
        { harness },
        route.value,
        input.workspace_path,
        (adapter) => managedInference(adapter)(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
}

function managedEnvError(error: unknown) {
  return makeError(
    'CAPABILITY_UNSUPPORTED',
    `无法建立 managed 隔离执行环境：${error instanceof Error ? error.message : String(error)}`,
  )
}

async function withIsolatedAdapter<T>(
  options: { readonly harness: ManagedHarness },
  route: ResolvedModelRoute,
  workspace: string,
  action: (adapter: HarnessAdapter) => Promise<T>,
  readOnlyWorkspace = false,
): Promise<T> {
  const prepared = await prepareManagedExecutorEnv({
    harness: options.harness,
    workspace,
    readOnlyWorkspace,
    ...(route.model === undefined ? {} : { model: route.model }),
  })
  if (!prepared.ok) throw prepared.error
  let cleanupFailed = false
  try {
    const result = await action(
      adapterFor(options.harness, route, prepared.value, () => {
        cleanupFailed = true
      }),
    )
    if (cleanupFailed)
      throw new Error(`managed supervisor 未确认回收，执行现场保留在 ${prepared.value.root}`)
    return result
  } finally {
    if (!cleanupFailed) await prepared.value.dispose()
  }
}

export function adapterFor(
  harness: ManagedHarness,
  route: ResolvedModelRoute,
  env: ManagedExecutorEnv,
  onSupervisorFailure?: () => void,
): HarnessAdapter {
  const spawnFn = sandboxedSpawn(env, onSupervisorFailure)
  const spawnOption = spawnFn === undefined ? {} : { spawnFn }
  if (route.thinking !== undefined && harness !== 'pi') {
    throw new Error(`${harness} 不支持 thinking 覆盖`)
  }
  switch (harness) {
    case 'pi':
      return env.piExtensions.length === 0
        ? new PiAdapter({
            ...(route.model === undefined ? {} : { model: route.model }),
            ...(route.thinking === undefined ? {} : { thinking: route.thinking }),
            env: env.env,
            autoSubagents: false,
            ...spawnOption,
          })
        : new PiAdapter({
            ...(route.model === undefined ? {} : { model: route.model }),
            ...(route.thinking === undefined ? {} : { thinking: route.thinking }),
            env: env.env,
            extensions: env.piExtensions,
            trustedTools: PI_SUBAGENT_TOOLS,
            ...spawnOption,
          })
    case 'claude':
      return new ClaudeCodeAdapter({
        ...(route.model === undefined ? {} : { model: route.model }),
        env: env.env,
        ...spawnOption,
      })
    case 'omp':
      return new OmpAdapter({
        ...(route.model === undefined ? {} : { model: route.model }),
        env: env.env,
        ...spawnOption,
      })
  }
}

function sandboxedSpawn(
  env: ManagedExecutorEnv,
  onSupervisorFailure?: () => void,
): typeof spawn | undefined {
  const sandbox = env.sandbox
  if (sandbox === undefined) return undefined
  return ((bin: string, args: string[], options: SpawnOptions) => {
    const command = supervisedSandboxCommand(sandbox, bin, args)
    // 宿主持有 stdin 写端；正常结束、暂停、超时和宿主退出共用 supervisor 回收。
    const child = spawn(command.command, [...command.args], {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.once('exit', (code, signal) => {
      if (code === 125 || signal !== null) onSupervisorFailure?.()
    })
    child.once('error', () => onSupervisorFailure?.())
    return child
  }) as typeof spawn
}
