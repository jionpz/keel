/**
 * keel CLI 单测 —— argv 解析与命令分发(issue #27)。
 *
 * 只测纯函数层(parseArgs / parseCiMode)+ 帮助输出;不 spawn 进程、不连 DB。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseArgs } from './argv.js'
import {
  CI_MODES,
  createHarnessAdapter,
  DEFAULT_OMP_MODEL,
  HARNESS_IDS,
  parseCiMode,
  resolveHarness,
  resolveModel,
  resolveModelForHarness,
  resolveOptionalModel,
} from './run-task.js'

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

describe('run-issue 把同一 model / harness 传进 runTask', () => {
  it('组合调用含 model: model.value(不丢字段)', () => {
    const source = readFileSync(new URL('./run-issue.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/runTask\([\s\S]*model: model\.value/)
  })

  it('组合调用含 harness: harness.value(不丢字段)', () => {
    const source = readFileSync(new URL('./run-issue.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/runTask\([\s\S]*harness: harness\.value/)
  })
})

describe('--harness 取值清单不得漂移', () => {
  function harnessFlagLists(src: string): string[] {
    return [...src.matchAll(/--harness ([a-z]+(?:\|[a-z]+)+)/g)].map((m) => m[1] as string)
  }

  it('每处帮助文本里的 --harness 清单都与 HARNESS_IDS 一致', () => {
    const expected = HARNESS_IDS.join('|')
    expect(HARNESS_IDS.length).toBeGreaterThan(1)
    for (const file of ['./index.ts', './run-task.ts', './run-issue.ts']) {
      const lists = harnessFlagLists(readFileSync(new URL(file, import.meta.url), 'utf8'))
      expect(lists.length, `${file} 未列出 --harness 取值`).toBeGreaterThan(0)
      for (const list of lists) {
        expect(list, `${file} 的 --harness 清单漂移`).toBe(expected)
      }
    }
  })
})

describe('resolveHarness · CLI > env > 缺省 omp，非法拒绝', () => {
  it('都不给 → 缺省 omp', () => {
    const r = resolveHarness(undefined, undefined)
    expect(r.ok && r.value).toBe('omp')
  })

  it('--harness 取值原样(trim)', () => {
    const r = resolveHarness('  claude  ', 'omp')
    expect(r.ok && r.value).toBe('claude')
  })

  it('KEEL_HARNESS 在无 CLI 时生效', () => {
    const r = resolveHarness(undefined, '  claude  ')
    expect(r.ok && r.value).toBe('claude')
  })

  it('CLI 覆盖 env', () => {
    const r = resolveHarness('claude', 'omp')
    expect(r.ok && r.value).toBe('claude')
  })

  it('空白 CLI 拒绝，不回退 omp', () => {
    for (const cli of ['', '   ', true] as const) {
      const r = resolveHarness(cli, 'omp')
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
    }
  })

  it('空白 KEEL_HARNESS 拒绝，不回退 omp', () => {
    const r = resolveHarness(undefined, '   ')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/KEEL_HARNESS/)
  })

  it('非法 id 拒绝，不回退 omp', () => {
    const r = resolveHarness('codex', undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/codex/)
  })

  it('parseArgs 的 --harness 无值(布尔 true)拒绝', () => {
    const p = parseArgs(['task-1', '--harness'])
    expect(p.flags.harness).toBe(true)
    const r = resolveHarness(p.flags.harness, undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
  })
})

describe('resolveModel · CLI > env > 缺省，空白拒绝', () => {
  it('都不给 → 缺省 deepseek-v4-flash', () => {
    const r = resolveModel(undefined, undefined)
    expect(r.ok && r.value).toBe(DEFAULT_OMP_MODEL)
    expect(r.ok && r.value).toBe('deepseek-v4-flash')
  })

  it('--model 取值原样(trim)', () => {
    const r = resolveModel('  gpt-5.2  ', 'ignored')
    expect(r.ok && r.value).toBe('gpt-5.2')
  })

  it('KEEL_MODEL 在无 CLI 时生效', () => {
    const r = resolveModel(undefined, '  claude-opus  ')
    expect(r.ok && r.value).toBe('claude-opus')
  })

  it('CLI 覆盖 env', () => {
    const r = resolveModel('gpt-5.2', DEFAULT_OMP_MODEL)
    expect(r.ok && r.value).toBe('gpt-5.2')
  })

  it('空白 CLI 拒绝，不回退缺省', () => {
    for (const cli of ['', '   ', true] as const) {
      const r = resolveModel(cli, DEFAULT_OMP_MODEL)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
      expect(r.error.detail).toMatch(/空白/)
    }
  })

  it('空白 KEEL_MODEL 拒绝，不回退缺省', () => {
    const r = resolveModel(undefined, '   ')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/KEEL_MODEL/)
  })

  it('parseArgs 的 --model 无值(布尔 true)拒绝', () => {
    const p = parseArgs(['task-1', '--model'])
    expect(p.flags.model).toBe(true)
    const r = resolveModel(p.flags.model, undefined)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
  })
})

describe('resolveOptionalModel · 都不给是 undefined，不套 omp 缺省', () => {
  it('都不给 → undefined（claude 用这条，避免 deepseek 进 --model）', () => {
    const r = resolveOptionalModel(undefined, undefined)
    expect(r.ok && r.value).toBeUndefined()
  })

  it('有 CLI 时原样 trim，不套缺省', () => {
    const r = resolveOptionalModel('  opus  ', undefined)
    expect(r.ok && r.value).toBe('opus')
  })
})

describe('resolveModelForHarness · omp 套缺省，claude 不套', () => {
  it('omp 都不给 → DEFAULT_OMP_MODEL', () => {
    const r = resolveModelForHarness('omp', undefined, undefined)
    expect(r.ok && r.value).toBe(DEFAULT_OMP_MODEL)
  })

  it('claude 都不给 → undefined，不是 deepseek', () => {
    const r = resolveModelForHarness('claude', undefined, undefined)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBeUndefined()
    expect(r.value).not.toBe(DEFAULT_OMP_MODEL)
  })

  it('claude 显式 model 原样，仍不是缺省 deepseek', () => {
    const r = resolveModelForHarness('claude', '  claude-opus-4-6  ', DEFAULT_OMP_MODEL)
    expect(r.ok && r.value).toBe('claude-opus-4-6')
  })
})

describe('createHarnessAdapter', () => {
  it('缺省 omp；claude 的 harness_id 是 claude', () => {
    expect(createHarnessAdapter('omp', undefined).describe().harness_id).toBe('omp')
    expect(createHarnessAdapter('claude', undefined).describe().harness_id).toBe('claude')
    expect(createHarnessAdapter('claude', undefined).describe().cost_basis).toBe('estimated')
  })
})

describe('claude 副作用前预检不得漂移', () => {
  it('run-task / run-issue 都调用 requireClaudeReady', () => {
    for (const file of ['./run-task.ts', './run-issue.ts']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src, `${file} 未调用 requireClaudeReady`).toMatch(/requireClaudeReady/)
    }
  })
})
