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

import type { CiGateway } from '../../contracts/ci-gateway.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { HarnessAdapter } from '../../contracts/harness-adapter.js'
import type { HarnessSessionManager } from '../../execution/session/manager.js'
import { asRole } from '../../fact/db.js'
import type { GitWorkspace } from '../../fact/git-workspace.js'
import type { ControlMode, RoleId, Stage, TaskStatus } from '../../shared/ids.js'
import { checkBudgetFuse } from '../budget/fuse.js'
import { FactPlaneContextBuilder } from '../context/builder.js'
import type { WorkflowDriver } from '../driver/driver.js'
import { runSessionUntilValid } from '../proposal/pipeline.js'
import { expectedArtifact, promptFor, ROLE_INSTRUCTIONS } from './prompts.js'

/**
 * Session 干活的地方。
 *
 * 建模为判别联合而不是「一个可选 git + 一个可选 path」——
 * 后者能表达「两个都没给」和「两个都给了」这两种无意义状态。
 */
export type OrchestratorWorkspace =
  /**
   * 每 Task 一个独立 worktree（`docs/08-cross-cutting.md` §4.1 的 `N1`）。
   *
   * 这是**真实编排应该走的路径**：两个 Task 同时改一个仓库时互不可见，
   * 且 Agent 污染工作区后销毁 worktree 即完全清理（`S1`）。
   *
   * 路径解析走 `ensureWorktree`，与副作用执行器里的 `CreateBranch` 是**同一个幂等操作** ——
   * 谁先跑到都不影响结果，这正是当初把分支名定成 `f(task_id)` 的原因。
   */
  | {
      readonly mode: 'worktree'
      readonly git: GitWorkspace
      readonly repoId: string
      readonly baseBranch: string
    }
  /**
   * 固定目录，所有 Task 共用。
   *
   * **只适用于单 Task 的测试**。并发下它是错的 —— 保留它是为了让
   * 不关心 git 的测试不必准备裸仓库，而不是因为它是一种合理的生产配置。
   */
  | { readonly mode: 'fixed'; readonly path: string }

export interface OrchestratorDeps {
  readonly driver: WorkflowDriver
  readonly sessions: HarnessSessionManager
  readonly adapter: HarnessAdapter
  readonly workspace: OrchestratorWorkspace
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
   * 系统本身不产生它。真实接入走 `ci`（GitHubProvider 实现 CiGateway）；
   * 本回调保留给确定性测试与不依赖远程仓库/凭据的本地闭环
   * （见 v01-criterion.acceptance.test.ts 的头注释），注入的事件会被明确标记来源。
   */
  readonly externalCi?: (taskId: string) => Promise<'passed' | 'failed'>
  /**
   * 真实 CI 网关。传入时优先于 `externalCi`，用于读取 GitHub Checks / Status。
   */
  readonly ci?: CiGateway
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

    // ── control_mode ≠ auto：不派发新 run，正常停止 ──
    //
    // 预算熔断（C-002）与人工暂停/接管走的都是这个维度。
    // 停止是**正常返回而非 error**：status 未变、事实完整，
    // 恢复（C-005）后可从当前 status 继续 —— 把它当错误会掩盖这一点。
    if (state.control_mode !== 'auto') {
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
      if (opts.ci !== undefined) {
        if (deps.workspace.mode !== 'worktree') {
          return err(makeError('WORKSPACE_ERROR', '真实 CI 需要 worktree 模式才能读取 head SHA'))
        }
        const sha = await deps.workspace.git.headSha(deps.workspace.repoId, taskId)
        if (!sha.ok) return err(sha.error)
        const remote = await readRemoteUrl(deps.workspace.repoId)
        if (!remote.ok) return err(remote.error)
        const ciResult = await opts.ci.waitForCi({
          repoId: deps.workspace.repoId,
          remoteUrl: remote.value,
          headSha: sha.value,
        })
        if (!ciResult.ok) return err(ciResult.error)
        const adv = await deps.driver.advance(
          taskId,
          { type: ciResult.value === 'passed' ? 'CIPassed' : 'CIFailed' },
          deps.now(),
        )
        if (!adv.ok) return err(adv.error)
        steps.push(record(state.status, adv, null, `外部 CI：${ciResult.value}`))
        continue
      }
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

  const place = await resolveWorkspace(taskId, deps.workspace)
  if (!place.ok) return err(place.error)

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
          path: place.value.path,
          repo_id: place.value.repo_id,
          branch: place.value.branch,
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

  // 谁执行了这个 run 是事实，记在 run 行上（O 可观测 + ADR-0005）——
  // Human L0 e2e 据此断言「L0 路径真的被执行过」，而不是靠桩自己声称。
  //
  // 成本一并写回（C1）：usage 是全部轮次的累计值，三态 cost_basis 原样落库 ——
  // 没上报就是 null + 'unavailable'，禁止用 0 冒充（docs/08-cross-cutting.md §3.1）。
  //
  // 熔断检查在**同一事务**内：写回与核算之间不留窗口，
  // 崩溃重启后不会出现「成本已入账但该暂停的 Task 还在跑」。
  const descriptor = deps.adapter.describe()
  const usage = outcome.value.usage
  await asRole('keel_control', async (c) => {
    await c.query(
      `UPDATE run SET status='SUCCEEDED', ended_at=now(), harness_id=$2, harness_tier=$3,
              tokens_in=$4, tokens_out=$5, cost_usd=$6, cost_basis=$7
       WHERE id=$1`,
      [
        pending.id,
        descriptor.harness_id,
        descriptor.tier,
        usage.tokens_in,
        usage.tokens_out,
        usage.cost_usd,
        usage.cost_basis,
      ],
    )
    await checkBudgetFuse(c, taskId, deps.now())
  })

  // 把这一轮的改动提交到该 Task 的分支。
  //
  // **不提交就等于没做**：进 S-DONE 时 CleanWorkspace 会 `worktree remove --force`，
  // 未提交的改动随工作树一起消失。分支留在裸仓库里，所以提交过的活不会丢
  // （见 src/fact/git-workspace.ts 的 remove()）。
  //
  // 无改动时 commitAll 返回 null —— 「这一轮没改东西」是正常情况，不是故障。
  if (deps.workspace.mode === 'worktree') {
    const sha = await deps.workspace.git.commitAll(
      taskId,
      `${pending.stage}: run ${pending.id.slice(0, 8)}`,
    )
    if (!sha.ok) return err(sha.error)
  }

  return ok(undefined)
}

/**
 * 解析这个 Task 该在哪个目录里干活。
 *
 * worktree 模式下每次都调 `ensureWorktree` 而不是缓存路径：它本来就是幂等的，
 * 而缓存会在「worktree 被清理后又要用」时给出一条已经不存在的路径。
 */
async function resolveWorkspace(
  taskId: string,
  ws: OrchestratorWorkspace,
): Promise<Result<{ path: string; repo_id: string; branch: string }>> {
  if (ws.mode === 'fixed') {
    return ok({ path: ws.path, repo_id: 'local', branch: 'main' })
  }
  const wt = await ws.git.ensureWorktree(ws.repoId, taskId, ws.baseBranch)
  if (!wt.ok) return err(wt.error)
  return ok({ path: wt.value.path, repo_id: ws.repoId, branch: wt.value.branch })
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

async function readRemoteUrl(repoId: string): Promise<Result<string>> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ remote_url: string }>('SELECT remote_url FROM repo WHERE id=$1', [repoId]),
  )
  const row = r.rows[0]
  if (row === undefined) return err(makeError('NOT_FOUND', `找不到 repo ${repoId}`))
  return ok(row.remote_url)
}

async function readState(
  taskId: string,
): Promise<{ status: TaskStatus; control_mode: ControlMode } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ status: TaskStatus; control_mode: ControlMode }>(
      'SELECT status, control_mode FROM task WHERE id=$1',
      [taskId],
    ),
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
