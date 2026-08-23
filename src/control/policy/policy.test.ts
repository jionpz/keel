import { describe, expect, it } from 'vitest'
import type { FactSet, Rule, Ruleset } from '../../contracts/policy-engine.js'
import { RuleBasedPolicyEngine } from './engine.js'
import { collectFields, ExprError, evaluateExpr, parse } from './expr.js'
import { DEFAULT_RULESET } from './ruleset.js'

const AT = '2026-08-23T10:00:00Z'
const engine = new RuleBasedPolicyEngine(DEFAULT_RULESET)

const ev = (src: string, facts: FactSet = {}) => evaluateExpr(parse(src), facts)

// ─────────────────────────────── 表达式 ───────────────────────────────

describe('受限表达式语言', () => {
  it('比较运算', () => {
    expect(ev("facts.risk == 'high'", { risk: 'high' })).toBe(true)
    expect(ev("facts.risk != 'high'", { risk: 'low' })).toBe(true)
    expect(ev('facts.n > 30', { n: 31 })).toBe(true)
    expect(ev('facts.n >= 30', { n: 30 })).toBe(true)
    expect(ev('facts.n < 30', { n: 29 })).toBe(true)
    expect(ev('facts.n <= 30', { n: 30 })).toBe(true)
  })

  it('布尔运算与优先级：&& 紧于 ||', () => {
    // false || (true && true) === true
    expect(ev('false || true && true')).toBe(true)
    // (false && true) || false === false
    expect(ev('false && true || false')).toBe(false)
  })

  it('括号改变结合', () => {
    expect(ev('(false || true) && false')).toBe(false)
    expect(ev('false || (true && false)')).toBe(false)
  })

  it('取反', () => {
    expect(ev('!facts.b', { b: false })).toBe(true)
    expect(ev('!(facts.n > 5)', { n: 1 })).toBe(true)
  })

  it('collectFields 抽出全部引用的 fact', () => {
    const ast = parse("facts.a == 'x' && (facts.b > 1 || !facts.c)")
    expect(collectFields(ast)).toEqual(['a', 'b', 'c'])
  })

  describe('拒绝不允许的语法', () => {
    const bad: [string, string][] = [
      ['函数调用', 'foo(1)'],
      ['裸标识符', 'risk == 1'],
      ['多层属性', 'facts.a.b == 1'],
      ['赋值', 'facts.a = 1'],
      ['算术', 'facts.a + 1 > 2'],
      ['未闭合括号', '(facts.a == 1'],
      ['未闭合字符串', "facts.a == 'x"],
      ['空表达式', ''],
    ]
    for (const [name, src] of bad) {
      it(`拒绝${name}：${src || '(空)'}`, () => {
        expect(() => parse(src)).toThrow()
      })
    }
  })

  it('引用未提供的 fact 时抛错，而不是静默当作 false', () => {
    // 静默当 false 会让规则「不命中」，等于悄悄放行
    expect(() => ev('facts.missing == 1', {})).toThrow(ExprError)
  })

  it('条件必须求出布尔值', () => {
    expect(() => ev('facts.n', { n: 1 })).toThrow(ExprError)
  })
})

// ─────────────────── 核心：初稿 §12 那个未被察觉的冲突 ───────────────────

describe('严格性偏序裁决', () => {
  const securityFix: FactSet = {
    risk: 'low',
    complexity: 'low',
    estimated_files_changed: 3,
    security_related: true,
    critic_confidence: 0.9,
  }

  it('低复杂度 + 低风险的安全修复 → security_review，不是 auto_develop', () => {
    const r = engine.evaluate('rfc_ready', securityFix, AT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 这正是初稿没说清的地方：按「最后匹配优先」会得到 auto_develop，
    // 等于把安全改动自动放行了
    expect(r.value.decision).toBe('security_review')
  })

  it('matched_rules 如实记录两条命中，而不是只记胜出的那条', () => {
    const r = engine.evaluate('rfc_ready', securityFix, AT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.value.matched_rules.map((m) => m.id).sort()
    expect(ids).toEqual(['P3', 'P4'])
    expect(r.value.matched_rules.map((m) => m.action)).toContain('auto_develop')
  })

  it('调换规则在文件中的书写顺序，裁决结果不变', () => {
    const reversed: Ruleset = {
      version: DEFAULT_RULESET.version,
      rules: [...DEFAULT_RULESET.rules].reverse(),
    }
    const a = engine.evaluate('rfc_ready', securityFix, AT)
    const b = new RuleBasedPolicyEngine(reversed).evaluate('rfc_ready', securityFix, AT)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.value.decision).toBe(a.value.decision)
    expect(b.value.matched_rules.map((m) => m.id).sort()).toEqual(
      a.value.matched_rules.map((m) => m.id).sort(),
    )
  })

  it('干净的低风险小改动 → auto_develop', () => {
    const r = engine.evaluate('rfc_ready', { ...securityFix, security_related: false }, AT)
    expect(r.ok && r.value.decision).toBe('auto_develop')
  })

  it('高风险 → human_review（比 security_review 更严）', () => {
    const r = engine.evaluate(
      'rfc_ready',
      { ...securityFix, risk: 'high', security_related: true },
      AT,
    )
    expect(r.ok && r.value.decision).toBe('human_review')
  })
})

describe('默认 deny', () => {
  it('无规则命中时裁决为 human_review 且 default_applied = true', () => {
    const r = engine.evaluate(
      'rfc_ready',
      {
        risk: 'medium',
        complexity: 'medium',
        estimated_files_changed: 5,
        security_related: false,
        critic_confidence: 0.8,
      },
      AT,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.decision).toBe('human_review')
    // 不记录的话，默认 deny 会安静地把系统退化成全人工而没人察觉
    expect(r.value.default_applied).toBe(true)
    expect(r.value.matched_rules).toHaveLength(0)
  })
})

describe('纯函数', () => {
  it('相同输入重复求值 100 次，结果深相等', () => {
    const facts: FactSet = {
      risk: 'low',
      complexity: 'low',
      estimated_files_changed: 3,
      security_related: true,
      critic_confidence: 0.9,
    }
    const results = Array.from({ length: 100 }, () => engine.evaluate('rfc_ready', facts, AT))
    for (const r of results) expect(r).toEqual(results[0])
  })

  it('facts_snapshot 是快照 —— 事后修改入参不影响已产出的裁决', () => {
    const facts: FactSet = {
      risk: 'high',
      complexity: 'low',
      estimated_files_changed: 1,
      security_related: false,
      critic_confidence: 1,
    }
    const r = engine.evaluate('rfc_ready', facts, AT)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const snapshot = { ...(r.value.facts_snapshot as Record<string, unknown>) }
    ;(facts as Record<string, unknown>).risk = 'low'
    expect(r.value.facts_snapshot).toEqual(snapshot)
  })
})

describe('判定点划分', () => {
  it('rfc_ready 不会去求值引用运行期 fact 的规则', () => {
    // 若不按判定点划分，P-DRIFT 会因 facts.files_drift_ratio 未提供而抛错
    const r = engine.evaluate(
      'rfc_ready',
      {
        risk: 'low',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
        critic_confidence: 1,
      },
      AT,
    )
    expect(r.ok).toBe(true)
  })

  it('post_develop 上漂移超阈值 → architecture_review', () => {
    const r = engine.evaluate(
      'post_develop',
      { actual_files_changed: 40, estimated_files_changed: 4, files_drift_ratio: 10, risk: 'low' },
      AT,
    )
    expect(r.ok && r.value.decision).toBe('architecture_review')
    expect(r.ok && r.value.matched_rules.map((m) => m.id)).toContain('P-DRIFT')
  })
})

// ─────────────────────────── validate 的反例 ───────────────────────────

describe('validate() —— 每项检查都有会被它抓住的坏规则集', () => {
  const rule = (over: Partial<Rule>): Rule => ({
    id: 'X',
    points: ['rfc_ready'],
    priority: 1,
    condition: "facts.risk == 'low'",
    action: 'auto_develop',
    stop: false,
    ...over,
  })
  const rs = (rules: Rule[]): Ruleset => ({ version: 'test', rules })

  it('默认规则集本身通过 validate()', () => {
    const r = engine.validate(DEFAULT_RULESET)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('语法错误的 condition → error', () => {
    const r = engine.validate(rs([rule({ condition: 'facts.a ==' })]))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/语法错误/)
  })

  it('引用未注册的 fact → error', () => {
    const r = engine.validate(rs([rule({ condition: 'facts.nonexistent == 1' })]))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/未注册的 fact/)
  })

  it('引用在该判定点不可用的 fact → error', () => {
    // tests_failed 是运行期 fact，rfc_ready 时还不存在
    const r = engine.validate(rs([rule({ condition: 'facts.tests_failed >= 3' })]))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/在判定点 rfc_ready 不可用/)
  })

  it('未定义的 action → error', () => {
    const r = engine.validate(rs([rule({ action: 'yolo' as Rule['action'] })]))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/未定义的 action/)
  })

  it('points 为空 → error（该规则永远不会被求值）', () => {
    const r = engine.validate(rs([rule({ points: [] })]))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toMatch(/points 为空/)
  })

  it('同 priority 且条件相同 → warning', () => {
    const r = engine.validate(rs([rule({ id: 'A' }), rule({ id: 'B' })]))
    expect(r.errors).toEqual([])
    expect(r.warnings[0]?.message).toMatch(/同 priority 且条件相同/)
  })

  it('被恒真的 stop 规则遮蔽 → warning', () => {
    const r = engine.validate(
      rs([
        rule({ id: 'BLOCK', priority: 999, condition: 'true', stop: true, action: 'reject' }),
        rule({ id: 'DEAD', priority: 1 }),
      ]),
    )
    expect(r.warnings.some((w) => w.rule_id === 'DEAD' && /遮蔽/.test(w.message))).toBe(true)
  })
})
