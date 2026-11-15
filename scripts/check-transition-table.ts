/**
 * C4：代码转移表 ⟷ 文档转移表一致性检查。
 * Task：id / from / event 集合 / to / guardText；控制表：C-001、C-003～C-006。
 * C-002 由预算熔断独立实现。Run 级没有共享转移表，不在此范围。
 * 只用双向比对，不从文档生成代码；空表、坏行、重复 ID 和缺行均失败。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CONTROL_TRANSITIONS } from '../src/control/transition/control-mode.js'
import { TASK_TRANSITIONS } from '../src/control/transition/table.js'
import type { TransitionRule } from '../src/control/transition/types.js'

const DEFAULT_DOC = 'docs/04-state-machine.md'
const ESCAPED_PIPE = '\u0000'
const TASK_ROW = /^\s*\|?\s*`?T-[^|`]*`?\s*\|/
const CONTROL_ROW = /^\s*\|?\s*`?C-[^|`]*`?\s*\|/
const TASK_ID = /^T-\d{3}[a-z]?$/
const CONTROL_ID = /^C-\d{3}$/
const TASK_FIELDS = ['id', 'from', 'event', 'guard', 'to', 'side-effect']
const CONTROL_FIELDS = ['id', 'from', 'event', 'to', 'side-effect']

type ProblemSource = 'task-doc' | 'control-doc' | 'task-code' | 'control-code'
type TaskRule = Pick<TransitionRule, 'id' | 'from' | 'on' | 'guardText' | 'to'>
type ControlRule = (typeof CONTROL_TRANSITIONS)[number]
type RawRow = { id: string; line: number; cells: string[]; offset: number }
type Parsed<T> = { rows: T[]; problems: TransitionDocProblem[] }

export type TransitionDocProblem = { source: ProblemSource; line: number | null; message: string }
type Count = 'taskDocCount' | 'taskCodeCount' | 'controlDocCount' | 'controlCodeCount'
export type TransitionCheckReport = Readonly<Record<Count, number>> & {
  problems: readonly TransitionDocProblem[]
}

const stripCode = (value: string): string => value.replace(/`/g, '').trim()
const eventSet = (types: readonly string[]): string => `{${[...new Set(types)].sort().join(', ')}}`
const fail = (
  problems: TransitionDocProblem[],
  source: ProblemSource,
  line: number | null,
  message: string,
): number => problems.push({ source, line, message })

function splitRow(line: string): string[] {
  return line
    .replace(/\\\|/g, ESCAPED_PIPE)
    .split('|')
    .map((cell) => cell.replaceAll(ESCAPED_PIPE, '\\|').trim())
}

function normalizeFrom(value: string): string {
  const text = stripCode(value)
  if (text === '∅') return 'NULL'
  if (text.includes('任一阶段态')) return 'ANY_STAGE'
  if (text.includes('任一非终态')) return 'ANY_NON_TERMINAL'
  return text.match(/S-[A-Z_]+/)?.[0] ?? text
}

function normalizeTo(value: string): string {
  const text = stripCode(value)
  if (text.includes('⟲') || text.includes('同状态')) return 'SELF'
  return text.match(/S-[A-Z_]+/)?.[0] ?? text
}

const normalizeGuard = (value: string | undefined): string | null => {
  const text = stripCode(value ?? '')
  return text === '' || text === '—' || text === '——' ? null : text
}

function eventTypes(value: string, line: number, problems: TransitionDocProblem[]): string[] {
  const parts = stripCode(value)
    .split(/\s*\\\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  const types = parts
    .map((part) => {
      const type = part.match(/^([A-Z][A-Za-z0-9]*)(?:\s*\([^()]*\))?$/)?.[1]
      if (type === undefined) fail(problems, 'task-doc', line, `event 片段格式无效：${part}`)
      return type
    })
    .filter((type): type is string => type !== undefined)
  if (new Set(types).size !== types.length) {
    fail(problems, 'task-doc', line, 'event 单元格含重复类型')
  }
  return [...new Set(types)].sort()
}

function duplicateIds(
  rows: readonly { id: string; line?: number | null }[],
  source: ProblemSource,
  problems: TransitionDocProblem[],
): void {
  const seen = new Map<string, number>()
  for (const row of rows) {
    const count = seen.get(row.id) ?? 0
    if (count === 1) fail(problems, source, row.line ?? null, `重复 ID：${row.id}`)
    seen.set(row.id, count + 1)
  }
}

/** Task / Control 共用行定位、表格边界、字段、重复 ID 与空表校验。 */
function parseRows<T extends { id: string; line: number }>(
  text: string,
  source: 'task-doc' | 'control-doc',
  label: string,
  pattern: RegExp,
  idPattern: RegExp,
  fields: readonly string[],
  optional: readonly number[],
  emptyMessage: string,
  map: (row: RawRow, problems: TransitionDocProblem[]) => T,
): Parsed<T> {
  const rows: T[] = []
  const problems: TransitionDocProblem[] = []
  for (const [index, raw] of text.split('\n').entries()) {
    if (!pattern.test(raw)) continue
    const line = index + 1
    const cells = splitRow(raw)
    const leading = /^\s*\|/.test(raw)
    const trailing = /\|\s*$/.test(raw)
    const offset = leading ? 1 : 0
    if (!leading || !trailing || cells.length !== fields.length + 2) {
      fail(problems, source, line, `${label}转移行列数错误或边界损坏`)
    }
    const id = stripCode(cells[offset] ?? '')
    if (!idPattern.test(id)) {
      fail(problems, source, line, `${label}转移 ID 格式无效：${id || '（空）'}`)
      continue
    }
    const empty = fields.some(
      (_, index) => !optional.includes(index) && (cells[offset + index] ?? '').trim() === '',
    )
    if (empty) fail(problems, source, line, `${id} 含空字段`)
    rows.push(map({ id, line, cells, offset }, problems))
  }
  duplicateIds(rows, source, problems)
  if (rows.length === 0) fail(problems, source, null, emptyMessage)
  return { rows, problems }
}

export function parseTaskTransitions(text: string) {
  return parseRows(
    text,
    'task-doc',
    'Task ',
    TASK_ROW,
    TASK_ID,
    TASK_FIELDS,
    [3],
    'Task 表解析到 0 条转移 —— 拒绝以“无差异”通过',
    (row, problems) => {
      const [, from, event, guard, to] = row.cells.slice(row.offset)
      return {
        id: row.id,
        line: row.line,
        from: normalizeFrom(from ?? ''),
        eventTypes: event ? eventTypes(event, row.line, problems) : [],
        to: normalizeTo(to ?? ''),
        guardText: normalizeGuard(guard),
      }
    },
  )
}

export function parseControlTransitions(text: string) {
  return parseRows(
    text,
    'control-doc',
    '控制模式',
    CONTROL_ROW,
    CONTROL_ID,
    CONTROL_FIELDS,
    [],
    '控制模式表解析到 0 条转移 —— 拒绝以“无差异”通过',
    (row) => {
      const [, from, event, to] = row.cells.slice(row.offset)
      return {
        id: row.id,
        line: row.line,
        from: stripCode(from ?? ''),
        event: stripCode(event ?? ''),
        to: stripCode(to ?? ''),
      }
    },
  )
}

function compareRows<D extends { id: string; line: number }, C extends { id: string }>(
  docRows: readonly D[],
  codeRows: readonly C[],
  docValues: (row: D) => readonly (string | null)[],
  codeValues: (rule: C) => readonly (string | null)[],
  docSource: 'task-doc' | 'control-doc',
  codeSource: 'task-code' | 'control-code',
  codeLabel: string,
  fields: readonly string[],
): TransitionDocProblem[] {
  const problems: TransitionDocProblem[] = []
  duplicateIds(codeRows, codeSource, problems)
  const doc = new Map(docRows.map((row) => [row.id, row]))
  const code = new Map(codeRows.map((row) => [row.id, row]))
  for (const [id, row] of doc) {
    const rule = code.get(id)
    if (rule === undefined) {
      fail(problems, docSource, row.line, `${id} 文档里有，${codeLabel}里没有`)
      continue
    }
    const actual = docValues(row)
    const expected = codeValues(rule)
    fields.forEach((name, index) => {
      if (actual[index] !== expected[index]) {
        fail(
          problems,
          docSource,
          row.line,
          `${id} ${name} 不一致：${actual[index] ?? '-'} ≠ ${expected[index] ?? '-'}`,
        )
      }
    })
  }
  for (const id of code.keys()) {
    if (!doc.has(id)) fail(problems, codeSource, null, `${id} ${codeLabel}里有，文档里没有`)
  }
  return problems
}

function compareTaskTransitions(
  docRows: ReturnType<typeof parseTaskTransitions>['rows'],
  codeRules: readonly TaskRule[],
): TransitionDocProblem[] {
  return compareRows(
    docRows,
    codeRules,
    (row) => [row.from, eventSet(row.eventTypes), row.to, row.guardText],
    (rule) => [rule.from ?? 'NULL', eventSet(rule.on), rule.to, normalizeGuard(rule.guardText)],
    'task-doc',
    'task-code',
    '代码',
    ['from', 'event', 'to', 'guardText'],
  )
}

function compareControlTransitions(
  docRows: ReturnType<typeof parseControlTransitions>['rows'],
  codeRules: readonly ControlRule[],
): TransitionDocProblem[] {
  const problems: TransitionDocProblem[] = []
  const budget = docRows.find((row) => row.id === 'C-002')
  if (budget === undefined) {
    fail(problems, 'control-doc', null, 'C-002 预算熔断行缺失')
  } else if (`${budget.from}/${budget.event}/${budget.to}` !== 'auto/BudgetExceeded/paused') {
    fail(problems, 'control-doc', budget.line, 'C-002 预算契约不一致')
  }
  if (codeRules.some((rule) => rule.id === 'C-002')) {
    fail(problems, 'control-code', null, 'CONTROL_TRANSITIONS 不得包含 C-002')
  }
  return [
    ...problems,
    ...compareRows(
      docRows.filter((row) => row.id !== 'C-002'),
      codeRules.filter((rule) => rule.id !== 'C-002'),
      (row) => [row.from, row.event, row.to],
      (rule) => [rule.from, rule.event, rule.to],
      'control-doc',
      'control-code',
      '共享控制转移表',
      ['from', 'event', 'to'],
    ),
  ]
}

export function checkTransitionDocs(
  documentText: string,
  taskRules: readonly TaskRule[] = TASK_TRANSITIONS,
  controlRules: readonly ControlRule[] = CONTROL_TRANSITIONS,
): TransitionCheckReport {
  const task = parseTaskTransitions(documentText)
  const control = parseControlTransitions(documentText)
  return {
    taskDocCount: task.rows.length,
    taskCodeCount: taskRules.length,
    controlDocCount: control.rows.length,
    controlCodeCount: controlRules.length,
    problems: [
      ...task.problems,
      ...control.problems,
      ...compareTaskTransitions(task.rows, taskRules),
      ...compareControlTransitions(control.rows, controlRules),
    ],
  }
}

function printProblems(problems: readonly TransitionDocProblem[], docPath: string): void {
  const details = problems
    .map(
      ({ source, line, message }) =>
        `  ${line === null ? source : `${source}:${line}`}  ${message}`,
    )
    .join('\n')
  console.error(
    `✗ C4 转移表比对失败（${problems.length} 项，文档 ${docPath}）\n${details}\n\n` +
      `改动任一侧后，另一侧必须同步：\n  ${docPath} §2 / §3.1\n` +
      '  Task：src/control/transition/table.ts\n' +
      '  控制：src/control/transition/control-mode.ts；C-002：src/control/budget/fuse.ts\n' +
      '  Run 级转移没有共享纯转移表，本检查不作声明。',
  )
}

function main(docPath: string): void {
  let text: string
  try {
    text = readFileSync(docPath, 'utf8')
  } catch (error) {
    console.error(
      `✗ 无法读取 ${docPath}：${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
    return
  }
  const report = checkTransitionDocs(text)
  if (report.problems.length > 0) {
    printProblems(report.problems, docPath)
    process.exitCode = 1
    return
  }
  console.log(
    `✓ C4 转移表一致（Task ${report.taskDocCount} 条：id / from / event / to / guardText；` +
      `控制 ${report.controlCodeCount} 条：id / from / event / to；` +
      'C-002 单独核对 auto / BudgetExceeded / paused；Run 未覆盖）',
  )
}

const entryPath = process.argv[1]
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  main(process.argv[2] ?? DEFAULT_DOC)
}
