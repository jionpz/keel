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
import type {
  HarnessSessionManager,
  SessionHandle,
  SessionSpec,
} from '../../execution/session/manager.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
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
        const ev = await c.query<{ seq: string }>(
          `INSERT INTO event (task_id, run_id, type, payload)
           VALUES ($1,$2,'ProposalAccepted',$3::jsonb) RETURNING seq`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ kind: proposal.kind, key: proposal.key, attempt }),
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
        })
      }

      // R-007：把具体的拒绝理由回灌，让它改
      feedback = violationsToFeedback(committed.verdict.violations)
      rejections.push(feedback)

      await asRole('keel_control', (c) =>
        c.query(
          `INSERT INTO event (task_id, run_id, type, payload)
           VALUES ($1,$2,'ProposalRejected',$3::jsonb)`,
          [
            proposal.task_id,
            proposal.produced_by_run,
            JSON.stringify({ attempt, violations: committed.verdict.violations }),
          ],
        ),
      )
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
