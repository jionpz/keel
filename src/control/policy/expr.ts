/**
 * 受限表达式语言：解析与求值。
 *
 * 定义处：docs/05-contracts/policy-engine.md §5
 *
 * **刻意不用 eval / new Function。** 契约要求求值可终止、可静态分析、可审计，
 * 而 eval 会同时废掉这三点：
 *   - validate() 无法在加载时检查语法与 fact 引用，只能等运行时炸
 *   - 表达式里能写循环
 *   - 规则从「一句可读的条件」退化成「一段代码」
 * 还有一层：规则文件可能来自配置仓库，eval 会把它变成代码注入面。
 *
 * 文法：
 *   expr    := or
 *   or      := and ( '||' and )*
 *   and     := cmp ( '&&' cmp )*
 *   cmp     := unary ( ('=='|'!='|'>'|'>='|'<'|'<=') unary )?
 *   unary   := '!' unary | primary
 *   primary := '(' expr ')' | field | number | string | bool
 *   field   := 'facts' '.' IDENT      -- 只允许一层，禁止任意属性链
 *
 * field 限制为单层是为了让 collectFields() 能**可靠地**抽出全部被引用的 fact 名 ——
 * 这是 validate() 检查「引用的 fact 是否存在」的前提。
 */

export type Value = string | number | boolean

export type CmpOp = '==' | '!=' | '>' | '>=' | '<' | '<='

export type Ast =
  | { readonly t: 'or'; readonly l: Ast; readonly r: Ast }
  | { readonly t: 'and'; readonly l: Ast; readonly r: Ast }
  | { readonly t: 'not'; readonly e: Ast }
  | { readonly t: 'cmp'; readonly op: CmpOp; readonly l: Ast; readonly r: Ast }
  | { readonly t: 'field'; readonly name: string }
  | { readonly t: 'lit'; readonly v: Value }

export class ExprError extends Error {}

// ─────────────────────────────── 词法 ───────────────────────────────

type Token =
  | { k: 'op'; v: string }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ident'; v: string }

const OPS = ['==', '!=', '>=', '<=', '&&', '||', '>', '<', '!', '(', ')', '.']

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i] as string

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // 字符串字面量，支持单双引号
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1)
      if (end === -1) throw new ExprError(`未闭合的字符串，起始于位置 ${i}`)
      out.push({ k: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }

    // 数字
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j++
      const text = src.slice(i, j)
      const n = Number(text)
      if (Number.isNaN(n)) throw new ExprError(`非法数字 ${text}`)
      out.push({ k: 'num', v: n })
      i = j
      continue
    }

    // 标识符
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j++
      out.push({ k: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }

    // 运算符（长的优先，避免 >= 被切成 > 和 =）
    const op = OPS.find((o) => src.startsWith(o, i))
    if (op === undefined) throw new ExprError(`无法识别的字符 "${ch}"（位置 ${i}）`)
    out.push({ k: 'op', v: op })
    i += op.length
  }

  return out
}

// ─────────────────────────────── 语法 ───────────────────────────────

class Parser {
  private pos = 0

  constructor(private readonly toks: Token[]) {}

  parse(): Ast {
    const e = this.or()
    if (this.pos < this.toks.length) {
      throw new ExprError(`表达式末尾有多余内容（位置 ${this.pos}）`)
    }
    return e
  }

  private peek(): Token | undefined {
    return this.toks[this.pos]
  }

  private eatOp(v: string): boolean {
    const t = this.peek()
    if (t !== undefined && t.k === 'op' && t.v === v) {
      this.pos++
      return true
    }
    return false
  }

  private or(): Ast {
    let l = this.and()
    while (this.eatOp('||')) l = { t: 'or', l, r: this.and() }
    return l
  }

  private and(): Ast {
    let l = this.cmp()
    while (this.eatOp('&&')) l = { t: 'and', l, r: this.cmp() }
    return l
  }

  private cmp(): Ast {
    const l = this.unary()
    for (const op of ['==', '!=', '>=', '<=', '>', '<'] as const) {
      if (this.eatOp(op)) return { t: 'cmp', op, l, r: this.unary() }
    }
    return l
  }

  private unary(): Ast {
    if (this.eatOp('!')) return { t: 'not', e: this.unary() }
    return this.primary()
  }

  private primary(): Ast {
    const t = this.peek()
    if (t === undefined) throw new ExprError('表达式意外结束')

    if (t.k === 'op' && t.v === '(') {
      this.pos++
      const e = this.or()
      if (!this.eatOp(')')) throw new ExprError('缺少右括号')
      return e
    }

    if (t.k === 'num') {
      this.pos++
      return { t: 'lit', v: t.v }
    }

    if (t.k === 'str') {
      this.pos++
      return { t: 'lit', v: t.v }
    }

    if (t.k === 'ident') {
      if (t.v === 'true' || t.v === 'false') {
        this.pos++
        return { t: 'lit', v: t.v === 'true' }
      }
      // 只接受 facts.<ident>；裸标识符与多层属性链一律拒绝
      if (t.v !== 'facts') {
        throw new ExprError(`只允许访问 facts.<name>，收到 "${t.v}"`)
      }
      this.pos++
      if (!this.eatOp('.')) throw new ExprError('facts 之后必须跟 .<name>')
      const name = this.peek()
      if (name === undefined || name.k !== 'ident') {
        throw new ExprError('facts. 之后必须是标识符')
      }
      this.pos++
      // 禁止 facts.a.b
      if (this.peek()?.k === 'op' && (this.peek() as { v: string }).v === '.') {
        throw new ExprError('不支持多层属性访问（facts.a.b）')
      }
      return { t: 'field', name: name.v }
    }

    throw new ExprError(`意外的记号 ${JSON.stringify(t)}`)
  }
}

export function parse(condition: string): Ast {
  return new Parser(tokenize(condition)).parse()
}

// ─────────────────────────────── 分析与求值 ───────────────────────────────

/** 抽出表达式引用的全部 fact 名 —— validate() 用它检查引用是否存在 */
export function collectFields(ast: Ast): string[] {
  const out = new Set<string>()
  const walk = (n: Ast): void => {
    switch (n.t) {
      case 'field':
        out.add(n.name)
        return
      case 'lit':
        return
      case 'not':
        walk(n.e)
        return
      default:
        walk(n.l)
        walk(n.r)
    }
  }
  walk(ast)
  return [...out].sort()
}

function evalNode(n: Ast, facts: Readonly<Record<string, Value>>): Value {
  switch (n.t) {
    case 'lit':
      return n.v
    case 'field': {
      const v = facts[n.name]
      if (v === undefined) throw new ExprError(`facts.${n.name} 未提供`)
      return v
    }
    case 'not':
      return !truthy(evalNode(n.e, facts))
    case 'and':
      return truthy(evalNode(n.l, facts)) && truthy(evalNode(n.r, facts))
    case 'or':
      return truthy(evalNode(n.l, facts)) || truthy(evalNode(n.r, facts))
    case 'cmp': {
      const l = evalNode(n.l, facts)
      const r = evalNode(n.r, facts)
      switch (n.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        default: {
          if (typeof l !== 'number' || typeof r !== 'number') {
            throw new ExprError(`${n.op} 只支持数字比较，收到 ${typeof l} 与 ${typeof r}`)
          }
          if (n.op === '>') return l > r
          if (n.op === '>=') return l >= r
          if (n.op === '<') return l < r
          return l <= r
        }
      }
    }
  }
}

function truthy(v: Value): boolean {
  if (typeof v !== 'boolean') {
    throw new ExprError(`期望布尔值，收到 ${typeof v}（${String(v)}）`)
  }
  return v
}

/** 求值。结果必须是布尔 —— 条件表达式不允许求出别的类型 */
export function evaluateExpr(ast: Ast, facts: Readonly<Record<string, Value>>): boolean {
  return truthy(evalNode(ast, facts))
}
