/** 只读 managed 推理：无原生工具，所有文件内容由 Control 提供；不触 Fact Plane。 */
import { makeError, type ResultWithUsage } from '../contracts/errors.js'
import type { HarnessAdapter } from '../contracts/harness-adapter.js'
import type { ManagedInference, ManagedInferenceInput } from '../contracts/managed.js'
import { ZERO_USAGE } from '../contracts/types.js'
import { extractJson } from './session/extract.js'

export function managedInference(adapter: HarnessAdapter): ManagedInference {
  return async (
    input: ManagedInferenceInput,
  ): Promise<ResultWithUsage<{ value: unknown; usage: typeof ZERO_USAGE }>> => {
    const started = await adapter.startRun({
      run: {
        run_id: input.attempt_id,
        task_id: input.task_id,
        stage: input.phase === 'tianwen' ? 'tianwen' : 'managed_investigate',
        role: input.phase === 'tianwen' ? 'Tianwen' : 'Investigator',
        attempt: 1,
      },
      idempotency_key: input.attempt_id,
      workspace: {
        path: input.workspace_path,
        repo_id: input.repo_id,
        branch: 'managed-readonly',
        untrusted: true,
      },
      context: input.context,
      output_contract: { schema_ref: 'managed', mode: 'post_validate' },
      permissions: { allowed_tools: [], mode: 'deny_unlisted' },
      limits: { wall_clock_s: 90, budget_usd: null, max_turns: 1 },
    })
    if (!started.ok) return { ok: false, error: started.error, usage: ZERO_USAGE }
    let timer: ReturnType<typeof setTimeout> | undefined
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          void adapter.interrupt(started.value, 'timeout').catch(() => undefined)
          // 给 Adapter 收敛 TIMEOUT 并带回已见 usage 的机会；仍不响应才报告 unavailable。
          cleanupTimer = setTimeout(() => resolve(null), 2000)
        }, 90000)
      })
      const result = await Promise.race([adapter.awaitResult(started.value), timeout])
      if (result === null)
        return {
          ok: false,
          error: makeError('RUN_TIMEOUT', 'managed inference wall clock'),
          usage: ZERO_USAGE,
        }
      if (!result.ok) return { ok: false, error: result.error, usage: ZERO_USAGE }
      const usage = result.value.usage
      if (result.value.status !== 'SUCCEEDED')
        return {
          ok: false,
          error: makeError(
            result.value.status === 'TIMEOUT' ? 'RUN_TIMEOUT' : 'PROTOCOL_ERROR',
            'managed inference failed',
          ),
          usage,
        }
      const parsed = extractJson(result.value.text ?? '')
      return parsed.ok
        ? { ok: true, value: { value: parsed.value, usage } }
        : { ok: false, error: makeError('PROTOCOL_ERROR', parsed.reason), usage }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
      await adapter.dispose(started.value)
    }
  }
}
