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
  // QA / Reviewer 的活就是核对**实际改动**：不给 diff，它们只能对着 RFC 空想，
  // 然后把自己猜的结论当成核对结果报上来（10-25 真机跑通时的实际表现）
  QA: ['role', 'rfc', 'state', 'diff'],
  Reviewer: ['role', 'rfc', 'state', 'diff'],
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

      case 'diff': {
        // 只取 develop 那一轮的观测：返工后 pm / develop 自己也会写事件，
        // 取「最近一条」会把 QA 指到错误的 diff 上。
        const r = await c.query<{ seq: string; payload: DiffPayload }>(
          `SELECT seq, payload FROM event
           WHERE task_id=$1 AND type='WorkspaceDiffCollected' AND payload->>'stage'='develop'
           ORDER BY seq DESC LIMIT 1`,
          [req.task_id],
        )
        const row = r.rows[0]
        if (row === undefined) return null
        return {
          id,
          source_ref: `event:WorkspaceDiffCollected@${row.seq}`,
          // 事件是运行期观测，不是持久化产物 —— 归 'workspace'（这个 run 在工作区里干了什么）
          source_kind: 'workspace',
          // required：QA/Reviewer 拿不到实际改动就无法履行核对职责。
          // 预算放不下时按既有语义直接失败（CONTEXT_BUDGET_EXCEEDED），
          // 不许静默降级 —— 那样它们又会退回「凭 RFC 猜」。
          priority: 'required',
          content: renderDiff(row.payload),
        }
      }

      default:
        return null
    }
  }
}

/** `WorkspaceDiffCollected` 的 payload 形状（写入方见 `orchestrator/loop.ts`） */
interface DiffPayload {
  readonly collected?: boolean
  readonly collect_error?: string | null
  readonly files_changed?: readonly { readonly path: string; readonly change: string }[]
  readonly commits?: readonly string[]
  readonly is_dirty?: boolean | null
  readonly patch?: string | null
  readonly patch_chars?: number | null
  readonly patch_truncated?: boolean
}

/**
 * 把 diff 事件渲染成 Agent 能读的段落。
 *
 * 采集失败 / 被截断都必须**写在正文里**：一份看起来完整、其实缺了半截的 diff
 * 会让 QA 得出「验收标准未覆盖」之类的错误结论，比不给更糟。
 */
function renderDiff(p: DiffPayload): string {
  if (p.collected === false) {
    return [
      '## develop 的实际改动',
      '',
      `**未能采集**：${p.collect_error ?? '适配器没有返回工作区信息'}。`,
      '「没测到」不等于「没有改动」—— 请以工作区里的实际文件为准，并在理由里说明你核对了什么。',
    ].join('\n')
  }

  const files = p.files_changed ?? []
  const lines = ['## develop 的实际改动（git 观测，不是模型自述）', '']
  lines.push(files.length === 0 ? '文件：无' : '文件：')
  for (const f of files) lines.push(`- ${f.change} ${f.path}`)

  const commits = p.commits ?? []
  lines.push(
    '',
    commits.length === 0 ? '本轮提交：无（改动仍在工作区）' : `本轮提交：${commits.join(', ')}`,
  )
  lines.push(
    `工作区是否仍有未提交改动：${p.is_dirty === true ? '是' : p.is_dirty === false ? '否' : '未知'}`,
  )

  if (p.patch === null || p.patch === undefined) {
    lines.push('', 'patch：（无文本 diff）')
  } else {
    const chars = p.patch_chars ?? p.patch.length
    const head =
      p.patch_truncated === true
        ? `patch（**已截断**，共 ${chars} 字符，以下仅为开头部分）：`
        : `patch（共 ${chars} 字符）：`
    lines.push('', head, '```diff', p.patch, '```')
  }
  return lines.join('\n')
}
