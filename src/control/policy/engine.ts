/**
 * PolicyEngine 实现。
 *
 * 定义处：docs/05-contracts/policy-engine.md
 *
 * 本引擎存在的直接原因是初稿 §12 那组规则里的一个冲突：
 * 一个**低复杂度、低风险的安全修复**同时命中 security_review 与 auto_develop，
 * 而初稿没说谁赢。按「最后匹配优先」就把安全改动自动放行了。
 *
 * 解法三条，缺一不可：
 *   1. 完全确定的求值顺序（priority 降序、id 升序）—— 不依赖书写顺序
 *   2. 收集**全部**命中，取严格性偏序中**最严**的 —— 不是取第一条
 *   3. 无命中时默认 **deny**
 *
 * 纯函数：不读时钟、不查外部。evaluated_at 由调用方传入。
 */

import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import {
  ACTION_STRICTNESS,
  DEFAULT_ACTION,
  type DecisionPoint,
  type FactSet,
  mostRestrictive,
  type PolicyAction,
  type PolicyEngine,
  type Rule,
  type Ruleset,
  type ValidationIssue,
  type ValidationReport,
} from '../../contracts/policy-engine.js'
import type { APolicyDecision } from '../../generated/artifacts.js'
import { type Ast, collectFields, ExprError, evaluateExpr, parse } from './expr.js'
import { FACTS_AT, KNOWN_FACTS } from './ruleset.js'

interface CompiledRule extends Rule {
  readonly ast: Ast
}

export class RuleBasedPolicyEngine implements PolicyEngine {
  private readonly compiled: readonly CompiledRule[]

  constructor(private readonly ruleset: Ruleset) {
    // 加载时就解析。语法错误在构造时暴露，而不是等到某个 Task 走到判定点才炸
    this.compiled = ruleset.rules.map((r) => ({ ...r, ast: parse(r.condition) }))
  }

  evaluate(point: DecisionPoint, facts: FactSet, evaluated_at: string): Result<APolicyDecision> {
    // 排序在此显式做，不依赖数组书写顺序 —— 后者会因编辑而意外改变语义。
    // 与 src/control/transition 的 specificity 排序是同一个考虑。
    const ordered = [...this.compiled]
      .filter((r) => r.points.includes(point))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))

    const matched: Rule[] = []

    for (const rule of ordered) {
      let hit: boolean
      try {
        hit = evaluateExpr(rule.ast, facts)
      } catch (e) {
        // 求值失败不是「不命中」—— 那会静默放行。作为错误上抛
        if (e instanceof ExprError) {
          return err(makeError('PERMISSION_DENIED', `规则 ${rule.id} 求值失败：${e.message}`))
        }
        throw e
      }
      if (!hit) continue

      matched.push(rule)
      if (rule.stop) break
    }

    const decision: PolicyAction =
      matched.length === 0 ? DEFAULT_ACTION : mostRestrictive(matched.map((r) => r.action))

    return ok({
      schema_version: '1.0',
      decision_point: point,
      policy_version: this.ruleset.version,
      evaluated_at,
      // 完整快照而非引用 —— 引用会随时间变化，快照才能保证同输入同裁决
      facts_snapshot: { ...facts },
      matched_rules: matched.map((r) => ({
        id: r.id,
        condition: r.condition,
        action: r.action,
      })),
      decision,
      reason: explain(matched, decision),
      // 大量 true 是规则覆盖不足的信号。不记录的话，
      // 默认 deny 会安静地把系统退化成全人工而没人察觉
      default_applied: matched.length === 0,
    })
  }

  validate(ruleset: Ruleset): ValidationReport {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []

    const asts = new Map<string, Ast>()

    for (const rule of ruleset.rules) {
      // 1. 语法
      let ast: Ast
      try {
        ast = parse(rule.condition)
        asts.set(rule.id, ast)
      } catch (e) {
        errors.push({
          rule_id: rule.id,
          message: `condition 语法错误：${e instanceof Error ? e.message : String(e)}`,
        })
        continue
      }

      // 2. 引用的 fact 必须在注册表中
      for (const f of collectFields(ast)) {
        if (!KNOWN_FACTS.includes(f)) {
          errors.push({ rule_id: rule.id, message: `引用了未注册的 fact：facts.${f}` })
        }
      }

      // 2b. 且必须在该规则的每个判定点上可用 —— 否则求值时会抛错而非不命中
      for (const point of rule.points) {
        const available = FACTS_AT[point]
        if (available === undefined) {
          // R6(issue #23):规则引用未接线判定点(无 EvaluatePolicy 副作用)——
          // 写了没人读,validate 拒绝,不假装接线
          errors.push({
            rule_id: rule.id,
            message: `判定点 ${point} 未接线(FACTS_AT 无此点) —— 规则永不求值`,
          })
          continue
        }
        for (const f of collectFields(ast)) {
          if (KNOWN_FACTS.includes(f) && !available.includes(f)) {
            errors.push({
              rule_id: rule.id,
              message: `facts.${f} 在判定点 ${point} 不可用`,
            })
          }
        }
      }

      // 3. action 必须在偏序中有定义
      if (!(rule.action in ACTION_STRICTNESS)) {
        errors.push({ rule_id: rule.id, message: `未定义的 action：${rule.action}` })
      }

      if (rule.points.length === 0) {
        errors.push({ rule_id: rule.id, message: 'points 为空 —— 该规则永远不会被求值' })
      }
    }

    // 4. 同 priority 且条件重叠
    //
    // 完整的重叠判定需要 SMT 求解，不成比例。这里用「条件文本相同」做保守近似。
    // 失效模式是**漏报而非误报** —— 这是刻意的：
    // 误报会让人开始忽略 warning，而那比漏报更糟。
    const byPriority = new Map<string, Rule[]>()
    for (const r of ruleset.rules) {
      for (const p of r.points) {
        const k = `${p}/${r.priority}`
        byPriority.set(k, [...(byPriority.get(k) ?? []), r])
      }
    }
    for (const [k, group] of byPriority) {
      const seen = new Map<string, string>()
      for (const r of group) {
        const prev = seen.get(r.condition)
        if (prev !== undefined) {
          warnings.push({
            rule_id: r.id,
            message: `与 ${prev} 在 ${k} 上同 priority 且条件相同`,
          })
        }
        seen.set(r.condition, r.id)
      }
    }

    // 5. 被前序 stop 完全遮蔽的规则
    //
    // 同样是保守近似：只认「前序存在条件恒为 true 且 stop 的规则」。
    for (const point of Object.keys(FACTS_AT) as DecisionPoint[]) {
      const ordered = ruleset.rules
        .filter((r) => r.points.includes(point))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      let blocker: string | undefined
      for (const r of ordered) {
        if (blocker !== undefined) {
          warnings.push({
            rule_id: r.id,
            message: `在 ${point} 上被 ${blocker}（条件恒真且 stop）完全遮蔽，永不可命中`,
          })
          continue
        }
        if (r.stop && r.condition.trim() === 'true') blocker = r.id
      }
    }

    return { ok: errors.length === 0, errors, warnings }
  }
}

function explain(matched: readonly Rule[], decision: PolicyAction): string {
  if (matched.length === 0) {
    return `无规则命中，按默认 deny 裁决为 ${decision}`
  }
  const ids = matched.map((r) => `${r.id}→${r.action}`).join('、')
  if (matched.length === 1) return `命中 ${ids}`
  return `命中 ${matched.length} 条（${ids}），按严格性偏序取最严者 ${decision}`
}
