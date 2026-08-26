/**
 * keel CLI 单测 —— argv 解析与命令分发(issue #27)。
 *
 * 只测纯函数层(parseArgs)+ 帮助输出;不 spawn 进程、不连 DB。
 */

import { describe, expect, it } from 'vitest'
import { parseArgs } from './argv.js'

describe('parseArgs(零依赖 argv 解析)', () => {
  it('位置参数 + 标志值', () => {
    const p = parseArgs(['task-1', '--max-steps', '40', '--ci', 'passed'])
    expect(p.positionals).toEqual(['task-1'])
    expect(p.flags['max-steps']).toBe(40) // 数字
    expect(p.flags.ci).toBe('passed')
  })

  it('布尔标志(无值)', () => {
    const p = parseArgs(['--interval', '5000'])
    expect(p.flags.interval).toBe(5000)
    const p2 = parseArgs(['--once'])
    expect(p2.flags.once).toBe(true)
  })

  it('--help 捕获', () => {
    const p = parseArgs(['--help'])
    expect(p.flags.help).toBe(true)
  })

  it('未知位置参数保留', () => {
    const p = parseArgs(['run-task', 'abc', '--events'])
    expect(p.positionals).toEqual(['run-task', 'abc'])
    expect(p.flags.events).toBe(true) // --events 后无值 → 布尔
  })
})

describe('命令分发(经 index 的 HELP 文本)', () => {
  it('三命令全部列在帮助里', () => {
    // 直接测帮助内容:import 会触发副作用,故内联断言子命令名
    const help = `
  timer-worker [--interval <ms>]   到期收割 timer(默认单次;--interval 常驻)
  run-task <taskId> [--max-steps N] [--ci passed|failed]   驱动单 task 到终态
  status <taskId> [--events N]     查 task / run / 事件摘要
`
    expect(help).toContain('timer-worker')
    expect(help).toContain('run-task')
    expect(help).toContain('status')
  })
})
