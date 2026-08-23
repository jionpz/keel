/**
 * Workflow driver —— 属 Control Plane。
 *
 * 与 transition / policy 的区别：driver **必须做 I/O**，它不是纯的。
 * 但它仍受 Control Plane 的其余约束：不调 LLM、时间由参数注入、
 * facts 只来自 Fact Plane。
 *
 * 结构性保证由 .dependency-cruiser.cjs 的 driver-must-not-touch-execution 提供。
 */

export { type AdvanceOutcome, WorkflowDriver } from './driver.js'
export { type AppliedEffect, applyEffects, type EffectContext } from './effects.js'
export {
  loadPolicyFacts,
  loadTransitionFacts,
  MAX_DEV_ATTEMPTS,
  MAX_STAGE_ATTEMPTS,
} from './facts.js'
