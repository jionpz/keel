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
import { ClaudeCodeAdapter } from './adapters/claude-code.js'
import { DEFAULT_OMP_MODEL, OmpAdapter } from './adapters/omp.js'
import { PI_SUBAGENT_TOOLS, PiAdapter } from './adapters/pi.js'
import {
  type ManagedExecutorEnv,
  type ManagedHarness,
  prepareManagedExecutorEnv,
} from './isolation/managed-env.js'
import { supervisedSandboxCommand } from './isolation/process-supervisor.js'
import { managedInference } from './managed-inference.js'
import { ticketWorkerFromAdapter } from './ticket-stage-runner.js'

export interface IsolatedTicketWorkerOptions {
  readonly harness: ManagedHarness
  readonly model?: string
  /** 用宿主环境构造的探针 descriptor，只取 harness 名与工具清单。 */
  readonly descriptor: HarnessDescriptor
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
): ManagedTicketWorker {
  const harness =
    options.descriptor.harness_id === 'claude' ? 'claude-code' : options.descriptor.harness_id
  const run: ManagedTicketStageRunner = async (input) => {
    try {
      return await withIsolatedAdapter(options, input.workspace_path, (adapter) =>
        ticketWorkerFromAdapter(adapter).run(input),
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
  const decide: ManagedTicketDecisionRunner = async (input) => {
    try {
      return await withIsolatedAdapter(
        options,
        input.workspace_path,
        (adapter) => ticketWorkerFromAdapter(adapter).decide(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
  const plan: ManagedWorkflowPlanRunner = async (input) => {
    try {
      return await withIsolatedAdapter(
        options,
        input.workspace_path,
        (adapter) => ticketWorkerFromAdapter(adapter).plan(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }

  return {
    harness,
    toolInventory: options.descriptor.tool_inventory ?? [],
    run,
    decide,
    plan,
  }
}

/** managed 只读调查也走同一隔离边界：每次推理一个独立 HOME/TMPDIR。 */
export function createIsolatedManagedInference(
  harness: ManagedHarness,
  model?: string,
): ManagedInference {
  return async (input) => {
    try {
      return await withIsolatedAdapter(
        { harness, descriptor: descriptorFor(harness), ...(model === undefined ? {} : { model }) },
        input.workspace_path,
        (adapter) => managedInference(adapter)(input),
        true,
      )
    } catch (error) {
      return { ok: false, error: managedEnvError(error), usage: ZERO_USAGE }
    }
  }
}

function descriptorFor(harness: ManagedHarness): HarnessDescriptor {
  switch (harness) {
    case 'pi':
      return new PiAdapter({ autoSubagents: false }).describe()
    case 'claude':
      return new ClaudeCodeAdapter().describe()
    case 'omp':
      return new OmpAdapter({ model: DEFAULT_OMP_MODEL }).describe()
  }
}

function managedEnvError(error: unknown) {
  return makeError(
    'CAPABILITY_UNSUPPORTED',
    `无法建立 managed 隔离执行环境：${error instanceof Error ? error.message : String(error)}`,
  )
}

async function withIsolatedAdapter<T>(
  options: IsolatedTicketWorkerOptions,
  workspace: string,
  action: (adapter: HarnessAdapter) => Promise<T>,
  readOnlyWorkspace = false,
): Promise<T> {
  const prepared = await prepareManagedExecutorEnv({
    harness: options.harness,
    workspace,
    readOnlyWorkspace,
    ...(options.model === undefined ? {} : { model: options.model }),
  })
  if (!prepared.ok) throw prepared.error
  let cleanupFailed = false
  try {
    const result = await action(
      adapterFor(options.harness, options.model, prepared.value, () => {
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
  model: string | undefined,
  env: ManagedExecutorEnv,
  onSupervisorFailure?: () => void,
): HarnessAdapter {
  const spawnFn = sandboxedSpawn(env, onSupervisorFailure)
  const spawnOption = spawnFn === undefined ? {} : { spawnFn }
  switch (harness) {
    case 'pi':
      return env.piExtensions.length === 0
        ? new PiAdapter({
            ...(model === undefined ? {} : { model }),
            env: env.env,
            autoSubagents: false,
            ...spawnOption,
          })
        : new PiAdapter({
            ...(model === undefined ? {} : { model }),
            env: env.env,
            extensions: env.piExtensions,
            trustedTools: PI_SUBAGENT_TOOLS,
            ...spawnOption,
          })
    case 'claude':
      return new ClaudeCodeAdapter({
        ...(model === undefined ? {} : { model }),
        env: env.env,
        ...spawnOption,
      })
    case 'omp':
      return new OmpAdapter({
        model: model ?? DEFAULT_OMP_MODEL,
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
