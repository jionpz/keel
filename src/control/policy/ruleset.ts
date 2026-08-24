/**
 * Fact 注册表与默认规则集。
 *
 * 定义处：docs/05-contracts/policy-engine.md §2 / §3
 *
 * 默认规则集来自初稿 §12 的 5 条规则 + 契约 §2.2 的漂移检测。
 * 初稿那 5 条里藏着一个未被察觉的冲突（见 P3 与 P4 的注），
 * 正是它促成了「严格性偏序 + 默认 deny」这套设计。
 *
 * **接线纪律（issue #21 修订）**：只保留**已挂 EvaluatePolicy 副作用**
 * 的判定点（当前仅 `rfc_ready`）的规则。`post_develop`（P-DRIFT 漂移检测）、
 * `qa_failed`、`pre_pr` 的规则从未被求值 —— 写了也没人读,已删除,不假装接线。
 * 它们的设计意图仍在契约文档,接入对应转移时恢复规则而非凭空新增。
 */

import type { DecisionPoint, Rule, Ruleset } from '../../contracts/policy-engine.js'

/**
 * Fact 注册表。
 *
 * **静态**：随 RFC 冻结 ⇒ 同一 RFC 版本的裁决结果恒定。
 * **运行期**：持续变化 ⇒ 每次求值可能不同。
 *
 * 分野的实际意义：`rfc_ready` 判定点的结果可以缓存，`qa_failed` 的不能。
 */
export const FACT_REGISTRY: Readonly<Record<string, 'static' | 'runtime'>> = {
  // 静态 —— 来自 A-RFC.policy_facts，随 RFC 冻结
  risk: 'static',
  complexity: 'static',
  estimated_files_changed: 'static',
  security_related: 'static',
  // 静态 —— 来自 A-CriticReview
  critic_confidence: 'static',
  // 运行期 —— 来自 run 表聚合
  dev_attempts: 'runtime',
  tests_failed: 'runtime',
  cost_spent_usd: 'runtime',
  // 运行期 —— 来自 WorkspaceDiff
  actual_files_changed: 'runtime',
  /**
   * 派生 fact：actual / estimated。
   *
   * 由调用方算好传入，而不是在表达式里写乘除 ——
   * 受限表达式语言不支持算术，这是它可静态分析的前提。
   * 见 docs/05-contracts/policy-engine.md §2.2。
   */
  files_drift_ratio: 'runtime',
  /**
   * 请求的能力（capability_request 判定点）。
   * 由调用方从事件 / 提案注入 —— 属运行期事实。
   */
  capability: 'runtime',
}

export const KNOWN_FACTS: readonly string[] = Object.keys(FACT_REGISTRY).sort()

/** 判定点上可用的 fact —— validate() 与调用方都以此为准 */
export const FACTS_AT: Readonly<Record<DecisionPoint, readonly string[]>> = {
  rfc_ready: [
    'risk',
    'complexity',
    'estimated_files_changed',
    'security_related',
    'critic_confidence',
  ],
  capability_request: ['dev_attempts', 'cost_spent_usd', 'capability'],
  post_develop: ['actual_files_changed', 'estimated_files_changed', 'files_drift_ratio', 'risk'],
  qa_failed: ['tests_failed', 'dev_attempts'],
  pre_pr: [
    'risk',
    'complexity',
    'security_related',
    'dev_attempts',
    'tests_failed',
    'cost_spent_usd',
  ],
}

/**
 * 默认规则集。
 *
 * priority 只决定**求值顺序**（因而只对 stop 有意义），
 * **不决定谁胜出** —— 胜出者由严格性偏序取最严。
 */
export const DEFAULT_RULES: readonly Rule[] = [
  {
    id: 'P1',
    points: ['rfc_ready'],
    priority: 800,
    condition: "facts.risk == 'high'",
    action: 'human_review',
    stop: false,
  },
  {
    // ⚠️ 与 P4 的冲突正是本引擎存在的原因：
    // 一个低复杂度、低风险的**安全修复**会同时命中 P3 与 P4。
    // 按声明顺序取第一条碰巧对；按「最后匹配优先」就把安全改动自动放行了。
    // 严格性偏序保证这里胜出的是 security_review。
    id: 'P3',
    points: ['rfc_ready'],
    priority: 700,
    condition: 'facts.security_related == true',
    action: 'security_review',
    stop: false,
  },
  {
    id: 'P2',
    points: ['rfc_ready'],
    priority: 600,
    condition: 'facts.estimated_files_changed > 30',
    action: 'architecture_review',
    stop: false,
  },
  {
    // 唯一放行的规则，因此 priority 最低、也最容易被更严的规则压过
    id: 'P4',
    points: ['rfc_ready'],
    priority: 100,
    condition: "facts.complexity == 'low' && facts.risk == 'low'",
    action: 'auto_develop',
    stop: false,
  },
  {
    // capability_request 的唯一放行口(T-009):
    // 只有显式请求 critic_review 才允许;human_input / additional_context
    // 无规则 → 默认 deny(缺裁决即拒,Round 1 决策 #1-02)。
    // 这是 #1-09 纪律的正当恢复:capability_request 已由 #1-02 真正接线。
    id: 'P-ALLOW-CRITIC',
    points: ['capability_request'],
    priority: 100,
    condition: "facts.capability == 'critic_review'",
    action: 'auto_develop',
    stop: false,
  },
]

export const DEFAULT_RULESET: Ruleset = {
  version: '2026-08-24',
  rules: DEFAULT_RULES,
}
