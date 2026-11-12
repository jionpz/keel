import { makeError, type Result, type ResultWithUsage } from '../contracts/errors.js'
import type { HarnessAdapter, RunHandle, RunResult } from '../contracts/harness-adapter.js'
import type {
  ManagedTicketDecisionRunner,
  ManagedTicketStageInput,
  ManagedTicketStageRunner,
  ManagedTicketToolPlan,
  ManagedWorkflowPlanRunner,
} from '../contracts/managed.js'
import type { Usage } from '../contracts/types.js'
import type {
  JstackRoutePlan,
  ManagedTicketStageResult,
  TianwenDecision,
} from '../generated/managed.js'
import type { RoleId } from '../shared/ids.js'
import { MANAGED_STAGE_CLEANUP_MS, MANAGED_STAGE_TIMEOUT_MS } from '../shared/managed-limits.js'
import { extractJson } from './session/extract.js'
import { parseToolPolicy, resolveToolPolicy } from './tool-policy.js'

const ROLE_MAP: Readonly<Record<string, RoleId>> = {
  developer: 'Developer',
  verifier: 'QA',
  reviewer: 'Reviewer',
  releaser: 'Developer',
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

export async function awaitTicketResult(
  adapter: Pick<HarnessAdapter, 'awaitResult' | 'interrupt'>,
  handle: RunHandle,
): Promise<Result<RunResult> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      void adapter.interrupt(handle, 'timeout').catch(() => undefined)
      cleanupTimer = setTimeout(() => resolve(null), MANAGED_STAGE_CLEANUP_MS)
    }, MANAGED_STAGE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([adapter.awaitResult(handle), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
  }
}

export function ticketWorkerFromAdapter(adapter: HarnessAdapter): ManagedTicketWorkerAdapter {
  const descriptor = adapter.describe()
  const harness = descriptor.harness_id === 'claude' ? 'claude-code' : descriptor.harness_id
  const toolInventory = descriptor.tool_inventory ?? []
  const run: ManagedTicketStageRunner = async (
    input: ManagedTicketStageInput,
  ): Promise<ResultWithUsage<{ output: ManagedTicketStageResult; usage: Usage }>> => {
    const started = await adapter.startRun({
      run: {
        run_id: input.attempt_id,
        task_id: input.task_id,
        stage: STAGE_MAP[input.stage],
        role: ROLE_MAP[input.tool_plan.role] ?? 'Developer',
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
      limits: { wall_clock_s: MANAGED_STAGE_TIMEOUT_MS / 1000, budget_usd: null, max_turns: 40 },
    })
    if (!started.ok) return { ok: false, error: started.error, usage: ZERO }
    try {
      const result = await awaitTicketResult(adapter, started.value)
      if (result === null)
        return {
          ok: false,
          error: makeError('RUN_TIMEOUT', 'managed ticket stage wall clock'),
          usage: ZERO,
        }
      if (!result.ok) return { ok: false, error: result.error, usage: ZERO }
      if (result.value.status !== 'SUCCEEDED')
        return {
          ok: false,
          error: makeError(
            result.value.status === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'PROTOCOL_ERROR',
            `managed ticket stage ${result.value.status}`,
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
      return {
        ok: true,
        value: {
          output: parsed.value as ManagedTicketStageResult,
          usage: result.value.usage,
        },
      }
    } finally {
      await adapter.dispose(started.value)
    }
  }
  const decide: ManagedTicketDecisionRunner = async (input) => {
    const started = await adapter.startRun({
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
    })
    if (!started.ok) return { ok: false, error: started.error, usage: ZERO }
    try {
      const result = await awaitTicketResult(adapter, started.value)
      if (result === null)
        return {
          ok: false,
          error: makeError('RUN_TIMEOUT', 'managed ticket tianwen wall clock'),
          usage: ZERO,
        }
      if (!result.ok) return { ok: false, error: result.error, usage: ZERO }
      if (result.value.status !== 'SUCCEEDED')
        return {
          ok: false,
          error: makeError(
            result.value.status === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'PROTOCOL_ERROR',
            `managed ticket tianwen ${result.value.status}`,
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
      return {
        ok: true,
        value: {
          output: parsed.value as TianwenDecision,
          usage: result.value.usage,
        },
      }
    } finally {
      await adapter.dispose(started.value)
    }
  }
  const plan: ManagedWorkflowPlanRunner = async (input) => {
    const policy = parseToolPolicy(input.package.tool_policy)
    if (!policy.ok) return { ok: false, error: policy.error, usage: ZERO }
    const resolved = resolveToolPolicy(policy.value, {
      stage: 'plan',
      harness,
      inventory: toolInventory,
      allowShellFallback: false,
    })
    if (!resolved.ok) return { ok: false, error: resolved.error, usage: ZERO }
    const started = await adapter.startRun({
      run: {
        run_id: input.attempt_id,
        task_id: input.workflow_id,
        stage: 'brainstorm',
        role: 'Architect' as RoleId,
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
      limits: { wall_clock_s: MANAGED_STAGE_TIMEOUT_MS / 1000, budget_usd: null, max_turns: 40 },
    })
    if (!started.ok) return { ok: false, error: started.error, usage: ZERO }
    try {
      const result = await awaitTicketResult(adapter, started.value)
      if (result === null)
        return {
          ok: false,
          error: makeError('RUN_TIMEOUT', 'managed route plan wall clock'),
          usage: ZERO,
        }
      if (!result.ok) return { ok: false, error: result.error, usage: ZERO }
      if (result.value.status !== 'SUCCEEDED')
        return {
          ok: false,
          error: makeError(
            result.value.status === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'PROTOCOL_ERROR',
            `managed route plan ${result.value.status}`,
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
      return {
        ok: true,
        value: {
          output: parsed.value as JstackRoutePlan,
          usage: result.value.usage,
        },
      }
    } finally {
      await adapter.dispose(started.value)
    }
  }
  return { harness, toolInventory, run, decide, plan }
}

const ZERO = {
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  cost_basis: 'unavailable' as const,
}

export type { ManagedTicketToolPlan }
