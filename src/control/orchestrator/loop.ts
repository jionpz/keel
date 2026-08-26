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

import { randomUUID } from 'node:crypto'
import type { CiGateway } from '../../contracts/ci-gateway.js'
import { err, type KeelError, makeError, ok, type Result } from '../../contracts/errors.js'
import type { HarnessAdapter } from '../../contracts/harness-adapter.js'
import type { HarnessSessionManager } from '../../execution/session/manager.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
import type { GitWorkspace } from '../../fact/git-workspace.js'
import type { RoleId, Stage, TaskStatus } from '../../shared/ids.js'
import { claimDueTimers } from '../../timer/drain.js'
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
   * 系统本身不产生它。v0.1 尚无真实 git/CI 接入（属子任务 7），
   * 由调用方注入，且注入的事件会被明确标记来源。
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

    // ── S-NEED_CLARIFICATION：等人工回答或澄清 TTL 到期(issue #24,方案 A)──
    //
    // 有 PENDING run 先执行(阶段态在前面?不——此分支在阶段态处理前,
    // 但澄清态无 run)。对齐 S-PR_OPEN 的空闲等待:claim 本 task 的到期
    // 澄清 timer → advance(TimerFired) → T-008 → S-ABANDONED。
    // 未到期且无外部 ClarificationReceived 注入 → 停(调用方稍后用
    // 已推进的 now 再进 loop)。
    if (state.status === 'S-NEED_CLARIFICATION') {
      const due = await claimDueTimers(deps.now(), { taskId, limit: 1 })
      if (due.length > 0) {
        const adv = await deps.driver.advance(
          taskId,
          { type: 'TimerFired', timer: 'clarification_ttl' },
          deps.now(),
        )
        if (!adv.ok) return err(adv.error)
        // T-008 的 ConsumeTimer 把 timer 置 fired(同一事务);若 advance 未匹配
        // (task 已离开澄清态)则不 Consume,行仍 pending —— 幂等,下次再说
        steps.push(record(state.status, adv, null, '澄清 TTL 到期 → 弃单'))
        continue
      }
      // 未到期:等人工回答(生产由外部 ClarificationReceived 驱动,注入 now)
      return ok({ finalStatus: state.status, steps })
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
    if (!executed.ok) {
      const runErr = executed.error
      // R1(issue #23):失败是状态流转,不是编排器异常 ——
      // 标 run 状态 + emit 失败事件,交给 T-030(重试)/T-031(升人工)。
      const next = await failRunAndAdvance(taskId, pending, runErr, deps, state, steps)
      if (next === 'stopped-cancelled') {
        // 人工撤回(R-010):不重试;下一轮无 PENDING,loop 自然停
        continue
      }
      if (next === 'error') return err(runErr)
      // next === 'advanced':失败已交给转移,T-030 建新 run 或 T-031 升人工,
      // 循环继续读取下一 PENDING run
      continue
    }

    // brainstorm 收敛:把候选方案物化为 A-State(issue #24 合并验收暴露)。
    //
    // 此前 brainstorm 只落 stage_outcome.details;下游(rfc_draft/develop)
    // 的 ContextBuilder 读 A-State(kind='state')——恒空,模型无方案可写,
    // rfc_draft 3 次不合格 → T-031 升人工。这里把收敛细节合成 A-State
    // (flow 步骤 13「写 A-State@3」的实现),下游才有方案。
    if (pending.stage === 'brainstorm') {
      await synthesizeStateFromBrainstorm(taskId, pending.id, deps.now())
    }

    // brainstorm 收敛产物若请求 Critic 评审(needs_critic),
    // 走 T-009:合成 A-CapabilityRequest → CapabilityRequested → 创建 run(critic)。
    // capability 来自产物 details.capability(R3)——模型声明,不硬编码;
    // 非 critic_review 时 P-ALLOW-CRITIC 不命中 → 默认 deny → guard 拒(R4)→ 停。
    // 评审完成后 T-009b 回流 brainstorm(n+1),新一轮收敛再走 T-010。
    if (pending.stage === 'brainstorm' && (await brainstormNeedsCritic(taskId))) {
      const capability = await brainstormRequestedCapability(taskId)
      await synthesizeCapabilityRequest(taskId, pending.id, capability)
      const adv = await deps.driver.advance(
        taskId,
        { type: 'CapabilityRequested', capability },
        deps.now(),
      )
      if (!adv.ok) return err(adv.error)
      if (!adv.value.advanced) {
        // R4(issue #23):capability 被拒(缺规则/deny)——
        // NoTransition 已落库留痕;能力请求无法受理,停(需要人工/外部),
        // 不假装成功继续。
        steps.push(record(state.status, adv, 'critic', `capability ${capability} 被拒(guard 未过)`))
        return ok({ finalStatus: state.status, steps })
      }
      steps.push(record(state.status, adv, 'critic', `brainstorm 请求 Critic 评审(${capability})`))
      continue
    }

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
  pending: { id: string; stage: Stage; role: RoleId; attempt: number },
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

  // 方案 B(issue #26):run 级墙钟 timer —— Keel 侧强制收割,不只靠 harness --max-time
  const wallClockS = 180 // v0.1 写死的 run 墙钟上限(R-009)
  await createRunWallClockTimer(taskId, pending.id, wallClockS, deps.now())

  const outcome = await runSessionUntilValid(
    deps.sessions,
    {
      runSpec: {
        run: {
          run_id: pending.id,
          task_id: taskId,
          stage: pending.stage,
          role: pending.role,
          // 与 createRun 副作用写入的 attempt 同源 ——
          // 幂等键必须同构,否则 Run 级幂等失效
          attempt: pending.attempt,
        },
        // 幂等键与 docs/04-state-machine.md §5.1 一致：(task_id, stage, attempt)
        idempotency_key: `${taskId}/${pending.stage}/${pending.attempt}`,
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
    {
      // #1-02:capability_request 等需要授权的 Proposal 由同一 Policy 实例裁决
      policy: deps.driver.policyEngine,
      now: deps.now(),
      // 方案 B:墙钟 watchdog(R-009 Keel 侧收割)
      wallClockMs: wallClockS * 1000,
    },
  )
  if (!outcome.ok) return err(outcome.error)

  await asRole('keel_control', (c) =>
    c.query(`UPDATE run SET status='SUCCEEDED', ended_at=$2 WHERE id=$1`, [pending.id, deps.now()]),
  )
  // run 已终态:墙钟 timer 不再需要 —— 置 cancelled 防残留误触发
  await cancelRunWallClockTimer(pending.id)

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

async function readState(taskId: string): Promise<{ status: TaskStatus } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ status: TaskStatus }>('SELECT status FROM task WHERE id=$1', [taskId]),
  )
  return r.rows[0] ?? null
}

async function readPendingRun(
  taskId: string,
): Promise<{ id: string; stage: Stage; role: RoleId; attempt: number } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ id: string; stage: Stage; role: RoleId; attempt: number }>(
      `SELECT id, stage, role, attempt FROM run WHERE task_id=$1 AND status='PENDING'
       ORDER BY attempt DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0] ?? null
}

/**
 * 方案 B(issue #26):run 级墙钟 timer —— Keel 侧强制收割 R-009。
 * due = 注入 now + wallClockS;幂等:同 (run_id, kind) 至多一个 pending。
 * 成功后由 cancelRunWallClockTimer 置 cancelled(生命周期闭环)。
 */
async function createRunWallClockTimer(
  taskId: string,
  runId: string,
  wallClockS: number,
  now: string,
): Promise<void> {
  await asRole('keel_control', (c) =>
    c.query(
      `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
       VALUES ($1,$2,$3,'wall_clock',$4,'pending')
       ON CONFLICT (run_id, kind) WHERE state = 'pending' AND run_id IS NOT NULL DO NOTHING`,
      [
        randomUUID(),
        taskId,
        runId,
        new Date(new Date(now).getTime() + wallClockS * 1000).toISOString(),
      ],
    ),
  )
}

/** 方案 B:run 已终态,墙钟 timer 置 cancelled(防残留误触发) */
async function cancelRunWallClockTimer(runId: string): Promise<void> {
  await asRole('keel_control', (c) =>
    c.query(
      `UPDATE timer SET state='cancelled' WHERE run_id=$1 AND kind='wall_clock' AND state='pending'`,
      [runId],
    ),
  )
}

/**
 * R1(issue #23):run 失败的处理 —— 标状态 + 交给转移表,不中止编排。
 *
 * 失败是**正常状态流转**:T-030(重试)/T-031(升人工)已经在转移表里,
 * 之前编排器用 `return err` 绕过它们,导致失败 run 卡 PENDING、
 * T-030/T-031 死转移、重入按同幂等键重复执行。
 *
 * 返回:
 * - 'advanced'         失败已 emit + driver.advance;T-030 建新 run 或 T-031 升人工
 * - 'stopped-cancelled' 人工撤回(R-010):标 CANCELLED 不重试,loop 下一轮自然停
 * - 'error'            转移本身失败(编排错误)或 CANCELLED 状态异常 —— return err
 */
async function failRunAndAdvance(
  taskId: string,
  pending: { id: string; stage: Stage },
  runErr: KeelError,
  deps: OrchestratorDeps,
  state: { status: TaskStatus },
  steps: StepRecord[],
): Promise<'advanced' | 'stopped-cancelled' | 'error'> {
  // 失败类型 → run 状态:超时 / 人工撤回 / 其他(重试类)
  const status =
    runErr.kind === 'RUN_TIMEOUT'
      ? 'TIMEOUT'
      : runErr.kind === 'RUN_CANCELLED'
        ? 'CANCELLED'
        : 'FAILED'

  await asRole('keel_control', (c) =>
    c.query(`UPDATE run SET status=$2, ended_at=$3, error_kind=$4, error_detail=$5 WHERE id=$1`, [
      pending.id,
      status,
      deps.now(),
      runErr.kind,
      runErr.detail,
    ]),
  )
  // run 已终态:墙钟 timer 不再需要(方案 B,防残留误触发)
  await cancelRunWallClockTimer(pending.id)

  // 人工撤回:不重试(R-010)。run 已脱离 PENDING,下一轮无 PENDING → 停。
  if (status === 'CANCELLED') {
    return 'stopped-cancelled'
  }

  const event =
    status === 'TIMEOUT'
      ? ({ type: 'RunTimeout', stage: pending.stage } as const)
      : ({ type: 'RunFailed', stage: pending.stage } as const)

  const adv = await deps.driver.advance(taskId, event, deps.now())
  if (!adv.ok) return 'error'
  steps.push(record(state.status, adv, pending.stage, `${pending.stage} 失败(${runErr.kind})`))
  return 'advanced'
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

/**
 * 最新 brainstorm 收敛产物是否请求 Critic 评审。
 *
 * verdict=converged 且 details.needs_critic=true(brainstorm 提示词引导)。
 * 活锁上限(R5,issue #23):critic run 已 ≥2 次 → 强制收敛(不再接受新请求),
 * 第 2 回流后必须走 T-010 —— 不依赖模型自控。
 */
async function brainstormNeedsCritic(taskId: string): Promise<boolean> {
  const body = await latestBrainstormOutcome(taskId)
  const wantsCritic = body?.verdict === 'converged' && body.details?.needs_critic === true
  if (!wantsCritic) return false

  const r = await asRole('keel_control', (c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1 AND stage='critic'`, [
      taskId,
    ]),
  )
  return Number(r.rows[0]?.n ?? 0) < 2
}

/**
 * 最新 brainstorm 收敛产物请求的 capability 名。
 *
 * 来自 details.capability(模型声明,R3,issue #23);缺省 'critic_review'
 * (向后兼容:提示词已加字段说明,旧模型不带 capability 时走缺省)。
 */
async function brainstormRequestedCapability(taskId: string): Promise<string> {
  const body = await latestBrainstormOutcome(taskId)
  const cap = body?.details?.capability
  return typeof cap === 'string' && cap.trim() !== '' ? cap : 'critic_review'
}

async function latestBrainstormOutcome(taskId: string): Promise<{
  verdict?: string
  details?: { needs_critic?: unknown; capability?: unknown }
} | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{
      body: { verdict?: string; details?: { needs_critic?: unknown; capability?: unknown } }
    }>(
      `SELECT body FROM artifact
       WHERE task_id=$1 AND kind='stage_outcome' AND key='brainstorm'
       ORDER BY committed_at_seq DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0]?.body ?? null
}

/**
 * 合成 A-CapabilityRequest 落库(Control Plane 侧构造)。
 *
 * 单产物执行模型下,brainstorm 的收敛产物(stage_outcome)携带
 * needs_critic 请求;这里把该事实物化为契约规定的 capability_request
 * artifact,供审计与 T-009 的 Policy 求值(capability fact 从事件取)。
 *
 * 幂等:同一 produced_by_run 只写一次(commitArtifactOn 的 version 递增
 * 会重复写 —— 用固定 key='latest' + 查重保护)。
 */
async function synthesizeCapabilityRequest(
  taskId: string,
  producedByRun: string,
  capability: string,
): Promise<void> {
  await asRole('keel_control', async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM artifact WHERE task_id=$1 AND produced_by_run=$2 AND kind='capability_request'`,
      [taskId, producedByRun],
    )
    if (existing.rows.length > 0) return // 已合成,幂等

    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, run_id, type, payload)
       VALUES ($1,$2,'ProposalAccepted',$3::jsonb) RETURNING seq`,
      [taskId, producedByRun, JSON.stringify({ kind: 'capability_request', key: 'latest' })],
    )
    await commitArtifactOn(c, {
      id: randomUUID(),
      taskId,
      kind: 'capability_request',
      key: 'latest',
      body: {
        schema_version: '1.0',
        request_id: `${taskId}:${producedByRun}`,
        requested_by_run: producedByRun,
        capability,
        params: {},
        rationale: 'brainstorm 收敛产物请求架构评审(needs_critic)',
        blocking: true,
      },
      producedByRun,
      committedAtSeq: Number(ev.rows[0]?.seq),
      supersedes: null,
    })
  })
}

/**
 * 把 brainstorm 收敛产物物化为 A-State(issue #24 合并验收暴露)。
 *
 * 断链根源:brainstorm 的候选方案只落 stage_outcome.details,下游
 * (rfc_draft/develop)的 ContextBuilder 读 A-State(kind='state')——
 * 恒空导致模型无方案可写,rfc_draft 连续不合格升人工。
 *
 * 这里读 latest brainstorm stage_outcome 的 details 合成 A-State
 * (flow 步骤 13「写 A-State@3」的实现)。幂等:同 produced_by_run 只写一次;
 * version 由 commitArtifactOn 自增(每次收敛新一版,superseded_by 链天然)。
 */
async function synthesizeStateFromBrainstorm(
  taskId: string,
  producedByRun: string,
  now: string,
): Promise<void> {
  await asRole('keel_control', async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM artifact WHERE task_id=$1 AND produced_by_run=$2 AND kind='state'`,
      [taskId, producedByRun],
    )
    if (existing.rows.length > 0) return // 已合成,幂等

    const outcome = await c.query<{ body: Record<string, unknown> }>(
      `SELECT body FROM artifact
       WHERE task_id=$1 AND kind='stage_outcome' AND key='brainstorm' AND produced_by_run=$2
       ORDER BY committed_at_seq DESC LIMIT 1`,
      [taskId, producedByRun],
    )
    const details = (outcome.rows[0]?.body?.details ?? {}) as Record<string, unknown>
    const candidates = Array.isArray(details.candidates) ? details.candidates : []

    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, run_id, type, payload)
       VALUES ($1,$2,'ProposalAccepted',$3::jsonb) RETURNING seq`,
      [taskId, producedByRun, JSON.stringify({ kind: 'state', key: '' })],
    )
    await commitArtifactOn(c, {
      id: randomUUID(),
      taskId,
      kind: 'state',
      key: '',
      body: {
        schema_version: '1.0',
        current_goal: String(details.goal ?? '候选方案待定'),
        confirmed_facts: [],
        decisions: [],
        open_questions: [],
        risks: [],
        // 候选方案:brainstorm 的收敛内容 —— 下游 rfc_draft 据此写 RFC
        candidate_options: candidates,
        context_summary: `brainstorm @ ${now}:${details.reason !== undefined ? String(details.reason) : ''}`,
      },
      producedByRun,
      committedAtSeq: Number(ev.rows[0]?.seq),
      supersedes: null,
    })
  })
}
