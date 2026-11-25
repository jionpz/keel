import { makeError, type Result, type ResultWithUsage } from '../contracts/errors.js'
import type {
  HarnessAdapter,
  RunHandle,
  RunHooks,
  RunResult,
  RunSpec,
} from '../contracts/harness-adapter.js'
import type {
  ManagedTicketDecisionRunner,
  ManagedTicketStageInput,
  ManagedTicketStageRunner,
  ManagedTicketToolPlan,
  ManagedWorkflowPlanRunner,
} from '../contracts/managed.js'
import { type Usage, ZERO_USAGE } from '../contracts/types.js'
import type {
  JstackRoutePlan,
  ManagedTicketStageResult,
  TianwenDecision,
} from '../generated/managed.js'
import type { RoleId } from '../shared/ids.js'
import { MANAGED_STAGE_CLEANUP_MS, MANAGED_STAGE_TIMEOUT_MS } from '../shared/managed-limits.js'
import type { TimeoutStage } from './model-routing.js'
import { extractJson } from './session/extract.js'
import { parseToolPolicy, resolveToolPolicy } from './tool-policy.js'

const ROLE_MAP: Readonly<Record<string, RoleId>> = {
  developer: 'Developer',
  verifier: 'QA',
  reviewer: 'Reviewer',
  releaser: 'Developer',
}

/** managed ticket 的 tool-policy role → RunRef.role；未知值按 Developer 解释。 */
export function roleForTicketRole(role: string): RoleId {
  return ROLE_MAP[role] ?? 'Developer'
}

const STAGE_MAP = {
  execute: 'develop',
  verify: 'qa',
  review: 'review',
  land: 'develop',
} as const

export interface ManagedTicketWorkerAdapter {
  readonly harness: string
  readonly toolInventory: readonly string[]
  readonly run: ManagedTicketStageRunner
  readonly decide: ManagedTicketDecisionRunner
  readonly plan: ManagedWorkflowPlanRunner
}

/** 各 managed 工作流阶段的墙钟上限（毫秒）。天问不在其中，固定用缺省上限。 */
export type StageTimeoutMs = (stage: TimeoutStage) => number

const defaultStageTimeoutMs: StageTimeoutMs = () => MANAGED_STAGE_TIMEOUT_MS

export async function awaitTicketResult(
  adapter: Pick<HarnessAdapter, 'awaitResult' | 'interrupt'>,
  handle: RunHandle,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Result<RunResult> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<null>((resolve) => {
    const interrupt = (reason: 'timeout' | 'cancelled') => {
      if (cleanupTimer !== undefined) return
      void adapter.interrupt(handle, reason).catch(() => undefined)
      cleanupTimer = setTimeout(() => resolve(null), MANAGED_STAGE_CLEANUP_MS)
    }
    timer = setTimeout(() => interrupt('timeout'), timeoutMs)
    onAbort = () => interrupt('cancelled')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
  try {
    return await Promise.race([adapter.awaitResult(handle), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 执行、决策和规划共用超时、usage 与释放语义。
 *
 * 计时器从 `spec.limits.wall_clock_s` 派生：交给 Harness 的上限和本进程
 * 强制中断的时刻是同一个数，不各算一次。
 */
async function runStructured<T>(
  adapter: HarnessAdapter,
  spec: RunSpec,
  label: string,
  hooks?: RunHooks,
  signal?: AbortSignal,
): Promise<ResultWithUsage<{ output: T; usage: Usage }>> {
  const started = await adapter.startRun(spec, hooks)
  if (!started.ok) return { ok: false, error: started.error, usage: ZERO_USAGE }
  try {
    const result = await awaitTicketResult(
      adapter,
      started.value,
      spec.limits.wall_clock_s * 1000,
      signal,
    )
    if (result === null)
      return {
        ok: false,
        error: makeError(
          signal?.aborted ? 'PROTOCOL_ERROR' : 'RUN_TIMEOUT',
          signal?.aborted ? `${label} 控制层已撤回执行` : `${label} wall clock`,
        ),
        usage: ZERO_USAGE,
      }
    if (!result.ok) return { ok: false, error: result.error, usage: ZERO_USAGE }
    if (result.value.status !== 'SUCCEEDED')
      return {
        ok: false,
        error: makeError(
          result.value.status === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'PROTOCOL_ERROR',
          `${label} ${result.value.status}`,
        ),
        usage: result.value.usage,
      }
    const parsed = extractJson(result.value.text ?? '')
    if (!parsed.ok)
      return {
        ok: false,
        error: makeError('PROTOCOL_ERROR', parsed.reason),
        usage: result.value.usage,
      }
    return { ok: true, value: { output: parsed.value as T, usage: result.value.usage } }
  } finally {
    await adapter.dispose(started.value)
  }
}

export function ticketWorkerFromAdapter(
  adapter: HarnessAdapter,
  stageTimeoutMs: StageTimeoutMs = defaultStageTimeoutMs,
): ManagedTicketWorkerAdapter {
  const descriptor = adapter.describe()
  const harness = descriptor.harness_id === 'claude' ? 'claude-code' : descriptor.harness_id
  const toolInventory = descriptor.tool_inventory ?? []
  const run: ManagedTicketStageRunner = (input: ManagedTicketStageInput) =>
    runStructured<ManagedTicketStageResult>(
      adapter,
      {
        run: {
          run_id: input.attempt_id,
          task_id: input.task_id,
          stage: STAGE_MAP[input.stage],
          role: roleForTicketRole(input.tool_plan.role),
          attempt: 1,
        },
        idempotency_key: input.attempt_id,
        workspace: {
          path: input.workspace_path,
          repo_id: input.repo_id,
          branch: 'managed-ticket',
          untrusted: true,
        },
        context: input.context,
        output_contract: { schema_ref: 'managed-ticket', mode: 'post_validate' },
        permissions: {
          allowed_tools: input.tool_plan.native_tools,
          mode: 'deny_unlisted',
        },
        limits: {
          wall_clock_s: stageTimeoutMs(input.stage) / 1000,
          budget_usd: null,
          max_turns: 40,
        },
      },
      'managed ticket stage',
      input.onProgress === undefined ? undefined : { onProgress: input.onProgress },
      input.signal,
    )
  const decide: ManagedTicketDecisionRunner = (input) =>
    runStructured<TianwenDecision>(
      adapter,
      {
        run: {
          run_id: input.attempt_id,
          task_id: input.task_id,
          stage: 'review',
          role: 'Reviewer',
          attempt: 1,
        },
        idempotency_key: input.attempt_id,
        workspace: {
          path: input.workspace_path,
          repo_id: input.repo_id,
          branch: 'managed-ticket',
          untrusted: true,
        },
        context: input.context,
        output_contract: { schema_ref: 'tianwen-decision', mode: 'post_validate' },
        permissions: {
          allowed_tools: [],
          mode: 'deny_unlisted',
        },
        limits: { wall_clock_s: MANAGED_STAGE_TIMEOUT_MS / 1000, budget_usd: null, max_turns: 20 },
      },
      'managed ticket tianwen',
    )
  const plan: ManagedWorkflowPlanRunner = async (input) => {
    const policy = parseToolPolicy(input.package.tool_policy)
    if (!policy.ok) return { ok: false, error: policy.error, usage: ZERO_USAGE }
    const resolved = resolveToolPolicy(policy.value, {
      stage: 'plan',
      harness,
      inventory: toolInventory,
      allowGrantedSearchFallback: true,
    })
    if (!resolved.ok) return { ok: false, error: resolved.error, usage: ZERO_USAGE }
    return runStructured<JstackRoutePlan>(
      adapter,
      {
        run: {
          run_id: input.attempt_id,
          task_id: input.workflow_id,
          stage: 'brainstorm',
          role: 'Architect',
          attempt: 1,
        },
        idempotency_key: input.attempt_id,
        workspace: {
          path: input.workspace_path,
          repo_id: input.repo_id,
          branch: 'managed-route',
          untrusted: true,
        },
        context: input.context,
        output_contract: { schema_ref: 'route-plan', mode: 'post_validate' },
        permissions: {
          allowed_tools: resolved.value.native_tools,
          mode: 'deny_unlisted',
        },
        limits: { wall_clock_s: stageTimeoutMs('plan') / 1000, budget_usd: null, max_turns: 40 },
      },
      'managed route plan',
    )
  }

  return { harness, toolInventory, run, decide, plan }
}

export type { ManagedTicketToolPlan }
