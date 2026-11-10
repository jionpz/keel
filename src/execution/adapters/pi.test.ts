import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RunSpec } from '../../contracts/harness-adapter.js'
import { DEFAULT_OMP_MODEL } from './omp.js'
import {
  buildPiArgv,
  discoverPiSubagentsExtension,
  PI_BUILTIN_TOOLS,
  PI_CAPABILITIES,
  PiAdapter,
  resolvePiTools,
} from './pi.js'
import { tierOf } from './tier.js'

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
    permissions: { allowed_tools: [], mode: 'auto' },
    limits: { wall_clock_s: 120, budget_usd: null, max_turns: 4 },
    ...over,
  }
}

const OK_STREAM = [
  '{"type":"session","version":3,"id":"0199a4c4-0000-7000-8000-000000000001","cwd":"/tmp"}',
  '{"type":"agent_start"}',
  '{"type":"turn_start"}',
  '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
  '{"type":"message_update","usage":{"input":100,"output":7,"totalTokens":107,"cost":{"total":0.002}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ok"}}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"input":100,"output":7,"totalTokens":107,"cost":{"total":0.002}}}}',
  '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
  '{"type":"agent_end","messages":[],"willRetry":false}',
  '{"type":"agent_settled","aborted":false}',
].join('\n')

interface SpawnCall {
  bin: string
  args: string[]
  cwd: string | undefined
}

function recordingSpawn(
  stdout: string = OK_STREAM,
  code = 0,
): { spawnFn: typeof spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawnFn = ((bin: string, args: readonly string[], opts?: { cwd?: string }): unknown => {
    calls.push({ bin, args: [...args], cwd: opts?.cwd })
    const p = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      pid: number
    }
    p.pid = 41000
    p.stdout = Readable.from([stdout])
    p.stderr = Readable.from([])
    p.stdout.on('end', () => p.emit('close', code))
    return p
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}

describe('Pi capability / tier', () => {
  it('不声明 RESUME / STRUCTURED_OUTPUT / INTERRUPT，tier 真实降为 L0', () => {
    expect(PI_CAPABILITIES).toContain('CAP-UNTRUSTED_WORKSPACE')
    expect(PI_CAPABILITIES).toContain('CAP-STREAM')
    expect(PI_CAPABILITIES).toContain('CAP-COST')
    expect(PI_CAPABILITIES).not.toContain('CAP-RESUME')
    expect(PI_CAPABILITIES).not.toContain('CAP-STRUCTURED_OUTPUT')
    expect(PI_CAPABILITIES).not.toContain('CAP-INTERRUPT')
    expect(tierOf(PI_CAPABILITIES)).toBe('L0')
  })

  it('describe().harness_id 是 pi，cost_basis 是 estimated', () => {
    const d = new PiAdapter().describe()
    expect(d.harness_id).toBe('pi')
    expect(d.tier).toBe('L0')
    expect(d.cost_basis).toBe('estimated')
  })
})

describe('Pi 推荐子代理扩展', () => {
  it('在 PI_AGENT_DIR 下发现固定包并加入真实 inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-agent-'))
    const source = join(dir, 'npm', 'node_modules', '@tintinweb', 'pi-subagents', 'src')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'index.ts'), 'export default {}', 'utf8')
    vi.stubEnv('PI_AGENT_DIR', dir)
    try {
      expect(discoverPiSubagentsExtension()).toBe(join(source, 'index.ts'))
      const descriptor = new PiAdapter().describe()
      expect(descriptor.tool_inventory).toContain('Agent')
      expect(descriptor.tool_inventory).toContain('get_subagent_result')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('autoSubagents=false 不虚报 Agent', () => {
    const descriptor = new PiAdapter({ autoSubagents: false }).describe()
    expect(descriptor.tool_inventory).not.toContain('Agent')
  })
})

describe('buildPiArgv', () => {
  it('固定 --print --mode json，且不出现 OMP 的 --approval-mode', () => {
    const argv = buildPiArgv(spec())
    expect(argv.slice(0, 3)).toEqual(['--print', '--mode', 'json'])
    expect(argv.join(' ')).not.toContain('--approval-mode')
    expect(argv).not.toContain('--cwd')
  })

  it('资源发现一律关闭（扩展 / skills / 模板 / 上下文文件 / MCP），且不交互询问信任', () => {
    const argv = buildPiArgv(spec())
    for (const flag of [
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-mcp',
      '--no-approve',
    ]) {
      expect(argv, `缺 ${flag}`).toContain(flag)
    }
  })

  it('显式受信扩展才用 -e 加载', () => {
    const argv = buildPiArgv(spec(), { extensions: ['./trusted/ext.ts', 'builtin:mcp'] })
    const first = argv.indexOf('-e')
    expect(argv[first + 1]).toBe('./trusted/ext.ts')
    expect(argv[first + 2]).toBe('-e')
    expect(argv[first + 3]).toBe('builtin:mcp')
  })

  it('逻辑工具名与 Pi 内置同名', () => {
    const argv = buildPiArgv(
      spec({ permissions: { allowed_tools: ['read', 'write'], mode: 'auto' } }),
    )
    const i = argv.indexOf('--tools')
    expect(argv[i + 1]).toBe('read,write')
  })

  it('grep / find / ls / edit / bash 都在内置表里', () => {
    const tools = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']
    const argv = buildPiArgv(spec({ permissions: { allowed_tools: tools, mode: 'auto' } }))
    const i = argv.indexOf('--tools')
    expect(argv[i + 1]).toBe(tools.join(','))
    expect([...PI_BUILTIN_TOOLS].sort()).toEqual([...tools].sort())
  })

  it('空工具列表 → --no-tools', () => {
    const argv = buildPiArgv(spec())
    expect(argv).toContain('--no-tools')
    expect(argv).not.toContain('--tools')
  })

  it('未知工具名直接失败，不静默丢弃', () => {
    expect(() =>
      buildPiArgv(spec({ permissions: { allowed_tools: ['read', 'deploy'], mode: 'auto' } })),
    ).toThrow(/deploy/)
  })

  it('受信扩展工具名通过；未受信的同名仍失败', () => {
    const s = spec({ permissions: { allowed_tools: ['read', 'Agent'], mode: 'auto' } })
    expect(() => buildPiArgv(s)).toThrow(/Agent/)
    const argv = buildPiArgv(s, {
      trustedTools: ['Agent'],
      extensions: ['./trusted/agent.ts'],
    })
    const i = argv.indexOf('--tools')
    expect(argv[i + 1]).toBe('read,Agent')
  })

  it('trustedTools 非空但 extensions 为空直接失败', () => {
    const s = spec({ permissions: { allowed_tools: ['read', 'Agent'], mode: 'auto' } })
    expect(() => buildPiArgv(s, { trustedTools: ['Agent'] })).toThrow(/extensions/)
  })

  it('缺省不传 --model / --provider / --thinking（用用户现有配置）', () => {
    const argv = buildPiArgv(spec())
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--provider')
    expect(argv).not.toContain('--thinking')
    expect(argv).not.toContain(DEFAULT_OMP_MODEL)
  })

  it('显式 model 进 argv；provider 只在有 model 时进', () => {
    const argv = buildPiArgv(spec(), { model: 'opencode-go/deepseek-v4.1-flash' })
    expect(argv[argv.indexOf('--model') + 1]).toBe('opencode-go/deepseek-v4.1-flash')
    expect(argv).not.toContain('--provider')
    const withProvider = buildPiArgv(spec(), { model: 'm1', provider: 'magpie' })
    expect(withProvider[withProvider.indexOf('--provider') + 1]).toBe('magpie')
    expect(buildPiArgv(spec(), { provider: 'magpie' })).not.toContain('--provider')
  })

  it('显式 thinking 层进入 argv，不设默认思考等级', () => {
    const argv = buildPiArgv(spec(), { thinking: 'max' })
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('max')
  })

  it('空白 model / provider / thinking 明确失败，不默默回退', () => {
    expect(() => buildPiArgv(spec(), { model: '   ' })).toThrow(/model/)
    expect(() => buildPiArgv(spec(), { provider: '   ' })).toThrow(/provider/)
    expect(() => buildPiArgv(spec(), { thinking: '   ' })).toThrow(/thinking/)
  })

  it('prompt 放在 -- 之后，避免被当成选项', () => {
    const argv = buildPiArgv(spec(), { prompt: '- Summarize' })
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv[argv.length - 1]).toBe('- Summarize')
  })

  it('buildPiArgv 只消费调用方解析后的最终模型（不在 argv 层再解析一轮）', () => {
    const argv = buildPiArgv(spec({ model: 'from-spec' }), { model: 'from-ctor' })
    expect(argv[argv.indexOf('--model') + 1]).toBe('from-ctor')
  })
})

describe('resolvePiTools', () => {
  it('大小写归一到 Pi 内置名', () => {
    const r = resolvePiTools(['Read', 'Bash'])
    expect(r.ok && r.value).toEqual(['read', 'bash'])
  })

  it('重复项去重', () => {
    const r = resolvePiTools(['read', 'read'])
    expect(r.ok && r.value).toEqual(['read'])
  })

  it('未知工具返回 CAPABILITY_UNSUPPORTED', () => {
    const r = resolvePiTools(['read', 'deploy'])
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.retryable).toBe(false)
  })
})

describe('renderPrompt —— 每个 section 都要真的进提示词', () => {
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

  it('全部 section 按顺序进入提示词，阶段指令在最后', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(multiSectionSpec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)

    const args = calls[0]?.args ?? []
    const prompt = args[args.length - 1] ?? ''
    expect(prompt).toContain('你是 PM。')
    expect(prompt).toContain('KEEL_MARKER_FEEDBACK')
    expect(prompt.indexOf('KEEL_MARKER_FEEDBACK')).toBeLessThan(prompt.indexOf('判断上面的'))
    expect(args[args.length - 2]).toBe('--')
  })

  it('以 @ 开头的 section 不会被 Pi 当成 @file 展开', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(
      spec({
        context: {
          context_id: 'c-at',
          recipe_id: 'PM',
          recipe_version: '1',
          sections: [
            {
              id: 'at',
              source_ref: 'fixed:at',
              source_kind: 'fixed',
              priority: 'required',
              content: '@README.md\n这是任务上下文，不是文件引用。',
              tokens: 5,
            },
            {
              id: 'dash',
              source_ref: 'fixed:dash',
              source_kind: 'fixed',
              priority: 'required',
              content: '- 不要当成命令行选项。',
              tokens: 5,
            },
          ],
          total_tokens: 10,
          dropped: [],
        },
      }),
    )
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    const args = calls[0]?.args ?? []
    const prompt = args[args.length - 1] ?? ''
    expect(prompt.startsWith('@')).toBe(false)
    expect(prompt).toContain('@README.md')
    expect(prompt).toContain('这是任务上下文，不是文件引用。')
    expect(prompt).toContain('- 不要当成命令行选项。')
  })

  it('spawn 的 cwd 是 workspace.path，bin 是 pi', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(
      spec({ workspace: { path: '/ws/task-1', repo_id: 'r', branch: 'ai/x', untrusted: true } }),
    )
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    expect(calls[0]?.cwd).toBe('/ws/task-1')
    expect(calls[0]?.bin).toBe('pi')
  })

  it('spec.model 优先于构造参数模型，最终进入 --model', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn, model: 'from-ctor' })
    const started = await a.startRun(spec({ model: 'from-spec' }))
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    const args = calls[0]?.args ?? []
    expect(args[args.indexOf('--model') + 1]).toBe('from-spec')
  })

  it('没有显式模型时不传 --model（用用户现有配置）', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    expect(calls[0]?.args).not.toContain('--model')
  })

  it('显式 thinking=max 进入 spawn argv', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn, thinking: 'max' })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)
    const args = calls[0]?.args ?? []
    expect(args[args.indexOf('--thinking') + 1]).toBe('max')
  })
})

describe('契约拒绝 —— 不得降级执行', () => {
  it('native 输出模式被拒绝', async () => {
    const a = new PiAdapter()
    const r = await a.startRun(spec({ output_contract: { schema_ref: 'x', mode: 'native' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.retryable).toBe(false)
  })

  it('manual 权限模式被拒绝（headless 无逐次审批，不冒充）', async () => {
    const a = new PiAdapter()
    const r = await a.startRun(spec({ permissions: { allowed_tools: ['read'], mode: 'manual' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/manual/)
  })

  it('未知工具在 spawn 之前失败', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const r = await a.startRun(spec({ permissions: { allowed_tools: ['deploy'], mode: 'auto' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(calls).toHaveLength(0)
  })

  it('trustedTools 非空但 extensions 为空在 spawn 之前失败', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn, trustedTools: ['Agent'] })
    const r = await a.startRun(spec({ permissions: { allowed_tools: ['Agent'], mode: 'auto' } }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/extensions/)
    expect(calls).toHaveLength(0)
  })

  it('只设 provider 不设 model 被拒绝（--provider 依赖 --model）', async () => {
    const a = new PiAdapter({ provider: 'magpie' })
    const r = await a.startRun(spec())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
  })

  it('构造参数模型为空白时明确失败', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn, model: '   ' })
    const r = await a.startRun(spec())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(calls).toHaveLength(0)
  })

  it('spec.model 为空白时失败，不静默回退到构造参数模型', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn, model: 'from-ctor' })
    const r = await a.startRun(spec({ model: '   ' }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(calls).toHaveLength(0)
  })

  it('空白 provider / thinking 明确失败', async () => {
    const provider = new PiAdapter({ provider: '   ' })
    const providerResult = await provider.startRun(spec())
    expect(providerResult.ok).toBe(false)

    const thinking = new PiAdapter({ thinking: '   ' })
    const thinkingResult = await thinking.startRun(spec())
    expect(thinkingResult.ok).toBe(false)
  })

  it('相同 idempotency_key 不启动第二个进程', async () => {
    const { spawnFn, calls } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const s = spec()
    const first = await a.startRun(s)
    const second = await a.startRun(s)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.run_id).toBe(first.value.run_id)
    expect(calls).toHaveLength(1)
  })

  it('退出码非 0 且无 usage → HARNESS_UNAVAILABLE，附带 stderr', async () => {
    const { spawnFn } = recordingSpawn('', 2)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('HARNESS_UNAVAILABLE')
  })

  it('退出码非 0 但已上报 usage → FAILED 且保留已见 usage', async () => {
    const stream = [
      '{"type":"session","id":"s-fail"}',
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","usage":{"input":9,"output":2,"cost":{"total":0.001}},"assistantMessageEvent":{"type":"text_delta","delta":"x"}}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 2)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.status).toBe('FAILED')
    expect(res.value.usage.tokens_in).toBe(9)
    expect(res.value.usage.tokens_out).toBe(2)
    expect(res.value.usage.cost_usd).toBeCloseTo(0.001)
    expect(res.value.usage.cost_basis).toBe('estimated')
    expect(res.value.session_ref).toBe('s-fail')
  })

  it('assistant stopReason=error → PROTOCOL_ERROR（JSON 模式退出码仍是 0）', async () => {
    const stream = [
      '{"type":"session","id":"s1"}',
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"529 overloaded"}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/529 overloaded/)
  })

  it('输出被 length 截断 → PROTOCOL_ERROR（不把半截文本当成功）', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"半截"}],"stopReason":"length"}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/length/)
  })

  it('只有 agent_end 没有最终 agent_settled → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"旧成功文本"}],"stopReason":"stop"}}',
      '{"type":"agent_end","messages":[],"willRetry":true}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/agent_settled/)
  })

  it('只有 agent_settled 没有 assistant 消息 → PROTOCOL_ERROR', async () => {
    const { spawnFn } = recordingSpawn('{"type":"agent_settled","aborted":false}\n', 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/stopReason=none/)
  })

  it('未有 settled 但流里有旧成功文本 → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/agent_settled/)
  })

  it('agent_settled 时仍有未结束工具调用 → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
      '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/工具调用未结束/)
  })

  it('agent_settled 时自动重试未结束 → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/自动重试尚未结束/)
  })

  it('自动重试最终失败 → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"529 overloaded"}}',
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}',
      '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"terminated"}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
    expect(res.error.detail).toMatch(/自动重试最终失败/)
  })

  it('末条 assistant 消息无文本 → PROTOCOL_ERROR', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('PROTOCOL_ERROR')
  })
})

describe('成功路径：文本 / usage / session_ref', () => {
  it('末条 assistant 文本 + 累加 usage + session 头 id', async () => {
    const { spawnFn } = recordingSpawn()
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.status).toBe('SUCCEEDED')
    expect(res.value.text).toBe('ok')
    expect(res.value.usage.tokens_in).toBe(100)
    expect(res.value.usage.tokens_out).toBe(7)
    expect(res.value.usage.cost_usd).toBeCloseTo(0.002)
    expect(res.value.usage.cost_basis).toBe('estimated')
    expect(res.value.session_ref).toBe('0199a4c4-0000-7000-8000-000000000001')
  })

  it('多轮工具循环：中间叙述不当终答，usage 跨消息累加', async () => {
    const stream = [
      '{"type":"session","id":"sess-multi"}',
      '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"我先看看文件"}],"stopReason":"toolUse","usage":{"input":10,"output":2,"cost":{"total":0.001}}}}',
      '{"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{}}',
      '{"type":"tool_execution_end","toolCallId":"c1","toolName":"read","result":{},"isError":false}',
      '{"type":"turn_end","message":{"role":"assistant"},"toolResults":[]}',
      '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"终答"}],"stopReason":"stop","usage":{"input":20,"output":5,"cost":{"total":0.003}}}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.text).toBe('终答')
    expect(res.value.usage.tokens_in).toBe(30)
    expect(res.value.usage.tokens_out).toBe(7)
    expect(res.value.usage.cost_usd).toBeCloseTo(0.004)
  })

  it('先 error 后自动恢复成功 → SUCCEEDED，取最终文本', async () => {
    const stream = [
      '{"type":"session","id":"s-recover"}',
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"529 overloaded"}}',
      '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}',
      '{"type":"auto_retry_end","success":true,"attempt":2}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"recovered"}],"stopReason":"stop","usage":{"input":5,"output":1,"cost":{"total":0.0005}}}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.status).toBe('SUCCEEDED')
    expect(res.value.text).toBe('recovered')
    expect(res.value.usage.tokens_in).toBe(5)
  })

  it('agent_end(willRetry=true) 之后继续跑到最终 settled → SUCCEEDED', async () => {
    const stream = [
      '{"type":"session","id":"s-retry"}',
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first"}],"stopReason":"toolUse","usage":{"input":1,"output":1}}}',
      '{"type":"agent_end","messages":[],"willRetry":true}',
      '{"type":"agent_start"}',
      '{"type":"turn_start"}',
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final"}],"stopReason":"stop","usage":{"input":2,"output":2}}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream, 0)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.text).toBe('final')
    expect(res.value.usage.tokens_in).toBe(3)
    expect(res.value.usage.tokens_out).toBe(3)
  })

  it('usage 从未上报 → null + unavailable，不补 0', async () => {
    const stream = [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream)
    const a = new PiAdapter({ spawnFn })
    const started = await a.startRun(spec())
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const res = await a.awaitResult(started.value)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.usage).toEqual({
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      cost_basis: 'unavailable',
    })
  })
})

describe('进展遥测（liveness）', () => {
  it('首个事件带 pid/pgid；message_update 被节流；工具事件不节流', async () => {
    const stream = [
      '{"type":"session","id":"s1"}',
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","usage":{"input":1,"output":1},"assistantMessageEvent":{"type":"text_delta","delta":"a"}}',
      '{"type":"message_update","usage":{"input":1,"output":2},"assistantMessageEvent":{"type":"text_delta","delta":"b"}}',
      '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{}}',
      '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"input":3,"output":2}}}',
      '{"type":"agent_settled","aborted":false}',
    ].join('\n')
    const { spawnFn } = recordingSpawn(stream)
    const a = new PiAdapter({ spawnFn })
    const events: Array<{ kind: string; pid?: number; pgid?: number }> = []
    const started = await a.startRun(spec(), { onProgress: (e) => events.push(e) })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await a.awaitResult(started.value)

    expect(events[0]?.kind).toBe('session')
    expect(events[0]?.pid).toBe(41000)
    expect(events[0]?.pgid).toBe(41000)
    expect(events.filter((e) => e.kind === 'message_update')).toHaveLength(1)
    expect(events.some((e) => e.kind === 'tool_execution_start')).toBe(true)
    expect(events[1]?.pid).toBeUndefined()
  })
})

describe('interrupt 杀进程组', () => {
  interface Proc {
    pid: number
    stdout: { on: () => void }
    stderr: { on: () => void }
    on: (ev: 'error' | 'close', cb: (code?: number | null) => void) => void
    emitClose: (code: number) => void
  }

  function hangingSpawn(): { spawnFn: typeof spawn; procs: Proc[] } {
    const procs: Proc[] = []
    const spawnFn = ((_cmd: string, _args: readonly string[]): unknown => {
      const closeHandlers: Array<(code?: number | null) => void> = []
      const pid = 42000 + procs.length
      const proc: Proc = {
        pid,
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
      return proc
    }) as unknown as typeof spawn
    return { spawnFn, procs }
  }

  it('interrupt 向进程组发 SIGTERM，收敛为 CANCELLED', async () => {
    const { spawnFn, procs } = hangingSpawn()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new PiAdapter({ spawnFn, interruptKillTimeoutMs: 5 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return
      const intr = await adapter.interrupt(started.value, 'cancelled')
      expect(intr.ok).toBe(true)
      expect(killSpy).toHaveBeenCalledWith(-(procs[0]?.pid as number), 'SIGTERM')
      procs[0]?.emitClose(143)
      const res = await adapter.awaitResult(started.value)
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.value.status).toBe('CANCELLED')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('reason=timeout → TIMEOUT', async () => {
    const { spawnFn, procs } = hangingSpawn()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new PiAdapter({ spawnFn, interruptKillTimeoutMs: 1 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await adapter.interrupt(started.value, 'timeout')
      procs[0]?.emitClose(143)
      const res = await adapter.awaitResult(started.value)
      expect(res.ok && res.value.status).toBe('TIMEOUT')
    } finally {
      killSpy.mockRestore()
    }
  })

  it('中断前上报的 usage 必须入账（含跨 chunk 的半行）', async () => {
    interface DataProc {
      pid: number
      stdout: { on: (ev: 'data', cb: (chunk: Buffer) => void) => void }
      stderr: { on: () => void }
      on: (ev: 'error' | 'close', cb: (code?: number | null) => void) => void
      emitClose: (code: number) => void
      emitData: (chunk: string) => void
    }

    const procs: DataProc[] = []
    const spawnFn = ((_cmd: string, _args: readonly string[]): unknown => {
      const dataHandlers: Array<(chunk: Buffer) => void> = []
      const closeHandlers: Array<(code?: number | null) => void> = []
      const pid = 43000 + procs.length
      const proc: DataProc = {
        pid,
        stdout: { on: (_ev, cb) => dataHandlers.push(cb) },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') closeHandlers.push(cb)
        },
        emitClose: (code) => {
          for (const cb of closeHandlers) cb(code)
        },
        emitData: (chunk) => {
          for (const cb of dataHandlers) cb(Buffer.from(chunk))
        },
      }
      procs.push(proc)
      return proc
    }) as unknown as typeof spawn

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new PiAdapter({ spawnFn, interruptKillTimeoutMs: 1 })
      const started = await adapter.startRun(spec())
      expect(started.ok).toBe(true)
      if (!started.ok) return

      procs[0]?.emitData('{"type":"message_start","message":{"role":"assistant","content":[]}}\n')
      const update =
        '{"type":"message_update","usage":{"input":11,"output":3,"cost":{"total":0.004}},"assistantMessageEvent":{"type":"text_delta","delta":"x"}}'
      procs[0]?.emitData(update.slice(0, 31))
      procs[0]?.emitData(`${update.slice(31)}\n`)
      await adapter.interrupt(started.value, 'timeout')
      procs[0]?.emitClose(143)

      const res = await adapter.awaitResult(started.value)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.value.status).toBe('TIMEOUT')
      expect(res.value.usage.tokens_in).toBe(11)
      expect(res.value.usage.tokens_out).toBe(3)
      expect(res.value.usage.cost_usd).toBeCloseTo(0.004)
      expect(res.value.usage.cost_basis).toBe('estimated')
    } finally {
      killSpy.mockRestore()
    }
  })
})

describe('多轮同 run_id —— handle 不得串到上一轮', () => {
  interface Proc {
    pid: number
    stdout: { on: () => void }
    stderr: { on: () => void }
    on: (ev: 'error' | 'close', cb: (code?: number | null) => void) => void
    close: (code: number) => void
  }

  function controllableSpawn(): { spawnFn: typeof spawn; procs: Proc[] } {
    const procs: Proc[] = []
    const spawnFn = ((_cmd: string, _args: readonly string[]): unknown => {
      const closeHandlers: Array<(code?: number | null) => void> = []
      const pid = 44000 + procs.length
      const proc: Proc = {
        pid,
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') closeHandlers.push(cb)
        },
        close: (code) => {
          for (const cb of closeHandlers) cb(code)
        },
      }
      procs.push(proc)
      return proc
    }) as unknown as typeof spawn
    return { spawnFn, procs }
  }

  it('第 2 轮 awaitResult 等的是第 2 轮；interrupt 打到当前轮', async () => {
    const { spawnFn, procs } = controllableSpawn()
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const adapter = new PiAdapter({ spawnFn, interruptKillTimeoutMs: 1 })
      const turn1 = await adapter.startRun(spec({ idempotency_key: 'k#turn1' }))
      expect(turn1.ok).toBe(true)
      if (!turn1.ok) return
      procs[0]?.close(0)
      await adapter.awaitResult(turn1.value)

      const turn2 = await adapter.startRun(spec({ idempotency_key: 'k#turn2' }))
      expect(turn2.ok).toBe(true)
      if (!turn2.ok) return

      let settled = false
      const pending = adapter.awaitResult(turn2.value).then((r) => {
        settled = true
        return r
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      await adapter.interrupt(turn2.value, 'cancelled')
      expect(killSpy).toHaveBeenCalledWith(-(procs[1]?.pid as number), 'SIGTERM')
      procs[1]?.close(143)
      const res = await pending
      expect(res.ok && res.value.status).toBe('CANCELLED')
    } finally {
      killSpy.mockRestore()
    }
  })
})
