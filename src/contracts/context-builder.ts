/**
 * ContextBuilder —— 「不让 Agent 每次从零读项目」的落点，Fact → Execution 的唯一下行桥。
 *
 * 定义处：docs/05-contracts/context-builder.md
 *
 * 本契约要回答的第三个问题最要命：**事后怎么复现**。
 * 如果 Context 是每次即兴拼装的，那么「为什么它当时做了这个判断」就永远无法复盘 ——
 * 而这恰恰是事故复盘最需要的信息。
 * 因此每次 build() 都必须发一条 ContextBuilt 事件记录 source_ref 与 dropped。
 */

import type { RoleId, Stage } from '../shared/ids.js'
import type { Result } from './errors.js'
import type { Context, SectionPriority } from './types.js'

export type ResumeMode = 'fresh' | 'rematerialize'

export interface ContextRequest {
  readonly task_id: string
  readonly run_id: string
  readonly role: RoleId
  readonly stage: Stage
  readonly budget_tokens: number
  /**
   * rematerialize 模式（Harness 无 CAP-RESUME）需额外装填
   * checkpoint.working_summary 与更多 A-State 历史。
   * 调用方应为此模式配置**更大的 budget_tokens**，
   * 而不是让它去挤压 required section。
   */
  readonly resume_mode: ResumeMode
}

export interface TokenEstimate {
  readonly total_tokens: number
  readonly by_section: Readonly<Record<string, number>>
}

/**
 * 超预算时的降级顺序 —— **固定，不允许实现自行发挥**。
 * 见 docs/05-contracts/context-builder.md §4.2。
 */
export const DEGRADATION_ORDER: readonly {
  step: number
  action: 'drop' | 'summarize' | 'fail'
  priority: SectionPriority | null
}[] = [
  { step: 1, action: 'drop', priority: 'low' },
  { step: 2, action: 'drop', priority: 'normal' },
  { step: 3, action: 'summarize', priority: 'high' },
  { step: 4, action: 'drop', priority: 'high' },
  { step: 5, action: 'summarize', priority: 'required' },
  // 第 6 步不是降级而是失败：required 被截断意味着 Agent 拿不到完成任务的
  // 最低必要信息。此时让它跑起来比不跑更糟 —— 它会产出一个看似合理、
  // 实则基于残缺信息的结果，而这个结果会经 Proposal 落成事实。
  { step: 6, action: 'fail', priority: null },
]

export interface ContextBuilder {
  /**
   * [v0.1 必须] 构造某个 Session 某一轮的输入材料。
   *
   * required section 摘要后仍超预算 → 返回 CONTEXT_BUDGET_EXCEEDED，
   * **不得静默截断**。调用方应走 T-031 升人工。
   */
  build(request: ContextRequest): Promise<Result<Context>>

  // ── [可延后] ──
  //
  // estimate(request: ContextRequest): Promise<Result<TokenEstimate>>
  //     不实际取内容，只估算体积。用于派发前预判是否会触发大量裁剪。
}

export type { TokenEstimate as ContextTokenEstimate }
