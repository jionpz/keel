/**
 * 跨契约共用的数据形状。
 *
 * 单独成文件是为了避免契约之间的循环依赖 ——
 * .dependency-cruiser.cjs 的 no-circular 规则会拦住循环，
 * 而循环依赖会让平面边界在事实上失效。
 *
 * 依赖方向：types.ts ← 各契约文件。types.ts 本身只依赖 generated / shared。
 */

import type { ArtifactKind } from '../generated/schemas.js'
import type { ArtifactRef, CapabilityId, RoleId, Stage } from '../shared/ids.js'

// ─────────────────────────────── 用量与成本 ───────────────────────────────

/**
 * 成本口径。
 *
 * 三态是刻意的：已查证 Claude Code 的 total_cost_usd 是 client-side estimate，
 * 官方文档明确说明可能与实际账单有出入。
 * 把「估算」与「实际计费」混为一谈，会让预算控制看起来比实际更精确。
 * 见 docs/08-cross-cutting.md §3.1。
 */
export type CostBasis = 'billed' | 'estimated' | 'unavailable'

export interface Usage {
  /** null = Harness 未上报（无 CAP-COST）。禁止用 0 冒充 —— 两者在核算里是不同的事实 */
  readonly tokens_in: number | null
  readonly tokens_out: number | null
  readonly cost_usd: number | null
  readonly cost_basis: CostBasis
}

// ─────────────────────────────── 工作区 ───────────────────────────────

export interface WorkspaceSpec {
  readonly path: string
  readonly repo_id: string
  readonly branch: string
  /**
   * 仓库内容是否不可信。
   *
   * **没有默认值是刻意的**（docs/08-cross-cutting.md §1.2 要求 S3）：
   * 设成「默认 true」看似安全，但真正的风险是有人为调试改成 false 然后忘了改回来。
   * 强制显式传参，让每个调用点都必须做一次有意识的声明。
   */
  readonly untrusted: boolean
}

// ─────────────────────────── Context（下行桥）───────────────────────────
// 定义处：docs/05-contracts/context-builder.md

export type SectionPriority = 'required' | 'high' | 'normal' | 'low'

/**
 * 配料来源类型。retrieval 与 derived 是**唯一允许非确定性**的地方，
 * 因此它们的 source_ref 必须包含足以复现的完整参数。
 */
export type SectionSource = 'fixed' | 'artifact' | 'workspace' | 'retrieval' | 'derived'

export interface ContextSection {
  readonly id: string
  /** 溯源，如 artifact:state@3 / file:src/x.ts / retrieval:q=...&k=5 */
  readonly source_ref: string
  readonly source_kind: SectionSource
  readonly priority: SectionPriority
  readonly content: string
  readonly tokens: number
}

export interface DroppedSection {
  readonly id: string
  readonly reason: 'budget' | 'unavailable' | 'policy'
  readonly tokens_would_have_been: number
}

export interface Context {
  /** 可寻址，写入 ContextBuilt 事件供复现 */
  readonly context_id: string
  readonly recipe_id: string
  readonly recipe_version: string
  readonly sections: readonly ContextSection[]
  readonly total_tokens: number
  /**
   * **必填而非可选**：被砍掉的东西必须显式记录，
   * 否则「预算不够所以没给它看 RFC」会静默发生，
   * 复盘时看起来像 Agent 无缘无故做错了判断。
   */
  readonly dropped: readonly DroppedSection[]
}

// ────────────────────────── Proposal（上行桥）──────────────────────────
// 定义处：docs/05-contracts/session-manager.md §1

// ─────────────────────────── 通用 ───────────────────────────

/**
 * Proposal 的产物 kind —— 与 `PersistedArtifactKind` 同构（`Exclude<ArtifactKind,'event'>`）。
 *
 * `A-Event` 有独立的表（docs/06-artifacts.md §1），不走 artifact 落库，
 * 因此 Proposal 不可能携带 `event`（#1-10）。
 */
export type ProposalKind = Exclude<ArtifactKind, 'event'>

/**
 * Proposal —— Session 产出、待校验的产物。
 *
 * **这是 Execution Plane 向 Control Plane 提交结果的唯一通道。**
 * emit 不等于写入 —— 提案必须经校验流水线后才成为 Artifact。
 */

export interface Proposal {
  readonly proposal_id: string
  /**
   * 提案归属的 Task。
   *
   * 显式字段而非从 body 里读：产物的 schema 是严格的
   * （additionalProperties: false），body 里塞不进 task_id。
   * 而提案本来就是**关于某个 Task 的** —— 归属属于信封，不属于内容。
   */
  readonly task_id: string
  /** 与 docs/06-artifacts.md §1 的 kind 列一致；排除 event（有独立表） */
  readonly kind: ProposalKind
  readonly key: string
  /** 必须符合 kind 对应的 JSON Schema */
  readonly body: unknown
  readonly supersedes: ArtifactRef | null
  readonly produced_by_run: string
}

export interface SchemaViolation {
  readonly path: string
  readonly rule: string
  readonly message: string
}

export interface ProposalVerdict {
  readonly accepted: boolean
  readonly artifact_ref: ArtifactRef | null
  /** 拒绝时回灌给 Session（R-007），而不是直接判 Run 失败 */
  readonly violations: readonly SchemaViolation[]
}

// ─────────────────────────────── 通用 ───────────────────────────────

export interface RunRef {
  readonly run_id: string
  readonly task_id: string
  readonly stage: Stage
  readonly role: RoleId
  readonly attempt: number
}

export interface Limits {
  readonly wall_clock_s: number
  readonly budget_usd: number | null
  readonly max_turns: number
}

export type { ArtifactRef, CapabilityId, RoleId, Stage }
