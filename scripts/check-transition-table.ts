/**
 * C4：代码转移表 ⟷ 文档转移表 一致性检查。
 *
 * 问题：docs/04-state-machine.md 有 31 条 Task 级转移写在 markdown 表里，
 *       代码必须再写一遍。**两份东西不会自己保持同步。**
 *
 * 本任务的解法是**双向比对，而不是从文档生成代码**。
 * 理由：markdown 表格解析比较脆，一旦文档排版微调就会静默产出错误的表。
 *       比对失败只是报警，生成失败却可能悄悄生成错的东西 ——
 *       **前者的失效模式更安全。**
 *
 * 防假绿：解析到 0 行必须报错。否则"解析失败"会伪装成"无差异"。
 *
 * 2026-08-24（issue #21）：比对范围从 id/from/to 扩大到 guardText ——
 *   曾经代码 guardText 写 `decision=human_review` 而守卫是
 *   `decision != auto_develop`（T-013），文档跟着写错。
 *   guard <> guardText 分叉会让文档误导读者;这里要求两者逐条一致。
 */

import { readFileSync } from 'node:fs'
import { TASK_TRANSITIONS } from '../src/control/transition/table.js'

const DOC = 'docs/04-state-machine.md'

/** 转义竖线的占位符 —— T-030 的 event 单元格含 `RunFailed` \| `RunTimeout` */
const ESC = 'ESCPIPE'

interface DocRow {
  id: string
  from: string
  to: string
  /** guard 单元格（去反引号）。`—` 归一化为 null */
  guardText: string | null
}

/** 归一化 from 单元格 */
function normalizeFrom(cell: string): string {
  const t = cell.trim()
  if (t === '∅') return 'NULL'
  if (t.includes('任一阶段态')) return 'ANY_STAGE'
  if (t.includes('任一非终态')) return 'ANY_NON_TERMINAL'
  const m = t.match(/S-[A-Z_]+/)
  return m ? m[0] : t
}

/**
 * 归一化 to 单元格。
 *
 * 文档里自环有两种写法：`S-BRAINSTORM` ⟲（T-009）与 同状态 ⟲（T-030）。
 * 统一以 ⟲ 标记为准 —— 两者语义相同。
 */
function normalizeTo(cell: string): string {
  const t = cell.trim()
  if (t.includes('⟲') || t.includes('同状态')) return 'SELF'
  const m = t.match(/S-[A-Z_]+/)
  return m ? m[0] : t
}

/** 归一化 guard 单元格：去反引号；`—` 视为无守卫（null） */
function normalizeGuard(cell: string | undefined): string | null {
  const t = (cell ?? '').replace(/`/g, '').trim()
  if (t === '' || t === '—' || t === '——') return null
  return t
}

function parseDoc(): DocRow[] {
  const text = readFileSync(DOC, 'utf8')
  const rows: DocRow[] = []

  for (const raw of text.split('\n')) {
    // 只认「ID 在首列」的行 —— 文档中另有可达性自检表也提到 T-*，但 ID 不在首列。
    // 支持字母后缀(T-009b):critic 回流转移使用
    if (!/^\|\s*`T-\d{3}[a-z]?`\s*\|/.test(raw)) continue

    const cells = raw
      .replace(/\\\|/g, ESC)
      .split('|')
      .map((c) => c.replaceAll(ESC, '|').trim())
    // cells[0] 是行首 | 之前的空串
    const id = cells[1]?.replace(/`/g, '').trim()
    const from = cells[2]
    const to = cells[5]
    const guardText = normalizeGuard(cells[4])
    if (!id || from === undefined || to === undefined) continue

    rows.push({ id, from: normalizeFrom(from), to: normalizeTo(to), guardText })
  }
  return rows
}

/** 归一化代码侧的 from / to */
function codeFrom(v: string | null): string {
  return v === null ? 'NULL' : v
}

/** 归一化代码侧的 guardText：`—` 视为无守卫 */
function codeGuardText(v: string): string | null {
  const t = v.trim()
  return t === '' || t === '—' || t === '——' ? null : t
}

function main(): void {
  const docRows = parseDoc()

  // 防假绿
  if (docRows.length === 0) {
    console.error(`✗ 从 ${DOC} 解析到 0 条转移 —— 拒绝以"无差异"通过`)
    console.error('  多半是文档表格排版变了，请检查解析规则（ID 必须在首列）')
    process.exit(1)
  }

  const doc = new Map<string, DocRow>(docRows.map((r) => [r.id, r]))
  const code = new Map<string, { from: string; to: string; guardText: string | null }>(
    TASK_TRANSITIONS.map((r) => [
      r.id as string,
      {
        from: codeFrom(r.from),
        to: r.to as string,
        guardText: codeGuardText(r.guardText),
      },
    ]),
  )

  const problems: string[] = []

  for (const [id, d] of doc) {
    const c = code.get(id)
    if (!c) {
      problems.push(`  ${id}  文档里有，代码里没有`)
      continue
    }
    // 通用规则（from 非具体状态）只比对 to —— 文档写的是"任一阶段态"这类描述
    if (d.from !== c.from) {
      problems.push(`  ${id}  from 不一致：文档=${d.from} 代码=${c.from}`)
    }
    if (d.to !== c.to) {
      problems.push(`  ${id}  to 不一致：文档=${d.to} 代码=${c.to}`)
    }
    // guardText 逐条一致 —— 文档说守卫是什么,代码就要写同一句话(#1-14)
    if (d.guardText !== c.guardText) {
      problems.push(
        `  ${id}  guardText 不一致：文档=${d.guardText ?? '（无）'} 代码=${c.guardText ?? '（无）'}`,
      )
    }
  }

  for (const id of code.keys()) {
    if (!doc.has(id)) problems.push(`  ${id}  代码里有，文档里没有`)
  }

  if (problems.length > 0) {
    console.error(`✗ C4 转移表比对失败（文档 ${doc.size} 条 / 代码 ${code.size} 条）\n`)
    for (const p of problems) console.error(p)
    console.error(`\n改动任一侧后，另一侧必须同步：`)
    console.error(`  文档：${DOC} §2`)
    console.error(`  代码：src/control/transition/table.ts`)
    process.exit(1)
  }

  console.log(`✓ C4 转移表一致（${doc.size} 条，文档与代码逐条比对 id / from / to / guardText）`)
}

main()
