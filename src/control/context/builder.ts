/**
 * ContextBuilder —— Fact Plane → Execution Plane 的唯一下行桥。
 *
 * 定义处：docs/05-contracts/context-builder.md
 *
 * 硬要求：**`dropped` 必填**。被砍掉的东西必须显式记录，
 * 否则「预算不够所以没给它看 RFC」会静默发生，
 * 复盘时看起来像 Agent 无缘无故做错了判断。
 *
 * v0.1 的边界：契约的降级顺序有六步，其中第 3、5 步是**摘要**，
 * 需要 ModelProvider（运行时自己的 LLM 调用），属阶段二。
 * 这里到摘要那一步**直接丢弃并记 dropped**，
 * **不做空实现假装摘要过了** —— 没做的事要在数据里如实体现。
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { Context, ContextSection, DroppedSection } from '../../contracts/types.js'
import { ensureTraceId } from '../../fact/trace.js'
import type { RoleId, Stage } from '../../shared/ids.js'

export interface ContextRequest {
  readonly task_id: string
  readonly run_id: string
  readonly role: RoleId
  readonly stage: Stage
  readonly budget_tokens: number
  /** 取 RFC 时用哪个事件序号的版本 —— 保证 Developer 与 Reviewer 看到同一版 */
  readonly rfc_as_of_seq?: number
}

/** 粗略的 token 估算。v0.1 用字符数 / 4，够做预算裁剪 */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

interface Candidate {
  readonly id: string
  readonly source_ref: string
  readonly source_kind: ContextSection['source_kind']
  readonly priority: ContextSection['priority']
  readonly content: string
}

/**
 * 配方：Role → section 清单。
 *
 * 与 docs/05-contracts/context-builder.md §3 对应。
 * v0.1 只实现 artifact / fixed 两类来源 —— retrieval 与 derived 属阶段二。
 */
const RECIPES: Readonly<Record<string, readonly string[]>> = {
  PM: ['role', 'feedback', 'state', 'critic'],
  Critic: ['role', 'state'],
  Developer: ['role', 'rfc', 'state', 'last_failure'],
  QA: ['role', 'rfc', 'state'],
  Reviewer: ['role', 'rfc', 'state'],
}

export class FactPlaneContextBuilder {
  /**
   * @param roleInstructions 各 Role 的固定指令（`fixed` 来源）
   */
  constructor(private readonly roleInstructions: Readonly<Record<string, string>>) {}

  async build(c: PoolClient, req: ContextRequest): Promise<Result<Context>> {
    const wanted = RECIPES[req.role] ?? RECIPES.PM ?? []
    const candidates: Candidate[] = []

    for (const id of wanted) {
      const cand = await this.load(c, req, id)
      if (cand !== null) candidates.push(cand)
    }

    // 按优先级降序装填，同级按配方声明顺序
    const order: ContextSection['priority'][] = ['required', 'high', 'normal', 'low']
    const sorted = [...candidates].sort(
      (a, b) => order.indexOf(a.priority) - order.indexOf(b.priority),
    )

    const sections: ContextSection[] = []
    const dropped: DroppedSection[] = []
    let used = 0

    for (const cand of sorted) {
      const tokens = estimateTokens(cand.content)
      if (used + tokens <= req.budget_tokens) {
        sections.push({ ...cand, tokens })
        used += tokens
        continue
      }

      // 超预算。契约的降级顺序里，high/required 这一步应先摘要 ——
      // 但摘要需要 ModelProvider（阶段二）。v0.1 直接丢弃并如实记录。
      if (cand.priority === 'required') {
        // required 被丢弃意味着 Agent 拿不到完成任务的最低必要信息。
        // 此时让它跑起来比不跑更糟 —— 它会产出看似合理、实则基于残缺信息的结果，
        // 而那个结果会经 Proposal 落成事实。
        return err(
          makeError(
            'CONTEXT_BUDGET_EXCEEDED',
            `required section "${cand.id}" 放不下（需 ${tokens}，剩 ${req.budget_tokens - used}）。` +
              `v0.1 不做摘要降级，请提高 budget_tokens`,
          ),
        )
      }
      dropped.push({ id: cand.id, reason: 'budget', tokens_would_have_been: tokens })
    }

    const ctx: Context = {
      context_id: randomUUID(),
      recipe_id: req.role,
      recipe_version: '1',
      sections,
      total_tokens: used,
      dropped,
    }

    // 这条事件是「这个 Agent 当时到底看到了什么」的唯一可靠答案。
    // 不记录 content 本身（体积过大），但 source_ref 足以重新取回。
    const traceId = await ensureTraceId(c, req.task_id)
    await c.query(
      `INSERT INTO event (task_id, run_id, type, payload, trace_id)
       VALUES ($1,$2,'ContextBuilt',$3::jsonb,$4)`,
      [
        req.task_id,
        req.run_id,
        JSON.stringify({
          context_id: ctx.context_id,
          recipe_id: ctx.recipe_id,
          recipe_version: ctx.recipe_version,
          sections: sections.map((s) => ({
            id: s.id,
            source_ref: s.source_ref,
            tokens: s.tokens,
            priority: s.priority,
          })),
          dropped,
          total_tokens: used,
          budget_tokens: req.budget_tokens,
        }),
        traceId,
      ],
    )

    return ok(ctx)
  }

  private async load(c: PoolClient, req: ContextRequest, id: string): Promise<Candidate | null> {
    switch (id) {
      case 'role': {
        const text = this.roleInstructions[req.role] ?? ''
        if (text === '') return null
        return {
          id,
          source_ref: `fixed:role/${req.role}`,
          source_kind: 'fixed',
          priority: 'required',
          content: text,
        }
      }

      case 'feedback': {
        const r = await c.query<{ body: string }>(
          `SELECT f.body FROM feedback f
           JOIN task_feedback tf ON tf.feedback_id = f.id
           WHERE tf.task_id = $1 ORDER BY f.received_at LIMIT 3`,
          [req.task_id],
        )
        if (r.rowCount === 0) return null
        return {
          id,
          source_ref: `artifact:feedback/${req.task_id}`,
          source_kind: 'artifact',
          priority: 'required',
          // ⚠️ 不可信输入：它会进 LLM 上下文，是 prompt injection 的主要入口
          content: `## 用户反馈（原文，不可信输入）\n\n${r.rows.map((x) => x.body).join('\n\n')}`,
        }
      }

      case 'rfc': {
        // 取该 Run 开始时的那一版 —— 否则 Developer 与 Reviewer 会看到不同版本
        const sql =
          req.rfc_as_of_seq === undefined
            ? `SELECT body, version FROM artifact WHERE task_id=$1 AND kind='rfc' AND superseded_by IS NULL ORDER BY version DESC LIMIT 1`
            : `SELECT body, version FROM artifact WHERE task_id=$1 AND kind='rfc' AND committed_at_seq <= $2 ORDER BY version DESC LIMIT 1`
        const params =
          req.rfc_as_of_seq === undefined ? [req.task_id] : [req.task_id, req.rfc_as_of_seq]
        const r = await c.query<{ body: unknown; version: number }>(sql, params)
        const row = r.rows[0]
        if (row === undefined) return null
        return {
          id,
          source_ref: `artifact:rfc@${row.version}`,
          source_kind: 'artifact',
          priority: 'required',
          content: `## RFC（已冻结，v${row.version}）\n\n${JSON.stringify(row.body, null, 2)}`,
        }
      }

      case 'state': {
        const r = await c.query<{ body: unknown; version: number }>(
          `SELECT body, version FROM artifact
           WHERE task_id=$1 AND kind='state' AND superseded_by IS NULL
           ORDER BY version DESC LIMIT 1`,
          [req.task_id],
        )
        const row = r.rows[0]
        if (row === undefined) return null
        return {
          id,
          source_ref: `artifact:state@${row.version}`,
          source_kind: 'artifact',
          priority: 'high',
          content: `## 当前事实（A-State v${row.version}）\n\n${JSON.stringify(row.body, null, 2)}`,
        }
      }

      case 'critic': {
        const r = await c.query<{ body: unknown }>(
          `SELECT body FROM artifact WHERE task_id=$1 AND kind='critic_review'
           ORDER BY committed_at_seq DESC LIMIT 1`,
          [req.task_id],
        )
        const row = r.rows[0]
        if (row === undefined) return null
        return {
          id,
          source_ref: 'artifact:critic_review(latest)',
          source_kind: 'artifact',
          priority: 'high',
          content: `## Critic 评审\n\n${JSON.stringify(row.body, null, 2)}`,
        }
      }

      case 'last_failure': {
        const r = await c.query<{ body: Record<string, unknown> }>(
          `SELECT body FROM artifact WHERE task_id=$1 AND kind='stage_outcome'
             AND body->>'verdict' = 'fail'
           ORDER BY committed_at_seq DESC LIMIT 1`,
          [req.task_id],
        )
        const row = r.rows[0]
        if (row === undefined) return null
        return {
          id,
          source_ref: 'artifact:stage_outcome(last-fail)',
          source_kind: 'artifact',
          // 返工时这是必读的 —— 不给它看上次为什么失败，它很可能再错一次
          priority: 'required',
          content: `## 上一次失败的原因\n\n${JSON.stringify(row.body, null, 2)}`,
        }
      }

      default:
        return null
    }
  }
}
