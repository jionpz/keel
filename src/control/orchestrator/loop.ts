/**
 * 编排循环 —— 把前面五块串起来。
 *
 * ```
 * 取一个 PENDING 的 run
 *   → 认领为 RUNNING（N3/N4 并发守卫，src/control/concurrency/limits.ts）
 *   → 造 Context（Fact Plane）
 *   → 跑真实 session（Execution Plane）
 *   → 五步校验 + 落库（Control Plane）
 *   → 标记 run SUCCEEDED（失败则 FAILED —— 不滞留在 RUNNING）
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
import type {
  HarnessAdapter,
  HarnessDescriptor,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import type { Usage } from '../../contracts/types.js'
import { type ModelProfile, resolveStageModel } from '../../execution/model-routing.js'
import type { HarnessSessionManager } from '../../execution/session/manager.js'
import { resolveKeelStageToolPolicy, type ToolPolicyDocument } from '../../execution/tool-policy.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
import type { GitWorkspace, PreparedProject } from '../../fact/git-workspace.js'
import { ensureTraceId } from '../../fact/trace.js'
import type { ControlMode, RoleId, Stage, TaskStatus } from '../../shared/ids.js'
import { isStageStatus } from '../../shared/ids.js'
import { claimDueTimers } from '../../timer/drain.js'
import { checkBudgetFuse } from '../budget/fuse.js'
import { claimRunForExecution, DEFAULT_MAX_RUNNING_RUNS } from '../concurrency/limits.js'
import { FactPlaneContextBuilder } from '../context/builder.js'
import type { WorkflowDriver } from '../driver/driver.js'
import { livenessMode, policyFor, runWallClockS } from '../liveness/policy.js'
import type { LivenessStore } from '../liveness/store.js'
import type { StallEvidence } from '../liveness/supervisor.js'
import { runSessionUntilValid, ZERO_USAGE } from '../proposal/pipeline.js'
import { loadDeclaredPolicyFacts } from '../proposal/validate.js'
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
      /** 开工前 prepare 好的项目与基线；worktree 只认这个 baseSha */
      readonly project: PreparedProject
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
  /**
   * run 级墙钟上限秒(R-009,方案 B)。缺省 180;测试注入短值验证收割。
   * 显式指定时覆盖 stage hard cap（--wall-clock 逃生阀）。
   */
  readonly wallClockS?: number
  /** liveness 遥测写入；缺省时 supervisor 仍在进程内工作，但巡检看不到这个 run */
  readonly livenessStore?: LivenessStore
  /** 单调时钟（测试注入；默认 performance.now） */
  readonly monotonicNow?: () => number
  /** 测试注入：缩短沉默检查 / owner 心跳间隔 */
  readonly livenessCheckIntervalMs?: number
  readonly ownerHeartbeatMs?: number
  /**
   * 显式模型覆盖（`--model` / `KEEL_MODEL` 合并后的值），**不含**缺省。
   * 缺省由 `resolveStageModel` 按 profile 补齐 —— 否则 enterprise profile 永远轮不到生效。
   */
  readonly modelOverride?: string
  /** 模型 profile；缺省 `default`（与改动前行为一致） */
  readonly modelProfile?: ModelProfile
  /** 非空时最终模型必须命中（`KEEL_MODEL_ALLOWLIST`）；缺省不校验 */
  readonly modelAllowlist?: readonly string[]
  /**
   * jstack 导出的阶段/角色工具策略。缺省时只对 Pi / Claude 之外保留旧权限；
   * CLI 必须在执行前加载并传入，不能让生产静默退化为统一 read/write。
   */
  readonly toolPolicy?: ToolPolicyDocument
  /** 显式允许只读 profile 通过 Bash 回退搜索；缺省 false */
  readonly toolPolicyAllowShellFallback?: boolean
}

export interface StepRecord {
  readonly stage: Stage | null
  readonly status_before: TaskStatus
  readonly status_after: TaskStatus
  readonly transition: string | null
  readonly note: string
}

/**
 * 为什么停下来的。
 *
 * 每一个 `ok` 返回都必须表态（字段必填）—— 这是「以后新增停止路径忘了想清楚」
 * 的强制点。故障不算停止原因：卡住走 `err`，见 `readPendingRun` 之后的分支。
 */
export type StopReason =
  /** 终态（S-DONE / S-REJECTED / S-ABANDONED / S-FAILED） */
  | 'terminal'
  /** `control_mode ≠ auto`：预算熔断（C-002）或人工暂停/接管，恢复（C-005）后可续 */
  | 'paused'
  /** 澄清态、TTL 未到期，等人工回答（ClarificationReceived） */
  | 'awaiting-clarification'
  /** `S-PR_OPEN` 且没有注入 CI 回调：等外部 CI 事实 */
  | 'awaiting-external-ci'
  /** `S-HUMAN_REVIEW`：等人工批准 / 驳回 / 回炉 */
  | 'awaiting-human'
  /** 能力请求被守卫拒绝（R4）：需要人工或外部介入 */
  | 'capability-denied'
  /** 最近一次 run 被人工撤回（R-010），不重试、不派发，等恢复 */
  | 'cancelled'

export interface RunToCompletionResult {
  readonly finalStatus: TaskStatus
  readonly steps: readonly StepRecord[]
  readonly stopReason: StopReason
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
      return ok({ finalStatus: state.status, steps, stopReason: 'terminal' })
    }

    // ── control_mode ≠ auto：不派发新 run，正常停止 ──
    //
    // 预算熔断（C-002）与人工暂停/接管走的都是这个维度。
    // 停止是**正常返回而非 error**：status 未变、事实完整，
    // 恢复（C-005）后可从当前 status 继续 —— 把它当错误会掩盖这一点。
    if (state.control_mode !== 'auto') {
      return ok({ finalStatus: state.status, steps, stopReason: 'paused' })
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
      return ok({ finalStatus: state.status, steps, stopReason: 'awaiting-clarification' })
    }

    // ── S-HUMAN_REVIEW：等人工裁决或人工裁决 TTL 到期(11-05-human-review-ttl)──
    //
    // 与澄清分支同构:claim 本 task 的到期 human_review_ttl → advance(TimerFired)
    // → T-028 → S-ABANDONED(T-028 的 ConsumeTimer 在同一事务里置 fired)。
    // 未到期 → 停(awaiting-human);人的裁决由 `keel decide` / 控制台注入事件。
    //
    // claim 的 SQL 带 `JOIN task ... status='S-HUMAN_REVIEW'`,状态不匹配的
    // 残留行永远不会被 claim —— 失效模式只是「一行不动的数据」。
    if (state.status === 'S-HUMAN_REVIEW') {
      const due = await claimDueTimers(deps.now(), {
        taskId,
        kind: 'human_review_ttl',
        limit: 1,
      })
      if (due.length > 0) {
        const adv = await deps.driver.advance(
          taskId,
          { type: 'TimerFired', timer: 'human_review_ttl' },
          deps.now(),
        )
        if (!adv.ok) return err(adv.error)
        steps.push(record(state.status, adv, null, '人工裁决 TTL 到期 → 弃单'))
        continue
      }
      return ok({ finalStatus: state.status, steps, stopReason: 'awaiting-human' })
    }

    // ── S-PR_OPEN：等外部 CI ──
    if (state.status === 'S-PR_OPEN') {
      if (opts.ci !== undefined) {
        if (deps.workspace.mode !== 'worktree') {
          return err(makeError('WORKSPACE_ERROR', '真实 CI 需要 worktree 模式才能读取 head SHA'))
        }
        const sha = await deps.workspace.git.headSha(deps.workspace.project, taskId)
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
          { type: ciResult.value === 'passed' ? 'CIPassed' : 'CIFailed', source: 'github' },
          deps.now(),
        )
        if (!adv.ok) return err(adv.error)
        steps.push(record(state.status, adv, null, `外部 CI（GitHub）：${ciResult.value}`))
        continue
      }
      if (opts.externalCi === undefined) {
        return ok({ finalStatus: state.status, steps, stopReason: 'awaiting-external-ci' })
      }
      const ci = await opts.externalCi(taskId)
      const adv = await deps.driver.advance(
        taskId,
        { type: ci === 'passed' ? 'CIPassed' : 'CIFailed', source: 'simulated' },
        deps.now(),
      )
      if (!adv.ok) return err(adv.error)
      steps.push(record(state.status, adv, null, `外部 CI（模拟）：${ci}`))
      continue
    }

    // ── 阶段态：找 PENDING run 执行 ──
    const pending = await readPendingRun(taskId)
    if (pending === null) {
      // 没有待执行的 run。这里必须分清「设计内等待」与「卡住」——
      // 旧实现两者返回同一个 ok，于是派发丢失会以「退出码 0、跑完了」的样子出现
      // （2026-10-26 的 firstRun 撞键 bug 正是被这层兜住，查了两轮才定位到上游）。
      //
      // 判据只读证据，不按状态归类：人工撤回（R-010）也会让阶段态没有待执行 run，
      // 而那是设计内的停 —— 所以要看最近一次 run 到底发生了什么。
      if (isStageStatus(state.status)) {
        const latest = await readLatestRun(taskId)
        if (latest?.status === 'CANCELLED') {
          // 人工撤回：不重试、不派发；等 C-005 恢复后从当前状态继续
          return ok({ finalStatus: state.status, steps, stopReason: 'cancelled' })
        }
        return err(stalledError(state.status, latest))
      }
      // 非阶段态走到这里说明有状态缺少自己的分支（闸口态与终态都应更早 return）。
      // 新增关口态时必须在这里显式表态 —— 静默沿用「成功收工」正是本任务要消灭的东西。
      throw new Error(`不可达：${state.status} 应在更早的分支处理`)
    }

    const executed = await executeRun(taskId, pending, deps, ctxBuilder)
    if (!executed.ok) {
      const runErr = executed.error
      // N4:claim 拒绝时 run 仍是 PENDING —— 不流转、不标 FAILED,停下等名额。
      // post-claim 的 CONFLICT(如 artifact 版本冲突)则 run 已是 RUNNING,
      // 必须走 R1 离开 RUNNING,否则 Task 卡死且无 PENDING。
      if (runErr.kind === 'CONFLICT') {
        const stillPending = await asRole('keel_control', (c) =>
          c.query<{ status: string }>(`SELECT status FROM run WHERE id=$1`, [pending.id]),
        )
        if (stillPending.rows[0]?.status === 'PENDING') return err(runErr)
      }
      // R1(issue #23):失败是状态流转,不是编排器异常 ——
      // 标 run 状态 + emit 失败事件,交给 T-030(重试)/T-031(升人工)。
      const next = await failRunAndAdvance(
        taskId,
        pending,
        runErr,
        executed.usage,
        deps,
        state,
        steps,
        executed.stall ?? null,
      )
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
      await synthesizeCapabilityRequest(taskId, pending.id, capability, deps.now())
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
        return ok({ finalStatus: state.status, steps, stopReason: 'capability-denied' })
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

/**
 * run 执行结果。失败分支带**已累计的 usage** —— R-007 各轮的钱在失败/超时前
 * 已经花掉，调用方（failRunAndAdvance）必须把它写回 run 行并核算熔断（C1/C-002）。
 */
type ExecOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly error: KeelError
      readonly usage: Usage
      /** RUN_STALLED 时带上 supervisor 的判定证据（落事件 payload） */
      readonly stall?: StallEvidence
    }

/** 跑一个 run：认领（PENDING→RUNNING）→ 造 Context → 真实 session → 校验落库 → 终态 */
async function executeRun(
  taskId: string,
  pending: { id: string; stage: Stage; role: RoleId; attempt: number },
  deps: OrchestratorDeps,
  ctxBuilder: FactPlaneContextBuilder,
): Promise<ExecOutcome> {
  // ── N3/N4：开始执行前先认领 ──
  //
  // PENDING→RUNNING 乐观锁与全局 RUNNING 上限检查在**同一事务**内
  // （claimRunForExecution）。认领失败返回可重试 CONFLICT 并向上传播 ——
  // 编排器因此停下而不是静默吞掉（docs/08-cross-cutting.md §4.4 N4）。
  //
  // 身份也在认领时落库（R5）：进程死掉后由 timer worker / patrol 收割的 run
  // 拿不到 adapter，若等到结算才写，最需要追查的场景反而会是 NULL。
  // 认领 → 执行 → 成功元数据这条链路只在这里 describe 一次，后面复用同一个值；
  // 失败结算在 failRunAndAdvance 里再取一次同一 adapter 的值（同进程同源，结果相同）。
  const descriptor = deps.adapter.describe()
  const claimed = await asRole('keel_control', (c) =>
    claimRunForExecution(c, pending.id, DEFAULT_MAX_RUNNING_RUNS, {
      harnessId: descriptor.harness_id,
      harnessTier: descriptor.tier,
    }),
  )
  if (!claimed.ok) return { ok: false, error: claimed.error, usage: ZERO_USAGE }

  // 失败时由调用方 failRunAndAdvance 离开 RUNNING(一次写 + R1 流转)。
  // 不再先 markRunFailed 再覆写 —— 双写之间崩溃会留下「FAILED 却无失败事件」。
  return executeClaimedRun(taskId, pending, deps, ctxBuilder, descriptor)
}

/** 认领之后的执行主体。失败返回 err 后由 failRunAndAdvance 落终态并流转 */
async function executeClaimedRun(
  taskId: string,
  pending: { id: string; stage: Stage; role: RoleId; attempt: number },
  deps: OrchestratorDeps,
  ctxBuilder: FactPlaneContextBuilder,
  descriptor: HarnessDescriptor,
): Promise<ExecOutcome> {
  const ctx = await asRole('keel_control', (c) =>
    ctxBuilder.build(c, {
      task_id: taskId,
      run_id: pending.id,
      role: pending.role,
      stage: pending.stage,
      budget_tokens: 40_000,
    }),
  )
  if (!ctx.ok) return { ok: false, error: ctx.error, usage: ZERO_USAGE }

  const expect = expectedArtifact(pending.stage)

  // rfc_draft 才需要:把反馈里显式声明的约束读出来,写进提示词。
  // 只有这一阶段产 rfc,也只有 rfc 会被 4b 核对(validate.ts 第 4b 步)。
  const declared =
    pending.stage === 'rfc_draft'
      ? await asRole('keel_control', (c) => loadDeclaredPolicyFacts(c, taskId))
      : {}

  const place = await resolveWorkspace(taskId, deps.workspace)
  if (!place.ok) return { ok: false, error: place.error, usage: ZERO_USAGE }

  // descriptor 在认领前取一次并写入 run 行（claim 的身份列）——
  // 这里复用同一个值，不在执行主体里重新 describe。

  // ── 模型解析：认领之后、spawn 之前 ──
  //
  // 解析失败就不 spawn（R6）。同一个值同时进 runSpec.model 与
  // run.requested_model —— 两处各算一次会出现「库里记 A、实际跑 B」，
  // 而两边各自看起来都自洽（R5）。
  const requested = resolveRequestedModel(pending.stage, descriptor.harness_id, deps)
  if (!requested.ok) return { ok: false, error: requested.error, usage: ZERO_USAGE }
  await asRole('keel_control', (c) =>
    c.query('UPDATE run SET requested_model=$2 WHERE id=$1', [
      pending.id,
      requested.value.requestedModel,
    ]),
  )

  const mode = livenessMode()
  // 无进展信号的 harness 只保留硬上限；human 两者都关。
  const policy = policyFor({
    stage: pending.stage,
    isHuman: descriptor.harness_id === 'human',
    hasProgressSignal: descriptor.capabilities.includes('CAP-STREAM'),
  })
  // 方案 B(issue #26):run 级墙钟上限。
  // progress 模式用 stage hard cap；wallclock 模式保持旧的全局 180s。
  // 显式 --wall-clock 覆盖两者（R6 逃生阀）。
  const explicitWallClock = deps.wallClockS !== undefined
  const wallClockS = runWallClockS(mode, deps.wallClockS, policy)
  if (wallClockS > 0) {
    await createRunWallClockTimer(taskId, pending.id, wallClockS, deps.now())
  }

  /** supervisor 判定 stalled 时的证据；失败路径落进 RunStalled 事件 */
  let stallEvidence: StallEvidence | null = null

  const stagePermissions = resolveStagePermissions(pending, descriptor, deps)
  if (!stagePermissions.ok) {
    return { ok: false, error: stagePermissions.error, usage: ZERO_USAGE }
  }

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
        permissions: stagePermissions.value,
        limits: { wall_clock_s: wallClockS, budget_usd: null, max_turns: 8 },
        // 与 run.requested_model 同源（见上方 resolveRequestedModel）；
        // claude 不消费这个字段，它的模型来自 adapter 构造参数。
        ...(requested.value.spawnModel === undefined ? {} : { model: requested.value.spawnModel }),
      },
      adapter: deps.adapter,
      expect,
    },
    promptFor(pending.stage, pending.id, declared),
    {
      // #1-02:capability_request 等需要授权的 Proposal 由同一 Policy 实例裁决
      policy: deps.driver.policyEngine,
      now: deps.now(),
      // wallclock 模式：旧的全局 watchdog；progress 模式默认由 supervisor
      // 判沉默、DB timer 兜硬上限。显式 --wall-clock 是逃生阀：
      // 两种模式都额外挂进程内 watchdog，保证没有 timer-worker 也按时收敛。
      ...((mode === 'wallclock' || explicitWallClock) && wallClockS > 0
        ? { wallClockMs: wallClockS * 1000 }
        : {}),
      ...(mode === 'progress'
        ? {
            liveness: {
              policy,
              wallNow: deps.now,
              ...(deps.livenessStore === undefined ? {} : { store: deps.livenessStore }),
              ...(deps.monotonicNow === undefined ? {} : { monotonicNow: deps.monotonicNow }),
              ...(deps.livenessCheckIntervalMs === undefined
                ? {}
                : { checkIntervalMs: deps.livenessCheckIntervalMs }),
              ...(deps.ownerHeartbeatMs === undefined
                ? {}
                : { ownerHeartbeatMs: deps.ownerHeartbeatMs }),
              onStall: (evidence) => {
                stallEvidence = evidence
              },
            },
          }
        : {}),
      // develop 的「真改了吗」闸门必须发生在 run 置 SUCCEEDED 之前 ——
      // 否则闸门失败时 run 已经是 SUCCEEDED，只能留下假成功。
      preCommitGate: ({ diff }) => {
        // 没有证据 ≠ 有证据表明没干活：采集失败（null）放行，事件里如实记录。
        if (pending.stage !== 'develop' || diff === null) return null
        if (diff.files_changed.length > 0 || diff.commits.length > 0) return null
        return makeError(
          'PROTOCOL_ERROR',
          'develop 声称 implemented，但工作区在 git 上没有任何改动（0 文件、0 提交）。' +
            '这一轮不算成功（可重试，T-030）：要么真的没干活，要么改动落在工作区之外。',
        )
      },
    },
  )
  // 失败也把累计 usage 带给调用方 —— 失败/超时的 run 花的钱与成功的一样真实
  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error,
      usage: outcome.usage,
      ...(stallEvidence === null ? {} : { stall: stallEvidence }),
    }
  }

  // develop 的「真改了吗」闸门已在 pipeline 的 preCommitGate 里判定 ——
  // 必须在 run 置 SUCCEEDED 之前，见 runSessionUntilValid 的围栏注释。
  const diff = outcome.value.diff

  // 谁执行了这个 run 是事实，记在 run 行上（O 可观测 + ADR-0005）——
  // Human L0 e2e 据此断言「L0 路径真的被执行过」，而不是靠桩自己声称。
  //
  // 成本一并写回（C1）：usage 是全部轮次的累计值，三态 cost_basis 原样落库 ——
  // 没上报就是 null + 'unavailable'，禁止用 0 冒充（docs/08-cross-cutting.md §3.1）。
  //
  // 熔断检查在**同一事务**内：写回与核算之间不留窗口，
  // 崩溃重启后不会出现「成本已入账但该暂停的 Task 还在跑」。
  const usage = outcome.value.usage
  const diffPayload = buildDiffPayload(
    pending.stage,
    pending.attempt,
    diff,
    outcome.value.diff_error,
  )
  const metadata = await asRole('keel_control', async (c) => {
    const now = deps.now()
    // 围栏：run 必须已由 pipeline 在提交 artifact 的**同一事务**里置为 SUCCEEDED。
    // 0 行说明 run 已被巡检 / 人工收走 —— 这里不得再写任何成功事实。
    const updated = await c.query(
      `UPDATE run SET harness_id=$2, harness_tier=$3,
              tokens_in=$4, tokens_out=$5, cost_usd=$6, cost_basis=$7
       WHERE id=$1 AND status='SUCCEEDED'`,
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
    if ((updated.rowCount ?? 0) === 0) return { ok: false as const }
    // 工作区改动的观测记录 —— 与 run 元数据**同事务**：
    // 分开写会出现「run 已 SUCCEEDED 但事件没落」或反之的半截事实。
    // 载体选 event 而不是 artifact：这是每次 run 追加的观测，不是要冻结的决策（无版本链）。
    const traceId = await ensureTraceId(c, taskId, now)
    await c.query(
      `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
       VALUES ($1,$2,'WorkspaceDiffCollected',$3::jsonb,$4,$5)`,
      [taskId, pending.id, JSON.stringify(diffPayload), traceId, now],
    )
    await checkBudgetFuse(c, taskId, now)
    return { ok: true as const }
  })
  if (!metadata.ok) {
    await cancelRunWallClockTimer(pending.id)
    return {
      ok: false,
      error: makeError(
        'PROTOCOL_ERROR',
        `run ${pending.id} 不是 SUCCEEDED，拒绝写成功元数据（可能已被巡检收割）`,
      ),
      usage,
    }
  }
  // run 已终态:墙钟 timer 不再需要(方案 B,防残留误触发)
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
    // 此处 run 已 SUCCEEDED、成本已入账 —— usage 给 ZERO 防止二次记账
    // (failRunAndAdvance 的 UPDATE 也有 status='RUNNING' 守卫,双保险)
    if (!sha.ok) return { ok: false, error: sha.error, usage: ZERO_USAGE }
  }

  return { ok: true }
}

/** 一次 run 的模型解析结果。`spawnModel` 只对 omp 有值（进入 RunSpec） */
interface RequestedRunModel {
  readonly spawnModel: string | undefined
  readonly requestedModel: string | null
}

/**
 * 解析本次 run 的模型。
 *
 * omp 按 stage 走 `resolveStageModel`（profile / allowlist / 显式覆盖）。
 * 其余 harness 不改行为：claude 的模型来自构造参数（未显式指定就不传
 * `--model`），RunSpec 不带 model；`requested_model` 只记录显式 override
 * （可能为 NULL）—— 那正是它实际 spawn 的模型来源。
 */
function legacyStagePermissions(stage: Stage): {
  readonly allowed_tools: readonly string[]
  readonly mode: 'auto'
} {
  return stage === 'develop'
    ? { allowed_tools: ['read', 'write'], mode: 'auto' }
    : { allowed_tools: ['read'], mode: 'auto' }
}

function resolveStagePermissions(
  pending: { readonly stage: Stage },
  descriptor: HarnessDescriptor,
  deps: OrchestratorDeps,
): Result<{
  readonly allowed_tools: readonly string[]
  readonly mode: 'auto' | 'deny_unlisted'
}> {
  const harness = descriptor.harness_id === 'claude' ? 'claude-code' : descriptor.harness_id
  if (deps.toolPolicy === undefined || descriptor.tool_inventory === undefined) {
    if (harness === 'pi' || harness === 'claude-code') {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          `${harness} 必须提供 jstack 工具策略和真实 tool_inventory，` +
            '不会静默退化为统一 read/write。运行 jstack tools export 并设置 KEEL_TOOL_POLICY。',
        ),
      )
    }
    return ok(legacyStagePermissions(pending.stage))
  }
  const resolved = resolveKeelStageToolPolicy(deps.toolPolicy, pending.stage, {
    harness,
    inventory: descriptor.tool_inventory,
    ...(deps.toolPolicyAllowShellFallback === true ? { allowShellFallback: true } : {}),
  })
  if (!resolved.ok) return resolved
  if (resolved.value.degradations.length > 0) {
    console.warn(
      `keel: ${resolved.value.profile}@${harness} 工具降级：${resolved.value.degradations
        .map((item) => `${item.capability}→${item.fallback_native}`)
        .join(', ')}`,
    )
  }
  return ok(resolved.value.permissions)
}

function resolveRequestedModel(
  stage: Stage,
  harnessId: string,
  deps: OrchestratorDeps,
): Result<RequestedRunModel> {
  if (harnessId !== 'omp') {
    return ok({ spawnModel: undefined, requestedModel: deps.modelOverride ?? null })
  }
  const resolved = resolveStageModel({
    stage,
    override: deps.modelOverride,
    profile: deps.modelProfile ?? 'default',
    allowlist: deps.modelAllowlist ?? [],
  })
  if (!resolved.ok) return resolved
  return ok({ spawnModel: resolved.value, requestedModel: resolved.value })
}

/**
 * patch 体积上限：超出即截断。
 * 截断必须**如实标注**（`patch_truncated` + `patch_chars` 记截断前长度）——
 * 一份被静默截断的 diff 会让 QA 以为自己看到了全部改动，比不给更糟。
 */
const PATCH_LIMIT = 16_000

/**
 * `WorkspaceDiffCollected` 的 payload。
 *
 * 读者是 ContextBuilder 的 `'diff'` section（qa / review 配方）与事后复盘：
 * 「这个 run 到底改了哪些文件」必须能从事件里独立答出来，不依赖模型自述。
 */
interface DiffCollectedPayload {
  readonly stage: Stage
  readonly attempt: number
  /** false = 采集失败（不是「没有改动」） */
  readonly collected: boolean
  readonly collect_error: string | null
  readonly files_changed: readonly { readonly path: string; readonly change: string }[]
  readonly commits: readonly string[]
  /** null = 未知。不许用 false 冒充「干净」 */
  readonly is_dirty: boolean | null
  readonly patch: string | null
  readonly patch_chars: number | null
  readonly patch_truncated: boolean
}

function buildDiffPayload(
  stage: Stage,
  attempt: number,
  diff: WorkspaceDiff | null,
  collectError: string | null,
): DiffCollectedPayload {
  if (diff === null) {
    return {
      stage,
      attempt,
      collected: false,
      collect_error: collectError ?? '适配器未提供工作区读取结果',
      files_changed: [],
      commits: [],
      is_dirty: null,
      patch: null,
      patch_chars: null,
      patch_truncated: false,
    }
  }

  const full = diff.patch ?? ''
  const truncated = full.length > PATCH_LIMIT
  return {
    stage,
    attempt,
    collected: true,
    collect_error: null,
    files_changed: diff.files_changed.map((f) => ({ path: f.path, change: f.change })),
    commits: [...diff.commits],
    is_dirty: diff.is_dirty,
    patch: full === '' ? null : truncated ? full.slice(0, PATCH_LIMIT) : full,
    patch_chars: full.length,
    patch_truncated: truncated,
  }
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
  const wt = await ws.git.ensureWorktree(ws.project, taskId)
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

/**
 * 最近一次 run（不分阶段）。
 *
 * 停止原因判据要回答的是「上一次派发到底发生了什么」，而不是「某个阶段跑到第几轮」——
 * 所以按开始时间取最新一行（PENDING 从未开始过，`started_at` 为 null，排最后）。
 */
async function readLatestRun(
  taskId: string,
): Promise<{ stage: Stage; attempt: number; status: string } | null> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ stage: Stage; attempt: number; status: string }>(
      `SELECT stage, attempt, status FROM run WHERE task_id=$1
       ORDER BY started_at DESC NULLS LAST, attempt DESC LIMIT 1`,
      [taskId],
    ),
  )
  return r.rows[0] ?? null
}

/**
 * 卡住时的错误。
 *
 * detail 要能直接回答三个问题：停在哪个状态、上一次派发是什么、下一步查什么。
 * 只报「没有待执行的 run」等于把定位成本原封不动转给下一个人。
 *
 * kind 用 NOT_FOUND 而不是新增 kind：本错误从不落 `run.error_kind`，
 * 而新增 kind 要同步改 ERROR_KINDS / RETRYABLE / docs/05-contracts/README.md 三处
 * （同类先例见 execution/session/manager.ts 对 CANCELLED 的处理）。
 * 语义上「本该存在的待执行 run 不存在」与 NOT_FOUND 的定义一致，且 retryable=false
 * 正确 —— 对同一状态再跑一次，run 不会自己出现。
 */
function stalledError(
  status: TaskStatus,
  latest: { stage: Stage; attempt: number; status: string } | null,
): KeelError {
  const what =
    latest === null
      ? '该 task 从未创建过任何 run'
      : `最近一次 run 是 ${latest.stage}/${latest.attempt}（${latest.status}）`
  return makeError(
    'NOT_FOUND',
    `停在 ${status}，但没有待执行的 run —— ${what}。` +
      '阶段态本该有 PENDING run：要么上一轮转移没有建出来（查 SideEffectSkipped 的 ' +
      'existing_status：PENDING/RUNNING 是真重放，终态说明派发丢失），' +
      '要么那条 run 仍被占着没人推进。编排器不会自动重派 —— 确认原因后由人决定是否恢复。',
  )
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
  usage: Usage,
  deps: OrchestratorDeps,
  state: { status: TaskStatus },
  steps: StepRecord[],
  stall: StallEvidence | null = null,
): Promise<'advanced' | 'stopped-cancelled' | 'error'> {
  // 失败类型 → run 状态:超时(含无进展) / 人工撤回 / 其他(重试类)
  const status =
    runErr.kind === 'RUN_TIMEOUT' || runErr.kind === 'RUN_STALLED'
      ? 'TIMEOUT'
      : runErr.kind === 'RUN_CANCELLED'
        ? 'CANCELLED'
        : 'FAILED'

  // 失败/超时/撤回也要成本入账(C1):R-007 各轮的 usage 已在 pipeline 累计,
  // 花掉的钱不因 run 失败而消失。三态 cost_basis 原样落库(禁止用 0 冒充
  // unavailable),熔断检查在**同一事务**内 —— 与成功路径同一纪律。
  // 否则最烧钱的场景(R-007 回灌 × T-030 重试,每轮都失败)对 C-002 完全失明:
  // 每次重试都白烧一整个 run 的预算,熔断永远看不到。
  //
  // 谁执行了这个 run 与终态**同事务同语句**落库:最需要事后追查的恰恰是
  // 失败 run,而那时进程日志已经不在了。与成功路径(SUCCEEDED 围栏那条
  // UPDATE)同源,都取 deps.adapter.describe() —— 不在别处另算。
  // 身份其实已在 claim 时写进 run 行(limits.ts,R5),这里重复写同一个值是
  // 无害兜底:覆盖 claim 之前的旧数据 / 异常路径,保证结算行自带身份。
  // 围栏不变:仍以 status='RUNNING' 为条件,0 行时整条语句什么都不写。
  const descriptor = deps.adapter.describe()
  const settled = await asRole('keel_control', async (c) => {
    const updated = await c.query(
      `UPDATE run SET status=$2, ended_at=$3, error_kind=$4, error_detail=$5,
              harness_id=$6, harness_tier=$7,
              tokens_in=$8, tokens_out=$9, cost_usd=$10, cost_basis=$11
       WHERE id=$1 AND status='RUNNING'`,
      [
        pending.id,
        status,
        deps.now(),
        runErr.kind,
        runErr.detail,
        descriptor.harness_id,
        descriptor.tier,
        usage.tokens_in,
        usage.tokens_out,
        usage.cost_usd,
        usage.cost_basis,
      ],
    )
    // run 已被巡检 / 人工终结：本次失败不能再入账，也不能再推进转移。
    // 否则巡检收割后 zombie 会重复 emit 一次 RunTimeout / RunFailed。
    if ((updated.rowCount ?? 0) === 0) return false

    // 决策证据与终态同事务：RunStalled 不只是「run 结束了」，
    // 还要能回答当时沉默了多久、最后一条进展是什么。
    if (runErr.kind === 'RUN_STALLED') {
      const now = deps.now()
      const traceId = await ensureTraceId(c, taskId, now)
      await c.query(
        `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
         VALUES ($1,$2,'RunStalled',$3::jsonb,$4,$5)`,
        [
          taskId,
          pending.id,
          JSON.stringify({
            silence_ms: stall?.silenceMs ?? null,
            last_progress_at: stall?.lastProgressAt ?? null,
            last_kind: stall?.lastKind ?? null,
            owner_heartbeat_at: stall?.ownerHeartbeatAt ?? null,
            source: stall?.source ?? 'supervisor',
            orphan_killed: stall?.orphanKilled ?? null,
          }),
          traceId,
          now,
        ],
      )
    }

    await checkBudgetFuse(c, taskId, deps.now())
    return true
  })
  // run 已终态:墙钟 timer 不再需要(方案 B,防残留误触发)
  await cancelRunWallClockTimer(pending.id)

  // 已由他人终结：不 emit、不 advance，也不按 CANCELLED 返回 stopped —— 直接收手。
  if (!settled) return 'advanced'

  // 人工撤回:不重试(R-010)。run 已脱离 PENDING,下一轮无 PENDING → 停。
  if (status === 'CANCELLED') {
    return 'stopped-cancelled'
  }

  // 无进展与超时都落 TIMEOUT，但事件类型必须可区分：
  // 「卡住」和「跑太久」是两种可观察的失败，消费方据此做不同诊断。
  const event =
    runErr.kind === 'RUN_STALLED'
      ? ({ type: 'RunStalled', stage: pending.stage } as const)
      : status === 'TIMEOUT'
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
  now: string,
): Promise<void> {
  await asRole('keel_control', async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM artifact WHERE task_id=$1 AND produced_by_run=$2 AND kind='capability_request'`,
      [taskId, producedByRun],
    )
    if (existing.rows.length > 0) return // 已合成,幂等

    const traceId = await ensureTraceId(c, taskId, now)
    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
       VALUES ($1,$2,'ProposalAccepted',$3::jsonb,$4,$5) RETURNING seq`,
      [
        taskId,
        producedByRun,
        JSON.stringify({ kind: 'capability_request', key: 'latest' }),
        traceId,
        now,
      ],
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

    const traceId = await ensureTraceId(c, taskId, now)
    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
       VALUES ($1,$2,'ProposalAccepted',$3::jsonb,$4,$5) RETURNING seq`,
      [taskId, producedByRun, JSON.stringify({ kind: 'state', key: '' }), traceId, now],
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
