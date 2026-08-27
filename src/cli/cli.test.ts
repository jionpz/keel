/**
 * keel CLI 单测 —— argv 解析与命令分发(issue #27)。
 *
 * 只测纯函数层(parseArgs / parseCiMode)+ 帮助输出;不 spawn 进程、不连 DB。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './argv.js'
import { CI_MODES, parseCiMode } from './run-task.js'

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

/**
 * index.ts 在模块顶层就 main()，import 会真的执行 CLI —— 所以读源码而非 import。
 *
 * 读源码是刻意的：断言一份手抄的 HELP 副本包含哪些命令，等于测试自己写的字面量,
 * 加了 case 忘了改帮助时照样是绿的。这里比对的是 index.ts 里**实际**的两份清单。
 */
describe('命令分发 · switch 分支与 HELP 清单不得漂移', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  /** switch 里的子命令(排除 --version / -h 这类标志与 undefined 兜底) */
  function dispatchedCommands(): string[] {
    return [...source.matchAll(/^\s*case '([^']+)':/gm)]
      .map((m) => m[1] as string)
      .filter((c) => !c.startsWith('-'))
      .sort()
  }

  /** HELP 文本「命令:」段每行的首个 token */
  function documentedCommands(): string[] {
    // 行首锚定:顶部文档注释里的「 * 子命令:」不是 HELP 模板,不能误抓
    const block = source.match(/^命令:\n([\s\S]*?)\n\n选项:/m)
    expect(block?.[1]).toBeDefined()
    return (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s/)[0] ?? '')
      .filter((c) => c !== '')
      .sort()
  }

  it('两份清单逐项一致', () => {
    const dispatched = dispatchedCommands()
    expect(dispatched.length).toBeGreaterThan(0) // 正则失配时不许静默通过
    expect(documentedCommands()).toEqual(dispatched)
  })

  it('本轮新增的两个 ingress 命令已接线', () => {
    expect(dispatchedCommands()).toContain('register-repo')
    expect(dispatchedCommands()).toContain('ingest-issue')
  })

  it('run-issue(Issue → 终态组合命令)已接线', () => {
    expect(dispatchedCommands()).toContain('run-issue')
  })
})

/**
 * `--ci` 的取值清单在三处出现:CI_MODES、run-task 帮助、HELP 行。
 * 漏改任一处就会出现「文档说支持 real、实现不认」这类假象。
 */
describe('--ci 取值清单不得漂移', () => {
  /**
   * 检查**每一处**清单式的 `--ci a|b|c`,而不是「文件里出现过完整清单就算过」——
   * 后者已被反例证伪:index.ts 里 run-task 那行漏掉 real 时,run-issue 那行
   * 仍带着完整清单,断言照样绿。
   */
  function ciFlagLists(src: string): string[] {
    return [...src.matchAll(/--ci ([a-z]+(?:\|[a-z]+)+)/g)].map((m) => m[1] as string)
  }

  it('每处帮助文本里的 --ci 清单都与 CI_MODES 一致', () => {
    const expected = CI_MODES.join('|')
    expect(CI_MODES.length).toBeGreaterThan(1)
    for (const file of ['./index.ts', './run-task.ts', './run-issue.ts']) {
      const lists = ciFlagLists(readFileSync(new URL(file, import.meta.url), 'utf8'))
      expect(lists.length, `${file} 未列出 --ci 取值`).toBeGreaterThan(0)
      for (const list of lists) {
        expect(list, `${file} 的 --ci 清单漂移`).toBe(expected)
      }
    }
  })

  it('拼错的取值不静默退化为模拟 CI', () => {
    const bad = parseCiMode('rael')
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(bad.error.retryable).toBe(false)
  })

  it('合法取值原样返回', () => {
    for (const mode of CI_MODES) {
      const r = parseCiMode(mode)
      expect(r.ok && r.value).toBe(mode)
    }
  })
})
