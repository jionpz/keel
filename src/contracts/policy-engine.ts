/**
 * PolicyEngine —— 「Policy 决定权限」的落点。
 *
 * 定义处：docs/05-contracts/policy-engine.md
 *
 * 本契约存在的直接原因是初稿 §12 那组 YAML 规则里藏着一个未被察觉的缺陷：
 * 一个**低复杂度的安全修复**会同时命中 security_review 和 auto_develop 两条，
 * 而初稿没说谁赢。按「最后匹配优先」就把安全改动自动放行了。
 * 一个未定义的求值顺序，决定了系统是安全的还是危险的。
 *
 * 解法：严格性偏序 + 默认 deny。
 */

import type { APolicyDecision } from '../generated/artifacts.js'
import type { Result } from './errors.js'

/** Policy 只在明确的判定点求值，不是随时求值 */
export const DECISION_POINTS = [
  'rfc_ready',
  'capability_request',
  'post_develop',
  'qa_failed',
  'pre_pr',
] as const
export type DecisionPoint = (typeof DECISION_POINTS)[number]

export const POLICY_ACTIONS = [
  'auto_develop',
  'architecture_review',
  'security_review',
  'human_review',
  'reject',
] as const
export type PolicyAction = (typeof POLICY_ACTIONS)[number]

/**
 * 严格性偏序：数值大者更严格。
 *
 *   reject ≻ human_review ≻ security_review ≻ architecture_review ≻ auto_develop
 *
 * 多条规则命中时取**最严**的那个。
 *
 * 选「最严者胜」而不是「优先级最高者胜」，是因为前者的失效模式是
 * **过度谨慎**（多一次人工审），后者的失效模式是**意外放行**。
 * 在这个系统里，前一种错误的代价远低于后一种。
 */
export const ACTION_STRICTNESS: Readonly<Record<PolicyAction, number>> = {
  auto_develop: 0,
  architecture_review: 1,
  security_review: 2,
  human_review: 3,
  reject: 4,
}

/** 无规则命中时的默认动作。默认 **deny** —— 不放行，落到人工 */
export const DEFAULT_ACTION: PolicyAction = 'human_review'

/** 取一组动作中最严格的那个 */
export function mostRestrictive(actions: readonly PolicyAction[]): PolicyAction {
  let winner: PolicyAction = DEFAULT_ACTION
  let best = -1
  for (const a of actions) {
    const s = ACTION_STRICTNESS[a]
    if (s > best) {
      best = s
      winner = a
    }
  }
  return winner
}

export interface Rule {
  readonly id: string
  /**
   * 本规则在哪些判定点参与求值。
   *
   * 必须按判定点划分：不同判定点可用的 fact 不同 ——
   * `rfc_ready` 时还没有 `actual_files_changed`。
   * 若不划分，引用尚不存在的 fact 的规则会**抛错**而不是「不命中」。
   */
  readonly points: readonly DecisionPoint[]
  /** 数值大的先求值。同 priority 按 id 升序 —— 保证完全确定的求值顺序 */
  readonly priority: number
  /** 受限表达式，不是通用脚本。见 docs/05-contracts/policy-engine.md §5 */
  readonly condition: string
  readonly action: PolicyAction
  /** 命中后不再求值后续规则。逃生阀，**默认不用** —— 它会让行为依赖顺序 */
  readonly stop: boolean
}

export interface Ruleset {
  readonly version: string
  readonly rules: readonly Rule[]
}

/** facts 只能来自 Fact Plane —— 这是 Policy 求值可重放的前提 */
export type FactSet = Readonly<Record<string, string | number | boolean>>

export interface ValidationIssue {
  readonly rule_id: string
  readonly message: string
}

export interface ValidationReport {
  readonly ok: boolean
  readonly errors: readonly ValidationIssue[]
  readonly warnings: readonly ValidationIssue[]
}

export interface PolicyEngine {
  /**
   * [v0.1 必须] 求值。
   *
   * **必须是纯函数**：相同 (ruleset_version, point, facts, evaluated_at)
   * 永远得到相同结果。不得读时钟、不得查外部系统、不得调 LLM（Control Plane 硬约束）。
   *
   * `evaluated_at` 由**调用方传入**而不是引擎内部取 —— 否则引擎就不纯了，
   * 而 Policy 的可重放性是整个 Fact Plane 可信的前提之一。
   *
   * 产出的 A-PolicyDecision 中，facts_snapshot 是**输入的完整快照**而非引用 ——
   * 快照才能保证同输入同裁决。
   */
  evaluate(point: DecisionPoint, facts: FactSet, evaluated_at: string): Result<APolicyDecision>

  /**
   * [v0.1 必须] 规则集在**加载时**校验，不是等到求值才发现问题。
   *
   * 至少检查：condition 语法合法、引用的 fact 在注册表中存在、
   * action 在偏序中有定义、同 priority 条件重叠（warn）、
   * 被前序 stop 完全遮蔽的永不可命中规则（warn）。
   */
  validate(ruleset: Ruleset): ValidationReport

  // ── [可延后] ──
  //
  // explain(decision_ref: ArtifactRef): Result<Explanation>
  //     回答「为什么这个 Task 被判为需要人工审」。
  //     基于已存的 A-PolicyDecision 重建推理链，不重新求值。
}
