import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checkTransitionDocs,
  parseControlTransitions,
  parseTaskTransitions,
} from '../../../scripts/check-transition-table.js'
import { CONTROL_TRANSITIONS } from './control-mode.js'
import { TASK_TRANSITIONS } from './table.js'

const documentText = readFileSync(
  new URL('../../../docs/04-state-machine.md', import.meta.url),
  'utf8',
)

function rowFor(id: string): string {
  const row = documentText.split('\n').find((line) => line.trimStart().startsWith(`| \`${id}\``))
  if (row === undefined) throw new Error(`找不到 ${id} 文档行`)
  return row
}

describe('C4 转移文档检查', () => {
  it('正文文档通过，并归一化多事件与带细节的事件类型', () => {
    const report = checkTransitionDocs(documentText)
    expect(report.problems).toEqual([])
    expect(report.taskDocCount).toBe(report.taskCodeCount)
    expect(report.controlDocCount).toBe(6)
    expect(report.controlCodeCount).toBe(5)

    const t030 = parseTaskTransitions(documentText).rows.find((row) => row.id === 'T-030')
    expect(t030?.eventTypes).toEqual(['RunFailed', 'RunStalled', 'RunTimeout'])

    const c002 = parseControlTransitions(documentText).rows.find((row) => row.id === 'C-002')
    expect(c002).toMatchObject({ from: 'auto', event: 'BudgetExceeded', to: 'paused' })
  })

  it('事件类型被改时失败', () => {
    const original = rowFor('T-010')
    const changed = documentText.replace(
      original,
      original.replace('`RunSucceeded`', '`RunFailed`'),
    )

    expect(checkTransitionDocs(changed).problems).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('T-010 event 不一致'),
      }),
    )
  })

  it('重复 ID 时失败', () => {
    const original = rowFor('T-003')
    const duplicated = documentText.replace(original, `${original}\n${original}`)

    expect(checkTransitionDocs(duplicated).problems).toContainEqual(
      expect.objectContaining({ message: '重复 ID：T-003' }),
    )
  })

  it('看起来是转移但结构损坏的行会让检查失败', () => {
    const original = rowFor('T-003')
    const damaged = documentText.replace(
      original,
      original.replace(' | `RunSucceeded` |', ' `RunSucceeded` |'),
    )

    expect(checkTransitionDocs(damaged).problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('列数错误') }),
    )
  })

  it('Task 或控制模式表为 0 行时拒绝假绿', () => {
    const problems = checkTransitionDocs('').problems
    expect(problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('Task 表解析到 0 条') }),
    )
    expect(problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('控制模式表解析到 0 条') }),
    )
  })

  it('共享控制转移的事件被改时失败', () => {
    const original = rowFor('C-003')
    const changed = documentText.replace(original, original.replace('HumanTakeover', 'HumanResume'))

    expect(checkTransitionDocs(changed).problems).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('C-003 event 不一致'),
      }),
    )
  })

  it('代码侧重复 ID 或漏行时失败', () => {
    const firstTask = TASK_TRANSITIONS[0]
    if (firstTask === undefined) throw new Error('Task 转移表为空')
    const duplicateTask = [...TASK_TRANSITIONS, firstTask]
    const missingControl = CONTROL_TRANSITIONS.filter((rule) => rule.id !== 'C-001')

    expect(checkTransitionDocs(documentText, duplicateTask).problems).toContainEqual(
      expect.objectContaining({ message: '重复 ID：T-001' }),
    )
    expect(
      checkTransitionDocs(documentText, TASK_TRANSITIONS, missingControl).problems,
    ).toContainEqual(
      expect.objectContaining({
        message: 'C-001 文档里有，共享控制转移表里没有',
      }),
    )
  })

  it('文档多出一行时失败', () => {
    const original = rowFor('T-003')
    const extra = original.replace('T-003', 'T-999')
    const changed = documentText.replace(original, `${original}\n${extra}`)

    expect(checkTransitionDocs(changed).problems).toContainEqual(
      expect.objectContaining({ message: 'T-999 文档里有，代码里没有' }),
    )
  })

  it('Task 的 guard、from、to 任一漂移时失败', () => {
    const changedRules = TASK_TRANSITIONS.map((rule) =>
      rule.id === 'T-013'
        ? {
            ...rule,
            from: 'S-QA' as const,
            to: 'S-DONE' as const,
            guardText: 'decision=wrong',
          }
        : rule,
    )
    const messages = checkTransitionDocs(documentText, changedRules).problems.map(
      (problem) => problem.message,
    )

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('T-013 from 不一致'),
        expect.stringContaining('T-013 to 不一致'),
        expect.stringContaining('T-013 guardText 不一致'),
      ]),
    )
  })

  it('C-002 预算契约被改时失败', () => {
    const original = rowFor('C-002')
    const changed = documentText.replace(
      original,
      original.replace('BudgetExceeded', 'BudgetMissing'),
    )

    expect(checkTransitionDocs(changed).problems).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('C-002 预算契约不一致') }),
    )
  })
})
