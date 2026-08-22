/**
 * Policy Engine —— 属 Control Plane。
 *
 * 硬约束：facts 只能来自 Fact Plane（可重放的前提）；求值必须是纯函数；
 * 默认语义为 deny；多规则命中时按严格性偏序取最严。
 * 见 docs/05-contracts/policy-engine.md。
 *
 * v0.1 实现。
 */
export const COMPONENT = 'policy-engine' as const
