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
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { Usage } from '../../contracts/types.js'
import type {
  HarnessSessionManager,
  SessionHandle,
  SessionSpec,
} from '../../execution/session/manager.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
import { ensureTraceId } from '../../fact/trace.js'
import { validateProposal, violationsToFeedback } from './validate.js'

export interface PipelineOptions {
  /** 连续被拒多少次后判 Run 失败（R-006）。默认 3 */
  readonly maxProposalRetries?: number
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
}

/** 初始累计值：什么都还没上报。null 而非 0 —— 两者在核算里是不同的事实 */
const ZERO_USAGE: Usage = {
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
): Promise<Result<PipelineOutcome>> {
  const maxRetries = opts.maxProposalRetries ?? 3
  const rejections: string[][] = []
  let usage: Usage = ZERO_USAGE

  const opened = await sessions.open(spec)
  if (!opened.ok) return err(opened.error)
  const handle: SessionHandle = opened.value

  try {
    let feedback: string[] = []

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const turn = await sessions.advance(handle, {
        text: prompt,
        ...(feedback.length > 0 ? { rejected_violations: feedback } : {}),
      })
      if (!turn.ok) return err(turn.error)
      usage = addUsage(usage, turn.value.usage)

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

      const committed = await asRole('keel_control', async (c) => {
        const verdict = await validateProposal(proposal, { client: c })
        if (!verdict.accepted) return { ok: false as const, verdict }

        // 校验通过 → 落库。写 event 拿 seq，再提交 artifact（同事务）
        const traceId = await ensureTraceId(c, proposal.task_id)
        const ev = await c.query<{ seq: string }>(
          `INSERT INTO event (task_id, run_id, type, payload, trace_id)
           VALUES ($1,$2,'ProposalAccepted',$3::jsonb,$4) RETURNING seq`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ kind: proposal.kind, key: proposal.key, attempt }),
            traceId,
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
        return ok({
          committed: true,
          artifactRef: committed.id,
          attempts: attempt,
          rejections,
          usage,
        })
      }

      // R-007：把具体的拒绝理由回灌，让它改
      feedback = violationsToFeedback(committed.verdict.violations)
      rejections.push(feedback)

      await asRole('keel_control', async (c) => {
        const traceId = await ensureTraceId(c, proposal.task_id)
        await c.query(
          `INSERT INTO event (task_id, run_id, type, payload, trace_id)
           VALUES ($1,$2,'ProposalRejected',$3::jsonb,$4)`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ attempt, violations: committed.verdict.violations }),
            traceId,
          ],
        )
      })
    }

    // R-006：连续失败到上限，判 Run 失败
    return err(
      makeError(
        'SCHEMA_VIOLATION',
        `连续 ${maxRetries} 次提案均未通过校验：${rejections.at(-1)?.join('；') ?? ''}`,
      ),
    )
  } finally {
    await sessions.close(handle)
  }
}
