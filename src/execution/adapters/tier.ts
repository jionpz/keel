/**
 * 由 capability 集合推导 tier。
 *
 * `ADR-0005`（2026-08-23 修订）：
 *
 * > 阶梯只是给人看的摘要，**不参与决策**。
 * > 驱动运行时行为的是降级矩阵，它本来就是按能力逐条的。
 *
 * 修订前的定义把 CAP-STRUCTURED_OUTPUT 放进 L1，
 * 结果接入 OMP 时发现它具备 RESUME/STREAM/COST/PERMISSION 却没有结构化输出 ——
 * 按旧定义只能标 L0，而 L0 意味着「每轮重新物化上下文」，
 * 对一个 resume 省两个数量级 token 的 harness 是完全错误的描述。
 *
 * 根因：线性阶梯假设能力是**嵌套**的，实际它们是**正交**的。
 */

import type { CapabilityId, HarnessTier } from '../../shared/ids.js'
import { TIER_REQUIREMENTS } from '../../shared/ids.js'

/**
 * L0 = CAP-HEADLESS
 * L1 = L0 + CAP-RESUME                会话可恢复（最大的 token 杠杆）
 * L2 = L1 + CAP-STREAM + CAP-COST     中途可观测、可按预算熔断
 *
 * CAP-STRUCTURED_OUTPUT / CAP-PERMISSION / CAP-UNTRUSTED_WORKSPACE
 * 等**不在阶梯内** —— 它们是正交能力。
 *
 * R10(issue #23):阶梯要求**唯一事实源**是 TIER_REQUIREMENTS(ids.ts),
 * 这里只做「满足哪档」判断,不再内联重实现阶梯内容。
 */
export function tierOf(caps: readonly CapabilityId[]): HarnessTier {
  const has = (c: CapabilityId): boolean => caps.includes(c)
  if (!has('CAP-HEADLESS')) {
    throw new Error('CAP-HEADLESS 是最低门槛，不具备则无法接入')
  }
  if (TIER_REQUIREMENTS.L2.every(has)) return 'L2'
  if (TIER_REQUIREMENTS.L1.every(has)) return 'L1'
  return 'L0'
}
