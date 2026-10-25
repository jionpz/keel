/**
 * Claude Code Adapter 测试。
 *
 * 分层与 adapters.test.ts 相同：纯函数 / 契约拒绝 / spawn 注入。
 * 真调 claude 二进制只在 `KEEL_REQUIRE_CLAUDE=1` 下注册，不进默认 check。
 *
 * fixture `claude-stream-json-result.docs.jsonl` 是**文档形状**的最小合法样本，
 * 不是本机 live capture（research 标明 stream 样本本会话未抓）。
 */

import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '../../contracts/harness-adapter.js'
import {
  buildClaudeArgv,
  CLAUDE_CAPABILITIES,
  ClaudeCodeAdapter,
  claudeAuthMissingDetail,
  envCredentialName,
  requireClaudeAuth,
  requireClaudeBinary,
  sanitizeClaudeEnv,
} from './claude-code.js'
import { parseClaudeStream } from './claude-code-parse.js'
import { DEFAULT_OMP_MODEL } from './omp.js'
import { tierOf } from './tier.js'

const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/claude-stream-json-result.docs.jsonl', import.meta.url),
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

const OK_STREAM =
  '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","total_cost_usd":0.01}\n'

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
    p.stdout.on('end', () => p.emit('close', 0))
    return p
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}

// ───────────────────────── 1. 纯函数 ─────────────────────────

describe('parseClaudeStream —— 文档形状 fixture（非 live capture）', () => {
  it('从 type=result 取出 session_id、文本、estimated 成本', async () => {
    const parsed = parseClaudeStream(await readFile(FIXTURE, 'utf8'))
    expect(parsed.sawResult).toBe(true)
    expect(parsed.isError).toBe(false)
    expect(parsed.sessionRef).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(parsed.text).toBe('hello from docs fixture')
    expect(parsed.usage.cost_usd).toBe(0.0123)
    expect(parsed.usage.cost_basis).toBe('estimated')
    expect(parsed.usage.tokens_in).toBe(100)
    expect(parsed.usage.tokens_out).toBe(20)
  })

  it('终态文本来自 result，不把中间 assistant partial 当终态', async () => {
    const parsed = parseClaudeStream(await readFile(FIXTURE, 'utf8'))
    expect(parsed.text).not.toContain('partial-should-not-win')
  })

  it('无 type=result 时 sawResult=false，文本 null，不用空串冒充成功', () => {
    const parsed = parseClaudeStream('{"type":"system","subtype":"init"}\n')
    expect(parsed.sawResult).toBe(false)
    expect(parsed.text).toBeNull()
    expect(parsed.sessionRef).toBeNull()
  })

  it('无 total_cost_usd 时报 unavailable，不用 0 冒充', () => {
    const parsed = parseClaudeStream('{"type":"result","result":"hi","session_id":"s1"}\n')
    expect(parsed.usage.cost_usd).toBeNull()
    expect(parsed.usage.cost_basis).toBe('unavailable')
    expect(parsed.usage.tokens_in).toBeNull()
  })

  it('非 JSON 行被收集而非丢弃', () => {
    const parsed = parseClaudeStream('Error: not logged in\n')
    expect(parsed.nonJsonLines).toHaveLength(1)
    expect(parsed.sawResult).toBe(false)
  })

  it('result 文本为空 → text null（Adapter 应 PROTOCOL_ERROR）', () => {
    const parsed = parseClaudeStream('{"type":"result","result":"   "}\n')
    expect(parsed.sawResult).toBe(true)
    expect(parsed.text).toBeNull()
  })

  it('is_error true → isError，失败不得当成功', () => {
    const parsed = parseClaudeStream('{"type":"result","is_error":true,"result":"nope"}\n')
    expect(parsed.sawResult).toBe(true)
    expect(parsed.isError).toBe(true)
    expect(parsed.text).toBe('nope')
  })
})

describe('Claude capability / tier', () => {
  it('声明 L2 所需能力，不声明 STRUCTURED_OUTPUT', () => {
    expect(CLAUDE_CAPABILITIES).toContain('CAP-HEADLESS')
    expect(CLAUDE_CAPABILITIES).toContain('CAP-RESUME')
    expect(CLAUDE_CAPABILITIES).toContain('CAP-STREAM')
    expect(CLAUDE_CAPABILITIES).toContain('CAP-COST')
    expect(CLAUDE_CAPABILITIES).toContain('CAP-UNTRUSTED_WORKSPACE')
    expect(CLAUDE_CAPABILITIES).toContain('CAP-PERMISSION')
    expect(CLAUDE_CAPABILITIES).not.toContain('CAP-STRUCTURED_OUTPUT')
    expect(CLAUDE_CAPABILITIES).not.toContain('CAP-INTERRUPT')
    expect(CLAUDE_CAPABILITIES).not.toContain('CAP-PROBE')
    expect(tierOf(CLAUDE_CAPABILITIES)).toBe('L2')
  })

  it('describe().harness_id 是 claude，cost_basis 是 estimated', () => {
    const d = new ClaudeCodeAdapter().describe()
    expect(d.harness_id).toBe('claude')
    expect(d.tier).toBe('L2')
    expect(d.cost_basis).toBe('estimated')
  })
})

describe('buildClaudeArgv', () => {
  it('untrusted 必须带 --bare', () => {
    const argv = buildClaudeArgv(spec())
    expect(argv).toContain('--bare')
  })

  it('trusted 不带 --bare（与 untrusted 可区分）', () => {
    const argv = buildClaudeArgv(
      spec({ workspace: { path: '/tmp', repo_id: 'r', branch: 'main', untrusted: false } }),
    )
    expect(argv).not.toContain('--bare')
  })

  it('固定 -p <prompt> --output-format stream-json --verbose', () => {
    const argv = buildClaudeArgv(spec(), { prompt: '做点什么' })
    expect(argv[0]).toBe('-p')
    expect(argv[1]).toBe('做点什么')
    const i = argv.indexOf('--output-format')
    expect(argv[i + 1]).toBe('stream-json')
    // 2.1.300：print + stream-json 缺 --verbose 直接报错
    expect(argv).toContain('--verbose')
  })

  it('Keel 工具名映射到 claude 真实名（write→Edit，Write 已不存在）', () => {
    const argv = buildClaudeArgv(
      spec({ permissions: { allowed_tools: ['read', 'write'], mode: 'auto' } }),
    )
    const i = argv.indexOf('--tools')
    expect(argv[i + 1]).toBe('Read,Edit')
    expect(argv[i + 1]).not.toContain('Write')
  })

  it('缺省不传 --model，也不出现 omp 缺省 deepseek', () => {
    const argv = buildClaudeArgv(spec())
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain(DEFAULT_OMP_MODEL)
  })

  it('显式 model 才进 argv', () => {
    const argv = buildClaudeArgv(spec(), { model: 'claude-opus-4-6' })
    const i = argv.indexOf('--model')
    expect(argv[i + 1]).toBe('claude-opus-4-6')
    expect(argv).not.toContain(DEFAULT_OMP_MODEL)
  })

  it('空工具列表 → --tools 空串', () => {
    const argv = buildClaudeArgv(spec())
    const i = argv.indexOf('--tools')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(argv[i + 1]).toBe('')
  })

  it('非空工具 → --tools 白名单', () => {
    const argv = buildClaudeArgv(
      spec({ permissions: { allowed_tools: ['Read', 'Edit'], mode: 'manual' } }),
    )
    const i = argv.indexOf('--tools')
    expect(argv[i + 1]).toBe('Read,Edit')
  })

  it('权限模式映射：manual → manual，accept_edits / auto → acceptEdits', () => {
    const mode = (m: 'manual' | 'accept_edits' | 'auto'): string => {
      const argv = buildClaudeArgv(spec({ permissions: { allowed_tools: [], mode: m } }))
      const i = argv.indexOf('--permission-mode')
      return argv[i + 1] ?? ''
    }
    expect(mode('manual')).toBe('manual')
    expect(mode('accept_edits')).toBe('acceptEdits')
    // dontAsk 在 2.1.300 下拒绝 Edit（headless 无人可问），不能映射过去
    expect(mode('auto')).toBe('acceptEdits')
    expect(mode('auto')).not.toBe('dontAsk')
  })

  it('deny_unlisted + 白名单 → permission-mode manual + --allowedTools', () => {
    const argv = buildClaudeArgv(
      spec({ permissions: { allowed_tools: ['Read'], mode: 'deny_unlisted' } }),
    )
    const i = argv.indexOf('--permission-mode')
    expect(argv[i + 1]).toBe('manual')
    const j = argv.indexOf('--allowedTools')
    expect(argv[j + 1]).toBe('Read')
  })

  it('有 sessionRef 才加 --resume；没有则不加（不编造）', () => {
    expect(buildClaudeArgv(spec())).not.toContain('--resume')
    const argv = buildClaudeArgv(spec(), { sessionRef: 'sess-1' })
    const i = argv.indexOf('--resume')
    expect(argv[i + 1]).toBe('sess-1')
  })

  it('budget_usd 有值才加 --max-budget-usd', () => {
    expect(buildClaudeArgv(spec())).not.toContain('--max-budget-usd')
    const argv = buildClaudeArgv(
      spec({ limits: { wall_clock_s: 120, budget_usd: 1.5, max_turns: 4 } }),
    )
    const i = argv.indexOf('--max-budget-usd')
    expect(argv[i + 1]).toBe('1.5')
  })

  it('argv 不含 --json-schema / --no-session-persistence / --dangerously-skip-permissions', () => {
    const argv = buildClaudeArgv(spec())
    expect(argv).not.toContain('--json-schema')
    expect(argv).not.toContain('--no-session-persistence')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('argv 不含 --cwd（工作目录靠 spawn cwd）', () => {
    expect(buildClaudeArgv(spec())).not.toContain('--cwd')
  })
})

describe('renderPrompt —— context 的每个 section 都要真的进提示词', () => {
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
    const a = new ClaudeCodeAdapter({ spawnFn })

    const started = await a.startRun(multiSectionSpec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((await a.awaitResult(started.value)).ok).toBe(true)

    // prompt 必须紧跟 -p（2.1.300：放末位会被当成没有输入）
    const prompt = calls[0]?.[1] ?? ''
    expect(prompt).toContain('你是 PM。')
    expect(prompt).toContain('KEEL_MARKER_FEEDBACK')
    expect(prompt.indexOf('KEEL_MARKER_FEEDBACK')).toBeLessThan(prompt.indexOf('判断上面的'))
  })

  it('spawn cwd 是 workspace.path，prompt 紧跟 -p，env 已剔除宿主运行时变量', async () => {
    const calls: { cwd: string | undefined; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const spawnFn = ((
      _bin: string,
      args: readonly string[],
      opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ cwd: opts?.cwd, args: [...args], env: opts?.env ?? {} })
      const p = new EventEmitter() as EventEmitter & {
        stdout: Readable
        stderr: Readable
      }
      p.stdout = Readable.from([OK_STREAM])
      p.stderr = Readable.from([])
      p.stdout.on('end', () => p.emit('close', 0))
      return p
    }) as unknown as typeof spawn

    // 模拟「Keel 跑在 Claude Code 会话里」：宿主变量必须被剔除，
    // 否则子 claude 会误判 provider 由宿主托管并拒绝 settings 里的模型。
    const injected: Record<string, string> = {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/x.sock',
      KEEL_MARKER_KEEP: 'kept',
    }
    const saved = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(injected)) {
      saved.set(k, process.env[k])
      process.env[k] = v
    }
    try {
      const a = new ClaudeCodeAdapter({ spawnFn })
      const started = await a.startRun(
        spec({ workspace: { path: '/ws/task-1', repo_id: 'r', branch: 'ai/x', untrusted: true } }),
      )
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await a.awaitResult(started.value)
      expect(calls[0]?.cwd).toBe('/ws/task-1')
      expect(calls[0]?.args).toContain('--bare')
      expect(calls[0]?.args[0]).toBe('-p')
      expect(calls[0]?.args[1]).toBe('回复 ok')
      expect(calls[0]?.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
      expect(calls[0]?.env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
      // 其余环境原样保留（凭据、PATH、用户配置都不能被顺手删掉）
      expect(calls[0]?.env.KEEL_MARKER_KEEP).toBe('kept')
      expect(calls[0]?.env.PATH).toBe(process.env.PATH)
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  })

  it('未指定 model 时 spawn argv 不含 omp 缺省模型', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new ClaudeCodeAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    expect(calls[0]).not.toContain('--model')
    expect(calls[0]).not.toContain(DEFAULT_OMP_MODEL)
  })
})

describe('契约拒绝 —— 不得降级执行', () => {
  it('native 输出模式被拒绝（本任务不接线 json-schema）', async () => {
    const a = new ClaudeCodeAdapter()
    const r = await a.startRun(spec({ output_contract: { schema_ref: 'x', mode: 'native' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.retryable).toBe(false)
  })

  it('相同 idempotency_key 不启动第二个进程', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new ClaudeCodeAdapter({ spawnFn })
    const s = spec()
    const first = await a.startRun(s)
    const second = await a.startRun(s)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.run_id).toBe(first.value.run_id)
    expect(calls.length).toBe(1)
  })

  it('result 无文本 → PROTOCOL_ERROR（post_validate 不能拿空串冒充成功）', async () => {
    const spawnFn = ((_bin: string, _args: readonly string[]) => {
      const p = new EventEmitter() as EventEmitter & {
        stdout: Readable
        stderr: Readable
      }
      p.stdout = Readable.from(['{"type":"result","result":"","is_error":false}\n'])
      p.stderr = Readable.from([])
      p.stdout.on('end', () => p.emit('close', 0))
      return p
    }) as unknown as typeof spawn
    const a = new ClaudeCodeAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
  })
})

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
      const pid = 41000 + procs.length
      const proc: FakeProc = {
        pid,
        killed: [],
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') closeHandlers.push(cb)
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
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new ClaudeCodeAdapter({ spawnFn, interruptKillTimeoutMs: 5 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const pid = procs[0]?.pid
      const intr = await adapter.interrupt(started.value, 'cancelled')
      expect(intr.ok).toBe(true)
      expect(killSpy).toHaveBeenCalledWith(-(pid as number), 'SIGTERM')
      procs[0]?.emitClose(143)
      const res = await adapter.awaitResult(started.value)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value.status).toBe('CANCELLED')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('interrupt reason=timeout → TIMEOUT; cancelled → CANCELLED', async () => {
    async function runWith(reason: 'cancelled' | 'timeout') {
      const { spawnFn, procs } = hangingSpawn()
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
      try {
        const adapter = new ClaudeCodeAdapter({ spawnFn, interruptKillTimeoutMs: 1 })
        const started = await adapter.startRun(spec())
        expect(started.ok).toBe(true)
        if (!started.ok) return null
        await adapter.interrupt(started.value, reason)
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

const REQUIRE_CLAUDE = process.env.KEEL_REQUIRE_CLAUDE === '1'

describe('requireClaudeAuth · 认证门禁', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN

  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedKey
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken
  })

  function noEnv(): void {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
  }

  it('环境 ANTHROPIC_API_KEY → 放行，且不探测 CLI', () => {
    noEnv()
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    let probed = false
    const r = requireClaudeAuth('claude', () => {
      probed = true
      return false
    })
    expect(r.ok).toBe(true)
    expect(probed).toBe(false)
    expect(envCredentialName()).toBe('ANTHROPIC_API_KEY')
  })

  it('环境 ANTHROPIC_AUTH_TOKEN（网关）→ 放行', () => {
    noEnv()
    process.env.ANTHROPIC_AUTH_TOKEN = 'gateway-token'
    const r = requireClaudeAuth('claude', () => false)
    expect(r.ok).toBe(true)
    expect(envCredentialName()).toBe('ANTHROPIC_AUTH_TOKEN')
  })

  it('无环境凭据 + CLI 报已登录 → 放行（settings 里的网关配置）', () => {
    noEnv()
    const r = requireClaudeAuth('claude', () => true)
    expect(r.ok).toBe(true)
  })

  it('无环境凭据 + CLI 报未登录 → AUTH_FAILED，文案列出三条路径', () => {
    noEnv()
    const r = requireClaudeAuth('claude', () => false)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toMatch(/--bare/)
    expect(r.error.detail).toMatch(/ANTHROPIC_API_KEY/)
    expect(r.error.detail).toMatch(/ANTHROPIC_AUTH_TOKEN/)
    expect(r.error.detail).toBe(claudeAuthMissingDetail())
  })

  it('探测不可判定（缺二进制）→ 不误报 AUTH_FAILED，交给二进制闸门', () => {
    noEnv()
    const r = requireClaudeAuth('keel-no-such-claude-bin-xyz', () => null)
    expect(r.ok).toBe(true)
  })

  it('空白环境值不算凭据', () => {
    noEnv()
    process.env.ANTHROPIC_API_KEY = '   '
    expect(envCredentialName()).toBeUndefined()
  })
})

describe('同 run_id 多轮（R-007 回灌）—— 不得串到上一轮', () => {
  function stream(text: string): string {
    return `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      total_cost_usd: 0.01,
    })}\n`
  }

  it('第二轮 awaitResult 拿到第二轮自己的输出', async () => {
    let call = 0
    const spawnFn = ((_bin: string, _args: readonly string[]) => {
      call += 1
      const p = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable }
      p.stdout = Readable.from([stream(call === 1 ? '第一轮' : '第二轮')])
      p.stderr = Readable.from([])
      p.stdout.on('end', () => p.emit('close', 0))
      return p
    }) as unknown as typeof spawn

    const a = new ClaudeCodeAdapter({ spawnFn })
    const t1 = await a.startRun(spec({ idempotency_key: 't1/develop/1#turn1' }))
    const t2 = await a.startRun(spec({ idempotency_key: 't1/develop/1#turn2' }))
    expect(t1.ok && t2.ok).toBe(true)
    if (!t1.ok || !t2.ok) return

    const r1 = await a.awaitResult(t1.value)
    const r2 = await a.awaitResult(t2.value)
    expect(r1.ok && r1.value.text).toBe('第一轮')
    expect(r2.ok && r2.value.text).toBe('第二轮')
  })

  it('interrupt 打到**当前轮**的进程，而不是上一轮的陈旧 state', async () => {
    interface FakeProc {
      pid: number
      stdout: { on: () => void }
      stderr: { on: () => void }
      on: (ev: 'error' | 'close', cb: (code?: number | null) => void) => void
      emitClose: (code: number | null) => void
    }
    const procs: FakeProc[] = []
    const spawnFn = ((_cmd: string, _args: readonly string[]): unknown => {
      const closeHandlers: Array<(code?: number | null) => void> = []
      const index = procs.length
      const proc: FakeProc = {
        pid: 20000 + index,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') closeHandlers.push(cb)
        },
        emitClose: (code) => {
          for (const cb of closeHandlers) cb(code)
        },
      }
      procs.push(proc)
      // 第一轮已经结束；第二轮挂住不回（真实进程仍在跑）
      if (index === 0) setImmediate(() => proc.emitClose(0))
      return proc
    }) as typeof spawn

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const a = new ClaudeCodeAdapter({ spawnFn, interruptKillTimeoutMs: 5 })
      const t1 = await a.startRun(spec({ idempotency_key: 't1/develop/1#turn1' }))
      const t2 = await a.startRun(spec({ idempotency_key: 't1/develop/1#turn2' }))
      expect(t1.ok && t2.ok).toBe(true)
      if (!t1.ok || !t2.ok) return
      await a.awaitResult(t1.value)

      await a.interrupt(t2.value, 'timeout')
      // 打中的必须是第二轮的进程组，不是第一轮那个已经结束的
      expect(killSpy).toHaveBeenCalledWith(-(procs[1]?.pid as number), 'SIGTERM')
      expect(killSpy).not.toHaveBeenCalledWith(-(procs[0]?.pid as number), 'SIGTERM')

      procs[1]?.emitClose(null)
      const r2 = await a.awaitResult(t2.value)
      expect(r2.ok && r2.value.status).toBe('TIMEOUT')
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('sanitizeClaudeEnv · 宿主运行时变量不进子进程', () => {
  it('剔除宿主托管 / 会话身份 / IPC 变量，其余原样保留', () => {
    const out = sanitizeClaudeEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      CLAUDE_CODE_MODEL_CATALOG: '0',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_SESSION_ID: 's',
      // 真正的配置与运行前提：必须保留
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
      CLAUDE_CONFIG_DIR: '/home/u/.claude-work',
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy:8080',
    })
    expect(out.CLAUDECODE).toBeUndefined()
    expect(out.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
    expect(out.CLAUDE_CODE_MODEL_CATALOG).toBeUndefined()
    expect(out.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
    expect(out.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined()
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined()

    expect(out.ANTHROPIC_AUTH_TOKEN).toBe('token')
    expect(out.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3425')
    expect(out.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude-work')
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HTTPS_PROXY).toBe('http://proxy:8080')
  })

  it('不改原 env（纯函数）', () => {
    const src = { CLAUDECODE: '1', PATH: '/usr/bin' }
    sanitizeClaudeEnv(src)
    expect(src.CLAUDECODE).toBe('1')
  })
})

describe('requireClaudeBinary', () => {
  it('找不到二进制 → HARNESS_UNAVAILABLE（可重试 kind，但 CLI 在进 loop 前返回）', () => {
    const r = requireClaudeBinary('keel-no-such-claude-bin-xyz')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('HARNESS_UNAVAILABLE')
    expect(r.error.detail).toMatch(/T-031/)
    expect(r.error.detail).toMatch(/claude/)
  })
})

describe.skipIf(!REQUIRE_CLAUDE)('真实集成：claude CLI（不进默认 check）', () => {
  it('claude 可执行 —— 开启门控后缺失即失败而非跳过', async () => {
    const { execFileSync } = await import('node:child_process')
    expect(() => execFileSync('claude', ['--version'], { stdio: 'pipe' })).not.toThrow()
  })
})
