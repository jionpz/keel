/**
 * transition() —— Task 级状态转移的纯函数。
 *
 * ADR-0003 硬约束：
 *   本函数不得内联 I/O、不得读时钟、不得直接执行副作用。
 *   副作用只能作为**返回值中的描述**，由外层执行器实施。
 *
 * 这条约束同时服务两个目的：
 *   1. 可重放（docs/04-state-machine.md §5.3）—— 独立成立，不是为迁移额外付出的成本
 *   2. 让「先自研、后换 Temporal」不成为陷阱 ——
 *      迁移时 Temporal workflow 可作为薄壳调用本函数，转移表与 Fact Plane 完全不动
 *
 * 强制手段见 .dependency-cruiser.cjs（import 层面）与 scripts/check-purity.ts（全局层面）。
 */

import { isStageStatus, isTerminal } from '../../shared/ids.js'
import { TASK_TRANSITIONS } from './table.js'
import type {
  ControlMode,
  TaskStatus,
  TransitionEvent,
  TransitionFacts,
  TransitionResult,
  TransitionRule,
} from './types.js'

/** 规则的 from 是否匹配当前状态 */
function fromMatches(rule: TransitionRule, status: TaskStatus): boolean {
  switch (rule.from) {
    case null:
      return false // ∅ 只用于创建 Task，不参与已有 Task 的转移
    case 'ANY_STAGE':
      return isStageStatus(status)
    case 'ANY_NON_TERMINAL':
      return !isTerminal(status)
    default:
      return rule.from === status
  }
}

/**
 * 具体规则优先于通用规则。
 *
 * 否则一个 S-QA 上的 RunFailed 可能先撞上 T-030 而不是它应有的具体分支。
 * 排序在这里显式做，而不是依赖表的书写顺序 —— 书写顺序会因编辑而意外改变语义。
 */
function specificity(rule: TransitionRule): number {
  if (rule.from === 'ANY_NON_TERMINAL') return 0
  if (rule.from === 'ANY_STAGE') return 1
  return 2
}

const ORDERED_RULES: readonly TransitionRule[] = [...TASK_TRANSITIONS].sort((a, b) => {
  const s = specificity(b) - specificity(a)
  return s !== 0 ? s : a.id.localeCompare(b.id)
})

/**
 * 计算一次状态转移。
 *
 * @param status      当前 task.status
 * @param controlMode 当前 task.control_mode（与 status 正交）
 * @param event       触发事件
 * @param facts       guard 的输入，全部来自 Fact Plane
 */
export function transition(
  status: TaskStatus,
  controlMode: ControlMode,
  event: TransitionEvent,
  facts: TransitionFacts,
): TransitionResult {
  if (isTerminal(status)) {
    return {
      matched: false,
      reason: 'no_rule',
      detail: `${status} 是终态，无出边`,
    }
  }

  let sawCandidate = false
  let blockedByControlMode = false

  for (const rule of ORDERED_RULES) {
    if (!fromMatches(rule, status)) continue
    if (!rule.on.includes(event.type)) continue

    sawCandidate = true

    // control_mode 不是 auto 时只有 T-040 / T-041 可以推进
    if (controlMode !== 'auto' && !rule.ignoresControlMode) {
      blockedByControlMode = true
      continue
    }

    if (rule.guard !== null && !rule.guard(facts, event)) continue

    const next = rule.to === 'SELF' ? status : rule.to
    return {
      matched: true,
      id: rule.id,
      from: status,
      next_status: next,
      effects: rule.effects,
    }
  }

  if (blockedByControlMode) {
    return {
      matched: false,
      reason: 'control_mode_not_auto',
      detail: `control_mode=${controlMode}，控制平面不派发新 Run（仅 T-040 / T-041 例外）`,
    }
  }
  if (sawCandidate) {
    return {
      matched: false,
      reason: 'guard_failed',
      detail: `${status} 上有匹配 ${event.type} 的规则，但 guard 均未通过`,
    }
  }
  return {
    matched: false,
    reason: 'no_rule',
    detail: `${status} 上没有响应 ${event.type} 的转移`,
  }
}

export { TASK_TRANSITIONS } from './table.js'
export type * from './types.js'
