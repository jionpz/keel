/**
 * 编排循环 —— 把前面五块串起来。
 *
 * ```
 * 取一个 PENDING 的 run
 *   → 造 Context（Fact Plane）
 *   → 跑真实 session（Execution Plane）
 *   → 五步校验 + 落库（Control Plane）
 *   → 标记 run SUCCEEDED
 *   → driver.advance → 下一状态可能又建一个 run
 * ```
 *
 * v0.1 是**同步**的：给定一个 Task，把它推到终态或推不动为止。
 * 它证明的是「各块能串起来」，不是「调度器可靠」——
 * durable timer 与 work queue 属后续子任务，两件事应分开验证。
 */

import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { HarnessAdapter } from '../../contracts/harness-adapter.js'
import type { HarnessSessionManager } from '../../execution/session/manager.js'
import { asRole } from '../../fact/db.js'
import type { RoleId, Stage, TaskStatus } from '../../shared/ids.js'
import { FactPlaneContextBuilder } from '../context/builder.js'
import type { WorkflowDriver } from '../driver/driver.js'
import { runSessionUntilValid } from '../proposal/pipeline.js'
import { expectedArtifact, promptFor, ROLE_INSTRUCTIONS } from './prompts.js'

export interface OrchestratorDeps {
  readonly driver: WorkflowDriver
  readonly sessions: HarnessSessionManager
  readonly adapter: HarnessAdapter
  readonly workspacePath: string
  /** 时间由外部注入 —— Control Plane 不读时钟 */
  readonly now: () => string
}

export interface StepRecord {
  readonly stage: Stage | null
  readonly status_before: TaskStatus
  readonly status_after: TaskStatus
  readonly transition: string | null
  readonly note: string
}

export interface RunToCompletionResult {
  readonly finalStatus: TaskStatus
  readonly steps: readonly StepRecord[]
}

const TERMINAL: readonly string[] = ['S-DONE', 'S-REJECTED', 'S-ABANDONED', 'S-FAILED']

export interface RunOptions {
  /** 硬上限，防止失控 */
  readonly maxSteps?: number
  /**
   * 注入外部事实（CI 结果）的回调。
   *
   * CI 是 Keel 的**外部事实源**（docs/09-roadmap.md §3）——
   * 系统本身不产生它。v0.1 尚无真实 git/CI 接入（属子任务 7），
   * 由调用方注入，且注入的事件会被明确标记来源。
   */
  readonly externalCi?: (taskId: string) => Promise<'passed' | 'failed'>
}

export async function runTaskToCompletion(
  taskId: string,
  deps: OrchestratorDeps,
  opts: RunOptions = {},
): Promise<Result<RunToCompletionResult>> {
  const maxSteps = opts.maxSteps ?? 20
  const steps: StepRecord[] = []
  const ctxBuilder = new FactPlaneContextBuilder(ROLE_INSTRUCTIONS)

  for (let i = 0; i < maxSteps; i++) {
    const state = await readState(taskId)
    if (state === null) return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))
    if (TERMINAL.includes(state.status)) {
      return ok({ finalStatus: state.status, steps })
    }

    // ── S-NEW：踢一脚 ──
    if (state.status === 'S-NEW') {
      const adv = await deps.driver.advance(taskId, { type: 'Dispatch' }, deps.now())
      if (!adv.ok) return err(adv.error)
      steps.push(record(state.status, adv, null, '派发'))
      continue
    }

    // ── S-RFC_READY：读 Policy 裁决并据此推进 ──
    if (state.status === 'S-RFC_READY') {
      const decision = await readPolicyDecision(taskId)
      if (decision === null) {
        return err(makeError('NOT_FOUND', 'S-RFC_READY 但没有 A-PolicyDecision'))
      }
      const adv = await deps.driver.advance(
        taskId,
        { type: 'PolicyEvaluated', decision },
        deps.now(),
      )
      if (!adv.ok) return err(adv.error)
      steps.push(record(state.status, adv, null, `Policy 裁决 ${decision}`))
      continue
    }

    // ── S-PR_OPEN：等外部 CI ──
    if (state.status === 'S-PR_OPEN') {
      if (opts.externalCi === undefined) {
        return ok({ finalStatus: state.status, steps })
      }
      const ci = await opts.externalCi(taskId)
      const adv = await deps.driver.advance(
        taskId,
        { type: ci === 'passed' ? 'CIPassed' : 'CIFailed' },
        deps.now(),
      )
      if (!adv.ok) return err(adv.error)
      steps.push(record(state.status, adv, null, `外部 CI：${ci}`))
      continue
    }

    // ── 阶段态：找 PENDING run 执行 ──
    const pending = await readPendingRun(taskId)
    if (pending === null) {
      return ok({ finalStatus: state.status, steps })
    }

    const executed = await executeRun(taskId, pending, deps, ctxBuilder)
    if (!executed.ok) return err(executed.error)

    const event =
      pending.stage === 'rfc_draft'
        ? ({ type: 'ArtifactCommitted', kind: 'rfc' } as const)
        : ({ type: 'RunSucceeded', stage: pending.stage } as const)

    const adv = await deps.driver.advance(taskId, event, deps.now())
    if (!adv.ok) return err(adv.error)
    steps.push(record(state.status, adv, pending.stage, `${pending.stage} 完成`))
  }

  const final = await readState(taskId)
  return err(
    makeError(
      'RUN_TIMEOUT',
      `超过 ${maxSteps} 步仍未终结，停在 ${final?.status ?? '?'}。已走：${steps
        .map((s) => s.transition)
        .join(' → ')}`,
    ),
  )
}

/** 跑一个 run：造 Context → 真实 session → 校验落库 → 标记 SUCCEEDED */
async function executeRun(
  taskId: string,
  pending: { id: string; stage: Stage; role: RoleId },
  deps: OrchestratorDeps,
  ctxBuilder: FactPlaneContextBuilder,
): Promise<Result<void>> {
  const ctx = await asRole('keel_control', (c) =>
    ctxBuilder.build(c, {
      task_id: taskId,
      run_id: pending.id,
      role: pending.role,
      stage: pending.stage,
      budget_tokens: 40_000,
    }),
  )
  if (!ctx.ok) return err(ctx.error)

  const expect = expectedArtifact(pending.stage)
  const outcome = await runSessionUntilValid(
    deps.sessions,
    {
      runSpec: {
        run: {
          run_id: pending.id,
          task_id: taskId,
          stage: pending.stage,
          role: pending.role,
          attempt: 1,
        },
        idempotency_key: `${taskId}/${pending.stage}/1`,
        workspace: {
          path: deps.workspacePath,
          repo_id: 'local',
          branch: 'main',
          // 目标仓库内容不可信 —— 见 docs/08-cross-cutting.md §1.2
          untrusted: true,
        },
        context: ctx.value,
        output_contract: { schema_ref: expect.kind, mode: 'post_validate' },
        // develop 阶段要真的改文件，必须给写权限。
        // ⚠️ 工具名必须是 Harness 实际支持的 —— OMP 对无效名直接报错退出
        // （不是静默忽略），这是好行为，但意味着这里不能凭想象写。
        permissions:
          pending.stage === 'develop'
            ? { allowed_tools: ['read', 'write'], mode: 'auto' }
            : { allowed_tools: ['read'], mode: 'auto' },
        limits: { wall_clock_s: 180, budget_usd: null, max_turns: 8 },
      },
      adapter: deps.adapter,
      expect,
    },
    promptFor(pending.stage, pending.id),
  )
  if (!outcome.ok) return err(outcome.error)

  await asRole('keel_control', (c) =>
    c.query(`UPDATE run SET status='SUCCEEDED', ended_at=now() WHERE id=$1`, [pending.id]),
  )
  return ok(undefined)
}

function record(
  before: TaskStatus,
  adv: { ok: true; value: { to: TaskStatus; transition_id: string | null } },
  stage: Stage | null,
  note: string,
): StepRecord {
  return {
    stage,
    status_before: before,
    status_after: adv.value.to,
    transition: adv.value.transition_id,
    note,
  }
}

async function readState(taskId: string): Promise<{ status: TaskStatus } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ status: TaskStatus }>('SELECT status FROM task WHERE id=$1', [taskId]),
  )
  return r.rows[0] ?? null
}

async function readPendingRun(
  taskId: string,
): Promise<{ id: string; stage: Stage; role: RoleId } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ id: string; stage: Stage; role: RoleId }>(
      `SELECT id, stage, role FROM run WHERE task_id=$1 AND status='PENDING'
       ORDER BY attempt DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0] ?? null
}

async function readPolicyDecision(taskId: string): Promise<string | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ body: { decision?: string } }>(
      `SELECT body FROM artifact WHERE task_id=$1 AND kind='policy_decision'
       ORDER BY committed_at_seq DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0]?.body?.decision ?? null
}
