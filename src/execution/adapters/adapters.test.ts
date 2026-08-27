/**
 * Harness Adapter 测试。
 *
 * 分三层，各测各的：
 *   1. 纯函数（解析、tier、argv）—— 用真实抓到的样本，不起进程
 *   2. 契约拒绝 —— 不起进程
 *   3. 真实集成 —— 真调 omp + deepseek-v4-flash
 *
 * 第 3 层慢且花钱，但**不做 mock**：
 * mock 一个 harness 等于验证「我以为它会怎样」，而不是「它实际怎样」。
 * 本项目此前已经因为「未经反例验证的检查」吃过亏。
 *
 * 第 3 层的运行条件（2026-08-23 分层门控）：
 * 需要 `KEEL_REQUIRE_OMP=1` 显式开启。它同时要求 omp 二进制与推理网关可达，
 * 因此只在本机与验收环境跑；GitHub Actions runner 没有 omp，
 * 不门控则 CI 永远红。这不是「不可用就跳过」——
 * 未开启时该层整体不注册，`pnpm run test:acceptance` 是它的显式入口
 * （vitest.acceptance.config.ts 已含 `*.test.ts` 之外的真实集成）。
 */

import { execFileSync, type spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '../../contracts/harness-adapter.js'
import { TIER_REQUIREMENTS } from '../../shared/ids.js'
import { HUMAN_CAPABILITIES, HumanAdapter, type HumanInbox } from './human.js'
import { buildArgv, OMP_CAPABILITIES, OmpAdapter } from './omp.js'
import { parseOmpStream } from './omp-parse.js'
import { tierOf } from './tier.js'

const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/omp-resume-with-thinking.jsonl', import.meta.url),
)

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    run: { run_id: 'r1', task_id: 't1', stage: 'pm', role: 'PM', attempt: 1 },
    idempotency_key: 't1/pm/1',
    workspace: { path: '/tmp', repo_id: 'repo1', branch: 'main', untrusted: true },
    context: {
      context_id: 'c1',
      recipe_id: 'pm',
      recipe_version: '1',
      sections: [
        {
          id: 's1',
          source_ref: 'fixed:test',
          source_kind: 'fixed',
          priority: 'required',
          content: '回复 ok',
          tokens: 3,
        },
      ],
      total_tokens: 3,
      dropped: [],
    },
    output_contract: { schema_ref: 'stage_outcome', mode: 'post_validate' },
    permissions: { allowed_tools: [], mode: 'manual' },
    limits: { wall_clock_s: 120, budget_usd: null, max_turns: 4 },
    ...over,
  }
}

// ───────────────────────── 1. 纯函数 ─────────────────────────

describe('parseOmpStream —— 用真实抓到的事件流', () => {
  it('从首个 session 事件取出 resume 句柄', async () => {
    const parsed = parseOmpStream(await readFile(FIXTURE, 'utf8'))
    expect(parsed.sessionRef).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('正确处理 thinking block —— 不假设 content[0] 是 text', async () => {
    const parsed = parseOmpStream(await readFile(FIXTURE, 'utf8'))
    // 这条样本是 deepseek 返回的 [{type:'thinking'}, {type:'text'}]
    expect(parsed.nonTextBlocks).toBeGreaterThan(0)
    expect(parsed.text).toBe('4271')
  })

  it('抽出 usage 与成本，口径报 estimated', async () => {
    const parsed = parseOmpStream(await readFile(FIXTURE, 'utf8'))
    expect(parsed.usage.tokens_in).toBeGreaterThan(0)
    expect(parsed.usage.cost_usd).toBeGreaterThan(0)
    // 文档未说明 OMP 的 cost 是 billed 还是 estimated —— 保守起见按 estimated
    expect(parsed.usage.cost_basis).toBe('estimated')
  })

  it('非 JSON 行被收集而非丢弃（omp 的错误信息走这里）', () => {
    const parsed = parseOmpStream('Error: Session "x" not found.\n')
    expect(parsed.nonJsonLines).toHaveLength(1)
    expect(parsed.sawAgentEnd).toBe(false)
  })

  it('无 cost 时报 unavailable，不用 0 冒充', () => {
    const parsed = parseOmpStream('{"type":"agent_end","messages":[]}\n')
    expect(parsed.usage.cost_usd).toBeNull()
    expect(parsed.usage.cost_basis).toBe('unavailable')
  })
})

describe('tier 由 capability 推导，不硬编码', () => {
  it('OMP 是 L2', () => {
    expect(tierOf(OMP_CAPABILITIES)).toBe('L2')
  })

  it('Human 是 L0', () => {
    expect(tierOf(HUMAN_CAPABILITIES)).toBe('L0')
  })

  it('去掉 CAP-COST 就降到 L1 —— tier 随能力集合变', () => {
    const without = OMP_CAPABILITIES.filter((c) => c !== 'CAP-COST')
    expect(tierOf(without)).toBe('L1')
  })

  it('缺 CAP-STRUCTURED_OUTPUT 不影响档次（ADR-0005 修订后能力正交）', () => {
    expect(OMP_CAPABILITIES).not.toContain('CAP-STRUCTURED_OUTPUT')
    expect(tierOf(OMP_CAPABILITIES)).toBe('L2')
  })

  it('缺 CAP-HEADLESS 直接拒绝', () => {
    expect(() => tierOf(['CAP-RESUME'])).toThrow()
  })

  it('TIER_REQUIREMENTS 与 tierOf 互证 —— 各级别要求恰好推出该级别(#1-07)', () => {
    for (const tier of ['L0', 'L1', 'L2'] as const) {
      expect(tierOf(TIER_REQUIREMENTS[tier]), `${tier} 的要求应推出 ${tier}`).toBe(tier)
      // 级别是嵌套的：L2 ⊇ L1 ⊇ L0
      const lower = TIER_REQUIREMENTS.L0.every((c) => TIER_REQUIREMENTS[tier].includes(c))
      expect(lower, `${tier} 应含 L0 的全部能力`).toBe(true)
    }
  })

  it('STRUCTURED_OUTPUT 不在阶梯内(ADR-0005)—— L1 不含它', () => {
    expect(TIER_REQUIREMENTS.L1).not.toContain('CAP-STRUCTURED_OUTPUT')
    expect(TIER_REQUIREMENTS.L2).not.toContain('CAP-STRUCTURED_OUTPUT')
  })

  it('L1 要求去掉 CAP-RESUME → 降 L0(表与推导互证反方向,R10)', () => {
    const l1WithoutResume = TIER_REQUIREMENTS.L1.filter((c) => c !== 'CAP-RESUME')
    expect(tierOf(l1WithoutResume)).toBe('L0')
  })
})

describe('buildArgv', () => {
  it('untrusted 时带上三个隔离开关', () => {
    const argv = buildArgv(spec(), 'deepseek-v4-flash')
    expect(argv).toContain('--no-extensions')
    expect(argv).toContain('--no-skills')
    expect(argv).toContain('--no-rules')
  })

  it('非 untrusted 时不带隔离开关', () => {
    const argv = buildArgv(
      spec({ workspace: { path: '/tmp', repo_id: 'r', branch: 'main', untrusted: false } }),
      'm',
    )
    expect(argv).not.toContain('--no-extensions')
  })

  it('空工具列表 → --no-tools；非空 → 白名单', () => {
    expect(buildArgv(spec(), 'm')).toContain('--no-tools')
    const withTools = buildArgv(
      spec({ permissions: { allowed_tools: ['read', 'grep'], mode: 'manual' } }),
      'm',
    )
    expect(withTools).toContain('--tools=read,grep')
  })

  it('权限模式映射到 omp 的 approval-mode', () => {
    expect(buildArgv(spec({ permissions: { allowed_tools: [], mode: 'auto' } }), 'm')).toContain(
      '--approval-mode=yolo',
    )
    expect(
      buildArgv(spec({ permissions: { allowed_tools: [], mode: 'accept_edits' } }), 'm'),
    ).toContain('--approval-mode=write')
  })

  it('固定使用 -p --mode=json', () => {
    const argv = buildArgv(spec(), 'm')
    expect(argv.slice(0, 2)).toEqual(['-p', '--mode=json'])
  })
})

/**
 * 提示词渲染 —— **模型实际收到的字节**，不是我们以为它收到的。
 *
 * 这一层此前是空的，于是 Session Manager 把 ContextBuilder 造好的
 * role / feedback / rfc 全部丢掉、只留阶段指令这件事，
 * 一路穿过所有确定性测试，直到真实运行里 PM 回答
 * 「本次对话中不存在任何用户反馈原文」才暴露。
 *
 * 用注入的 spawnFn 抓 argv 末位（真实的提示词），不起进程、不花钱。
 */
describe('renderPrompt —— context 的每个 section 都要真的进提示词', () => {
  /** 最小可解析的 omp 输出：一条 agent_end 即可让 exec 走成功路径 */
  const OK_STREAM = `{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"ok"}]}]}\n`

  function recordingSpawn(): { spawnFn: typeof spawn; calls: string[][] } {
    const calls: string[][] = []
    const spawnFn = ((_bin: string, args: readonly string[]) => {
      calls.push([...args])
      const p = new EventEmitter() as EventEmitter & {
        stdout: Readable
        stderr: Readable
      }
      p.stdout = Readable.from([OK_STREAM])
      p.stderr = Readable.from([])
      // 等 stdout 读完再报 close —— 否则会丢输出，正是真实实现刻意避开的坑
      p.stdout.on('end', () => p.emit('close', 0))
      return p
    }) as unknown as typeof spawn
    return { spawnFn, calls }
  }

  /** 多个 section 的 spec：模拟 ContextBuilder 的真实产出 */
  function multiSectionSpec(): RunSpec {
    return spec({
      context: {
        context_id: 'c1',
        recipe_id: 'PM',
        recipe_version: '1',
        sections: [
          {
            id: 'role',
            source_ref: 'fixed:role/PM',
            source_kind: 'fixed',
            priority: 'required',
            content: '你是 PM。',
            tokens: 3,
          },
          {
            id: 'feedback',
            source_ref: 'artifact:feedback/t1',
            source_kind: 'artifact',
            priority: 'required',
            content: '## 用户反馈\n\nKEEL_MARKER_FEEDBACK',
            tokens: 8,
          },
          {
            id: 'prompt',
            source_ref: 'derived:session-manager',
            source_kind: 'derived',
            priority: 'required',
            content: '判断上面的用户反馈是否值得做。',
            tokens: 6,
          },
        ],
        total_tokens: 17,
        dropped: [],
      },
    })
  }

  it('全部 section 按顺序进入提示词，且阶段指令在最后', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new OmpAdapter({ spawnFn })

    const started = await a.startRun(multiSectionSpec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((await a.awaitResult(started.value)).ok).toBe(true)

    const prompt = calls[0]?.at(-1) ?? ''
    // 只断言「含阶段指令」是不够的 —— 那正是缺陷发生时仍然成立的部分
    expect(prompt).toContain('你是 PM。')
    expect(prompt).toContain('KEEL_MARKER_FEEDBACK')
    // 「上面的」是语义的一部分：指令必须在被引用的内容之后
    expect(prompt.indexOf('KEEL_MARKER_FEEDBACK')).toBeLessThan(prompt.indexOf('判断上面的'))
  })

  it('反例：只渲染首个 section 时，反馈就消失了', async () => {
    const s = multiSectionSpec()
    const onlyFirst = s.context.sections
      .slice(0, 1)
      .map((x) => x.content)
      .join('\n\n')
    // 这就是缺陷当时的形态 —— 它「看起来在工作」，因为指令还在
    expect(onlyFirst).not.toContain('KEEL_MARKER_FEEDBACK')
  })
})

// ───────────────────────── 2. 契约拒绝 ─────────────────────────

describe('契约拒绝 —— 不得降级执行', () => {
  it('native 输出模式被拒绝（OMP 无 CAP-STRUCTURED_OUTPUT）', async () => {
    const a = new OmpAdapter()
    const r = await a.startRun(spec({ output_contract: { schema_ref: 'x', mode: 'native' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    // 编程错误而非运行时故障，重试无意义
    expect(r.error.retryable).toBe(false)
  })

  it('人工同样拒绝 native 模式', async () => {
    const inbox: HumanInbox = {
      notify: async () => undefined,
      await: async () => ({ text: 'x' }),
      withdraw: async () => undefined,
    }
    const r = await new HumanAdapter(inbox).startRun(
      spec({ output_contract: { schema_ref: 'x', mode: 'native' } }),
    )
    expect(r.ok && false).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
  })
})

describe('HumanAdapter —— 人工作为一种 Harness', () => {
  it('成本报 unavailable，不用 0 冒充', async () => {
    const inbox: HumanInbox = {
      notify: async () => undefined,
      await: async () => ({ text: '做完了' }),
      withdraw: async () => undefined,
    }
    const a = new HumanAdapter(inbox)
    expect(a.describe().cost_basis).toBe('unavailable')

    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok && res.value.status).toBe('SUCCEEDED')
    // 无 CAP-RESUME：人工没有可恢复的会话句柄
    expect(res.ok && res.value.session_ref).toBeNull()
  })

  it('撤回则该次 Run 作废', async () => {
    const inbox: HumanInbox = {
      notify: async () => undefined,
      await: async () => null,
      withdraw: async () => undefined,
    }
    const a = new HumanAdapter(inbox)
    const started = await a.startRun(spec())
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok && res.value.status).toBe('CANCELLED')
  })

  it('collectChanges 读真实 git 脏树(#1-06)—— 人工改的文件必须可见', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'keel-human-dirty-'))
    execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'h@test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'h'], { cwd: repo })
    writeFileSync(join(repo, 'f.txt'), 'v1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    try {
      const inbox: HumanInbox = {
        notify: async () => undefined,
        await: async () => ({ text: '做完了' }),
        withdraw: async () => undefined,
      }
      const a = new HumanAdapter(inbox)
      const started = await a.startRun(
        spec({ workspace: { path: repo, repo_id: 'r', branch: 'main', untrusted: true } }),
      )
      expect(started.ok).toBe(true)
      if (!started.ok) return

      // 干净时
      const clean = await a.collectChanges(started.value)
      expect(clean.ok && clean.value.is_dirty).toBe(false)

      // 人工在 worktree 里改了文件
      writeFileSync(join(repo, 'f.txt'), 'v2\n')
      const dirty = await a.collectChanges(started.value)
      expect(dirty.ok, dirty.ok ? '' : dirty.error.detail).toBe(true)
      if (!dirty.ok) return
      expect(dirty.value.is_dirty).toBe(true)
      expect(dirty.value.files_changed.map((f) => f.path)).toContain('f.txt')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ───────────────────── 3. 真实集成（会花钱） ─────────────────────

function haveOmp(): boolean {
  try {
    execFileSync('omp', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const REQUIRE_OMP = process.env.KEEL_REQUIRE_OMP === '1'

describe.skipIf(!REQUIRE_OMP)('真实集成：omp + deepseek-v4-flash', () => {
  it('omp 可执行 —— 它是 v0.1 首批 harness，开启门控后缺失即失败而非跳过', () => {
    expect(
      haveOmp(),
      'omp 不在 PATH 中。它是 v0.1 首批 harness，KEEL_REQUIRE_OMP=1 下不可跳过',
    ).toBe(true)
  })

  it('startRun → awaitResult 跑通，带回 session_ref 与成本', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keel-omp-'))
    execFileSync('git', ['init', '-q', '.'], { cwd: ws })
    writeFileSync(join(ws, 'README.md'), 'hello\n')

    const a = new OmpAdapter()
    const s = spec({
      workspace: { path: ws, repo_id: 'r', branch: 'main', untrusted: true },
    })
    const started = await a.startRun(s)
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const res = await a.awaitResult(started.value)
    expect(res.ok, `omp 应成功：${res.ok ? '' : res.error.detail}`).toBe(true)
    if (!res.ok) return

    expect(res.value.status).toBe('SUCCEEDED')
    // resume 句柄 —— 实测确认 OMP 在首行 session 事件里给出
    expect(res.value.session_ref).toMatch(/^[0-9a-f-]{36}$/)
    // 成本上报，口径为估算
    expect(res.value.usage.cost_usd).not.toBeNull()
    expect(res.value.usage.cost_basis).toBe('estimated')

    rmSync(ws, { recursive: true, force: true })
  }, 180_000)

  it('相同 idempotency_key 的重复 startRun 不启动第二个进程', async () => {
    const a = new OmpAdapter({ bin: '/bin/echo' })
    const s = spec()
    const first = await a.startRun(s)
    const second = await a.startRun(s)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.run_id).toBe(first.value.run_id)
  })
})

// ────────────── CAP-UNTRUSTED_WORKSPACE 的反例验证 ──────────────

/**
 * 上一轮只确认了隔离开关**存在**，没验证它**有效**。
 * 按本项目纪律：未经反例验证的约束等同于没有约束。
 *
 * 做法：往仓库里放一个加载时留痕迹的 OMP 扩展，跑两次对比。
 * 若两次结果相同 —— 无论都有痕迹还是都没有 —— 都说明这个测试没有真正
 * 探到隔离机制，此时**不得假装通过**，应如实把该能力标为未验证。
 */
describe.skipIf(!REQUIRE_OMP)('CAP-UNTRUSTED_WORKSPACE 反例验证', () => {
  it('不加隔离开关时仓库内扩展会被加载；加上之后不会', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'keel-iso-'))
    mkdirSync(join(repo, '.omp/extensions/probe'), { recursive: true })
    execFileSync('git', ['init', '-q', '.'], { cwd: repo })

    const traceA = join(repo, 'trace-a.txt')
    const traceB = join(repo, 'trace-b.txt')

    writeFileSync(
      join(repo, '.omp/extensions/probe/index.ts'),
      [
        'import { appendFileSync } from "node:fs";',
        'appendFileSync(process.env.KEEL_PROBE_FILE!, "EXTENSION_LOADED\\n");',
        'export default {};',
      ].join('\n'),
    )

    const runOmp = (isolate: boolean, traceFile: string): void => {
      const args = ['-p', '--mode=json', '--model', 'deepseek-v4-flash', '--no-tools']
      if (isolate) args.push('--no-extensions', '--no-skills', '--no-rules')
      args.push('回复 ok')
      try {
        execFileSync('omp', args, {
          cwd: repo,
          stdio: 'pipe',
          env: { ...process.env, KEEL_PROBE_FILE: traceFile },
        })
      } catch {
        // 退出码非 0 不影响本测试关心的东西：扩展有没有被加载
      }
    }

    runOmp(false, traceA)
    runOmp(true, traceB)

    const loadedWithout = existsSync(traceA) && readFileSync(traceA, 'utf8').includes('LOADED')
    const loadedWith = existsSync(traceB) && readFileSync(traceB, 'utf8').includes('LOADED')

    // 威胁是真的：在含 .omp/extensions/ 的仓库里跑一次 omp，
    // 就等于执行了该仓库作者写的代码。与 Claude Code 的 --bare 同类。
    expect(loadedWithout, '不加隔离开关时扩展应被加载 —— 若否，说明本测试没探到隔离机制').toBe(true)
    // 开关有效
    expect(loadedWith, '加了 --no-extensions 后扩展不应被加载').toBe(false)

    rmSync(repo, { recursive: true, force: true })
  }, 240_000)
})

// ────────────── #1-05 · interrupt 持有并杀子进程 ──────────────

/**
 * 旧实现只置 state.aborted,已 spawn 的 omp 继续跑完 —— 白耗 token 与时间。
 * 现在 interrupt 必须 kill 子进程。
 *
 * 注入 fake spawnFn:记录的 kill 调用即证据,不需要真起 omp。
 */
describe('interrupt 杀子进程(注入 spawn fixture)', () => {
  interface FakeProc {
    pid: number
    killed: Array<string | number>
    stdout: { on: () => void }
    stderr: { on: () => void }
    on: (ev: 'error' | 'close', cb: (code?: number | null) => void) => void
    kill: (signal: string | number) => boolean
    emitClose: (code: number) => void
  }

  function hangingSpawn(): { spawnFn: typeof spawn; procs: FakeProc[] } {
    const procs: FakeProc[] = []
    const spawnFn = ((_cmd: string, _args: readonly string[]): unknown => {
      const closeHandlers: Array<(code?: number | null) => void> = []
      const pid = 40000 + procs.length
      const proc: FakeProc = {
        pid,
        killed: [],
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') closeHandlers.push(cb)
          else if (ev === 'error') {
            /* 测试里不触发 error */
          }
        },
        kill: (signal) => {
          proc.killed.push(signal)
          return true
        },
        emitClose: (code) => {
          for (const cb of closeHandlers) cb(code)
        },
      }
      procs.push(proc)
      return proc
    }) as typeof spawn
    return { spawnFn, procs }
  }

  it('interrupt 对进程组发 SIGTERM,awaitResult 收敛为 CANCELLED', async () => {
    const { spawnFn, procs } = hangingSpawn()
    // 捕获 process.kill(-pid, signal) —— R7 用组终止
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new OmpAdapter({ spawnFn, interruptKillTimeoutMs: 5 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return

      expect(procs.length, '应 spawn 了子进程').toBe(1)
      const pid = procs[0]?.pid

      const intr = await adapter.interrupt(started.value, 'cancelled')
      expect(intr.ok).toBe(true)
      expect(killSpy).toHaveBeenCalledWith(-(pid as number), 'SIGTERM')

      // 被杀的进程退出 → 挂起的 awaitResult 返回 CANCELLED
      procs[0]?.emitClose(143)
      const res = await adapter.awaitResult(started.value)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value.status).toBe('CANCELLED')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('SIGTERM 后进程不退 → 兜底 SIGKILL(R7)', async () => {
    const { spawnFn, procs } = hangingSpawn()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.useFakeTimers()
    try {
      const adapter = new OmpAdapter({ spawnFn, interruptKillTimeoutMs: 1000 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const pid = procs[0]?.pid

      await adapter.interrupt(started.value, 'cancelled')
      expect(killSpy).toHaveBeenCalledWith(-(pid as number), 'SIGTERM')
      // 未到兜底:不应有 SIGKILL
      expect(killSpy).not.toHaveBeenCalledWith(-(pid as number), 'SIGKILL')
      // 推进 1s+ → 兜底 SIGKILL 触发
      vi.advanceTimersByTime(1001)
      expect(killSpy).toHaveBeenCalledWith(-(pid as number), 'SIGKILL')
    } finally {
      vi.useRealTimers()
      killSpy.mockRestore()
    }
  })

  it('中断发生在子进程已结束时不再 kill(引用已清空)', async () => {
    const { spawnFn, procs } = hangingSpawn()
    const adapter = new OmpAdapter({ spawnFn })
    const started = await adapter.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return

    // 进程先自行结束
    procs[0]?.emitClose(0)
    await adapter.awaitResult(started.value)

    const intr = await adapter.interrupt(started.value, 'cancelled')
    expect(intr.ok).toBe(true)
    expect(procs[0]?.killed).toEqual([])
  })

  it('interrupt reason=timeout → awaitResult 返 TIMEOUT(B1,方案 B);cancelled → CANCELLED', async () => {
    async function runWith(reason: 'cancelled' | 'timeout') {
      const { spawnFn, procs } = hangingSpawn()
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const adapter = new OmpAdapter({ spawnFn, interruptKillTimeoutMs: 1 })
        const started = await adapter.startRun(spec())
        expect(started.ok).toBe(true)
        if (!started.ok) return null
        const intr = await adapter.interrupt(started.value, reason)
        expect(intr.ok).toBe(true)
        procs[0]?.emitClose(143)
        const res = await adapter.awaitResult(started.value)
        return res.ok ? res.value.status : null
      } finally {
        killSpy.mockRestore()
      }
    }

    expect(await runWith('timeout')).toBe('TIMEOUT')
    expect(await runWith('cancelled')).toBe('CANCELLED')
  })
})
