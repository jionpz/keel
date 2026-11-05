/**
 * Proposal 流水线 —— 属 Control Plane。
 *
 * 编排 R-007 回灌循环：
 *
 *   Session 产出 → 五步校验 → 通过则提交为 Artifact
 *                           → 不通过则把理由回灌，让它改
 *
 * **校验失败不等于 Run 失败**（docs/04-state-machine.md §4.2）：
 * 结构化产物写错格式很常见，让它改一次比重跑整个阶段便宜一个数量级。
 * 只有连续 max_proposal_retries 次仍不合格才判 Run FAILED（R-006）。
 */

import { randomUUID } from 'node:crypto'
import type { PersistedArtifactKind } from '../../contracts/artifact-store.js'
import { type KeelError, makeError } from '../../contracts/errors.js'
import type { WorkspaceDiff } from '../../contracts/harness-adapter.js'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import type { Stage, Usage } from '../../contracts/types.js'
import type {
  HarnessSessionManager,
  SessionHandle,
  SessionSpec,
} from '../../execution/session/manager.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
import { ensureTraceId } from '../../fact/trace.js'
import type { LivenessPolicy } from '../liveness/policy.js'
import type { LivenessStore } from '../liveness/store.js'
import { type StallEvidence, StallSupervisor } from '../liveness/supervisor.js'
import { validateProposal, violationsToFeedback } from './validate.js'

/** 进程内 liveness 的参数；不传 = 保持旧的纯墙钟行为 */
export interface PipelineLivenessOptions {
  readonly policy: LivenessPolicy
  readonly wallNow: () => string
  readonly store?: LivenessStore
  readonly monotonicNow?: () => number
  readonly checkIntervalMs?: number
  readonly ownerHeartbeatMs?: number
  readonly onStall?: (evidence: StallEvidence) => void
}

export interface PipelineOptions {
  /** 连续被拒多少次后判 Run 失败（R-006）。默认 3 */
  readonly maxProposalRetries?: number
  /** 校验 Policy 用（#1-02）。缺省 = 不校验需要授权的 Proposal？不 —— 缺省即无裁决，直接拒收 */
  readonly policy?: PolicyEngine
  /**
   * 事件与求值时间。**必传** —— 重放不读时钟(ADR-0003,R2)。
   * 缺失时 requireNow 抛错,不静默回落 DB now()。
   */
  readonly now?: string
  /**
   * 墙钟超时(方案 B,issue #26):会话总时长上限,到期 interrupt(handle,'timeout')
   * → adapter 收敛 TIMEOUT(R-009)。可选;缺省不打断(R-007 行为不变)。
   */
  readonly wallClockMs?: number
  /**
   * 提交前闸门：在提案通过校验、但**尚未**把 run 置为 SUCCEEDED / 落 artifact 之前调用。
   *
   * 阶段专属的成功条件（例如 develop 必须真的改过工作区）必须在这里判定：
   * `asRole` 正常返回即 COMMIT，若先置 SUCCEEDED 再由调用方判失败，
   * 就会留下「run 成功、artifact 已提交」的假成功。
   * 返回 `null` 放行；返回错误则整个 run 失败，且不触碰 run 状态。
   */
  readonly preCommitGate?: (candidate: PreCommitCandidate) => KeelError | null
  /**
   * 进程内沉默监管。传入后由 supervisor 负责「是否还在动」；
   * 默认的 stage 硬上限由 DB timer 负责，因此调用方不再传 `wallClockMs`。
   * 显式 `--wall-clock` 覆盖时两者可同时挂载：沉默判定看进展，总时长看显式值。
   */
  readonly liveness?: PipelineLivenessOptions
}

/** 提交前闸门看到的观测值。diff 的语义见 `PipelineOutcome.diff`。 */
export interface PreCommitCandidate {
  readonly stage: Stage
  readonly diff: WorkspaceDiff | null
  readonly diff_error: string | null
  readonly usage: Usage
}

/** now 缺失即编程错误:事件时间是重放依据,不能由 DB 时钟决定 */
function requireNow(opts: PipelineOptions): string {
  if (opts.now === undefined) {
    throw new Error('pipeline 需要注入 now —— 重放不读时钟(ADR-0003),缺失即抛错')
  }
  return opts.now
}

export interface PipelineOutcome {
  readonly committed: boolean
  /** 落库的 artifact id */
  readonly artifactRef: string | null
  /** 实际用了几轮 */
  readonly attempts: number
  /** 每轮被拒的理由，供诊断 */
  readonly rejections: readonly (readonly string[])[]
  /**
   * 全部轮次累计的用量 —— R-007 回灌的每一轮都是一次真实的 Adapter 调用，
   * 都花了钱。只报最后一轮会系统性低估成本（C1，docs/08-cross-cutting.md §3）。
   */
  readonly usage: Usage
  /**
   * **最后一轮**由 git 观测到的工作区改动（`SessionManager` 采集）。
   *
   * 不回退到更早轮次：回灌的各轮都在同一个工作区上累加，最后一轮已经包含前面
   * 的结果；而「最后一轮测不出来」如果拿前面某一轮顶上，会让「改动被撤销回去」
   * 这种情况看起来像还有改动 —— 判定必须只看最后一轮的观测值。
   * null = 采集失败（未测到），不是「没有改动」（那是空 diff）。
   */
  readonly diff: WorkspaceDiff | null
  /** 采集失败的原因；成功时为 null */
  readonly diff_error: string | null
}

/**
 * 流水线结果。与 `Result<PipelineOutcome>` 的唯一差别：失败分支**也带累计 usage**。
 *
 * R-007 回灌的每一轮都是真实的 Adapter 调用，重试耗尽（R-006）或会话中断时
 * 钱已经花了 —— 失败时丢弃 usage 会让最烧钱的场景（R-007 重试 × T-030 重跑）
 * 对成本核算（C1）与预算熔断（C-002）完全失明。
 */
export type PipelineResult =
  | { readonly ok: true; readonly value: PipelineOutcome }
  | { readonly ok: false; readonly error: KeelError; readonly usage: Usage }

/** 初始累计值：什么都还没上报。null 而非 0 —— 两者在核算里是不同的事实 */
export const ZERO_USAGE: Usage = {
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  cost_basis: 'unavailable',
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

/**
 * 合并两轮的成本口径。
 *
 * 同一个 Run 的所有轮次走同一个 Adapter，口径本应同质；
 * 这里的规则只处理「初始 unavailable 累计值 + 首个真实上报」与
 * 万一混入的异质口径：billed 只有在全程 billed 时才成立，
 * 掺入任何 estimated 都会让总额降级为 estimated（不夸大精确度）。
 */
function mergeBasis(a: Usage['cost_basis'], b: Usage['cost_basis']): Usage['cost_basis'] {
  if (a === 'unavailable') return b
  if (b === 'unavailable') return a
  return a === 'billed' && b === 'billed' ? 'billed' : 'estimated'
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    tokens_in: addNullable(a.tokens_in, b.tokens_in),
    tokens_out: addNullable(a.tokens_out, b.tokens_out),
    cost_usd: addNullable(a.cost_usd, b.cost_usd),
    cost_basis: mergeBasis(a.cost_basis, b.cost_basis),
  }
}

/**
 * 跑一个 Session 直到它产出合法提案，或重试耗尽。
 *
 * 注意本函数**跨平面**：它在 Control Plane，但会调用 Execution Plane 的
 * SessionManager。这是合法的 —— Control 的硬约束是「绝不**直接**调用 LLM」，
 * 而不是「不得触发执行」。真正的 LLM 调用发生在 Adapter 里。
 *
 * `src/control/driver` 被禁止依赖 execution（它是转移执行器，更纯），
 * 但本模块不受该限制。
 */
export async function runSessionUntilValid(
  sessions: HarnessSessionManager,
  spec: SessionSpec,
  prompt: string,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const maxRetries = opts.maxProposalRetries ?? 3
  const rejections: string[][] = []
  let usage: Usage = ZERO_USAGE
  /** 最后一轮的采集结果；每轮覆盖，不回退（见 PipelineOutcome.diff） */
  let diff: WorkspaceDiff | null = null
  let diffError: string | null = null

  const liveness = opts.liveness
  const supervisor =
    liveness === undefined
      ? null
      : new StallSupervisor({
          sessions,
          policy: liveness.policy,
          now: liveness.monotonicNow ?? (() => performance.now()),
          wallNow: liveness.wallNow,
          ...(liveness.store === undefined ? {} : { store: liveness.store }),
          ...(liveness.checkIntervalMs === undefined
            ? {}
            : { checkIntervalMs: liveness.checkIntervalMs }),
          ...(liveness.ownerHeartbeatMs === undefined
            ? {}
            : { ownerHeartbeatMs: liveness.ownerHeartbeatMs }),
          ...(liveness.onStall === undefined ? {} : { onStall: liveness.onStall }),
        })

  // onProgress 必须随 open 一起登记 —— advance() 时 manager 才会把它交给 adapter
  const sessionSpec: SessionSpec =
    supervisor === null ? spec : { ...spec, onProgress: (event) => supervisor.noteProgress(event) }

  const opened = await sessions.open(sessionSpec)
  if (!opened.ok) return { ok: false, error: opened.error, usage }
  const handle: SessionHandle = opened.value

  // 硬上限的默认路径是 DB wall_clock timer（进程崩溃后仍能收割），
  // 因此 progress 模式默认不传 wallClockMs。显式 --wall-clock 覆盖时
  // 调用方会传值，这里额外挂一个进程内 watchdog —— 没有 timer-worker 也生效。
  const watchdog: ReturnType<typeof setTimeout> | undefined =
    opts.wallClockMs !== undefined && opts.wallClockMs > 0
      ? setTimeout(() => {
          void sessions.interrupt(handle, 'timeout')
        }, opts.wallClockMs)
      : undefined

  supervisor?.start(handle)

  try {
    let feedback: string[] = []

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const turn = await sessions.advance(handle, {
        text: prompt,
        ...(feedback.length > 0 ? { rejected_violations: feedback } : {}),
      })
      // 超时/取消/失败的轮次也要把**之前各轮**的累计带出去 ——
      // 出错的这一轮 Adapter 是否上报 usage 由它自己决定(OMP 中断时报 unavailable)
      if (!turn.ok) {
        // 控制面负责把「supervisor 判定 stalled」映射为 RUN_STALLED ——
        // adapter 只返回 TIMEOUT，不感知 liveness 语义。
        if (supervisor?.interruptedByStalled === true && turn.error.kind === 'RUN_TIMEOUT') {
          return {
            ok: false,
            error: makeError(
              'RUN_STALLED',
              `无进展超过阈值，已被 supervisor 中断：${turn.error.detail}`,
              turn.error,
            ),
            usage,
          }
        }
        return { ok: false, error: turn.error, usage }
      }
      usage = addUsage(usage, turn.value.usage)
      diff = turn.value.diff
      diffError = turn.value.diff_error

      // 提取失败也走回灌 —— 它和 schema 不合格是同一类问题：
      // 模型输出的形状不对，让它改比重跑整个阶段便宜
      if (turn.value.extract_error !== null) {
        feedback = [turn.value.extract_error]
        rejections.push(feedback)
        continue
      }

      const proposal = turn.value.proposals[0]
      if (proposal === undefined) {
        feedback = ['没有产出任何提案']
        rejections.push(feedback)
        continue
      }

      // 阶段专属成功条件必须先于围栏判定：asRole 正常返回即 COMMIT，
      // 一旦先置 SUCCEEDED，调用方的失败判定就只能留下假成功。
      const gate = opts.preCommitGate?.({
        stage: spec.runSpec.run.stage,
        diff,
        diff_error: diffError,
        usage,
      })
      if (gate !== null && gate !== undefined) return { ok: false, error: gate, usage }

      const runId = spec.runSpec.run.run_id
      const taskId = spec.runSpec.run.task_id

      const committed = await asRole('keel_control', async (c) => {
        // Policy 缺省视为「无裁决」——需要授权的 Proposal 会被第 4 步拒收
        const verdict = await validateProposal(proposal, {
          client: c,
          ...(opts.policy === undefined ? {} : { policy: opts.policy }),
          ...(opts.now === undefined ? {} : { now: opts.now }),
        })
        if (!verdict.accepted) return { ok: false as const, verdict }

        // 提案归属：跨 run / 跨 Task 的提案不得写进本 run 的事实
        if (proposal.produced_by_run !== runId || proposal.task_id !== taskId) {
          return {
            ok: false as const,
            fenceError: makeError(
              'PROTOCOL_ERROR',
              `提案归属不匹配：proposal.run=${proposal.produced_by_run} task=${proposal.task_id}，` +
                `当前 run=${runId} task=${taskId}`,
            ),
          }
        }

        // 围栏：只有仍处于 RUNNING 的 run 才能成功。
        // 巡检 / 人工撤回可能已把 run 收走；影响 0 行时本事务不得写任何东西。
        const fenced = await c.query(
          `UPDATE run SET status='SUCCEEDED', ended_at=$2
           WHERE id=$1 AND status='RUNNING'`,
          [runId, requireNow(opts)],
        )
        if ((fenced.rowCount ?? 0) === 0) {
          const current = await c.query<{ status: string }>(`SELECT status FROM run WHERE id=$1`, [
            runId,
          ])
          const status = current.rows[0]?.status
          return {
            ok: false as const,
            fenceError: makeError(
              status === 'CANCELLED' ? 'RUN_CANCELLED' : 'RUN_TIMEOUT',
              `run ${runId} 已不是 RUNNING（当前 ${status ?? '不存在'}），拒绝提交`,
            ),
          }
        }

        // 校验通过 → 落库。写 event 拿 seq，再提交 artifact（同事务）
        const traceId = await ensureTraceId(c, proposal.task_id, requireNow(opts))
        const ev = await c.query<{ seq: string }>(
          `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
           VALUES ($1,$2,'ProposalAccepted',$3::jsonb,$4,$5) RETURNING seq`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ kind: proposal.kind, key: proposal.key, attempt }),
            traceId,
            requireNow(opts),
          ],
        )
        const id = randomUUID()
        await commitArtifactOn(c, {
          id,
          taskId: proposal.task_id,
          kind: proposal.kind as PersistedArtifactKind,
          key: proposal.key,
          body: proposal.body,
          producedByRun: proposal.produced_by_run,
          committedAtSeq: Number(ev.rows[0]?.seq),
          supersedes: proposal.supersedes,
        })
        return { ok: true as const, id }
      })

      if (committed.ok) {
        return {
          ok: true,
          value: {
            committed: true,
            artifactRef: committed.id,
            attempts: attempt,
            rejections,
            usage,
            diff,
            diff_error: diffError,
          },
        }
      }

      // 围栏失败不是「提案不合格」：不得回灌让模型重写，run 已被他人终结。
      if ('fenceError' in committed) {
        return { ok: false, error: committed.fenceError, usage }
      }

      // R-007：把具体的拒绝理由回灌，让它改
      feedback = violationsToFeedback(committed.verdict.violations)
      rejections.push(feedback)

      await asRole('keel_control', async (c) => {
        const traceId = await ensureTraceId(c, proposal.task_id, requireNow(opts))
        await c.query(
          `INSERT INTO event (task_id, run_id, type, payload, trace_id, occurred_at)
           VALUES ($1,$2,'ProposalRejected',$3::jsonb,$4,$5)`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ attempt, violations: committed.verdict.violations }),
            traceId,
            requireNow(opts),
          ],
        )
      })
    }

    // R-006：连续失败到上限，判 Run 失败 —— 各轮累计的 usage 一并带出
    return {
      ok: false,
      error: makeError(
        'SCHEMA_VIOLATION',
        `连续 ${maxRetries} 次提案均未通过校验：${rejections.at(-1)?.join('；') ?? ''}`,
      ),
      usage,
    }
  } finally {
    clearTimeout(watchdog)
    supervisor?.stop()
    await sessions.close(handle)
  }
}
