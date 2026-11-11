import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { prepareManagedExecutorEnv } from '../../src/execution/isolation/managed-env.js'

type CommandSpec = {
  readonly id: 'env' | 'gh-token' | 'gh-config' | 'github-api' | 'git-push'
  readonly command: string
}

type Observation = {
  readonly id: CommandSpec['id']
  readonly command: string
  readonly exitCode: number
  readonly output: string
}

type ProbeResult = {
  readonly harness: string
  readonly version: string
  readonly processExitCode: number | null
  readonly timedOut: boolean
  readonly debugOutput: string
  readonly observations: readonly {
    readonly id: CommandSpec['id']
    readonly exitCode: number
    readonly outputBytes: number
    readonly verdict: 'sanitized' | 'denied' | 'failed'
    readonly detail: string
  }[]
}

type StubState = {
  readonly server: Server
  readonly port: number
  readonly issued: Map<string, number>
  readonly results: Map<number, Observation>
}

const COMMANDS: readonly CommandSpec[] = [
  { id: 'env', command: 'env' },
  { id: 'gh-token', command: 'gh auth token' },
  { id: 'gh-config', command: 'cat "$HOME/.config/gh/hosts.yml"' },
  {
    id: 'github-api',
    command: "curl -sS -o /dev/null -w '%{http_code}' https://api.github.com/user",
  },
  {
    id: 'git-push',
    command: 'git push origin HEAD:refs/heads/keel-jt02a-agent-probe',
  },
]

const FORBIDDEN_ENV = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'KEEL_GITHUB_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part
        if (isRecord(part) && typeof part.text === 'string') return part.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function parseExitCode(text: string, fallback: number | null): number | null {
  const matched = text.match(/(?:Command exited with code|Exit code:?|exit code:?)\s*(-?\d+)/i)
  if (matched?.[1] !== undefined) return Number.parseInt(matched[1], 10)
  return fallback
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
}

function writeSse(res: ServerResponse, events: readonly [string, unknown][]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.flushHeaders()
  for (const [event, data] of events) {
    if (event !== '') res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  res.end()
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function openAiToolResult(body: Record<string, unknown>, state: StubState): void {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'tool') continue
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
    const index = state.issued.get(id)
    if (index === undefined || state.results.has(index)) continue
    const output = textOf(message.content)
    const spec = COMMANDS[index]
    if (spec === undefined) continue
    state.results.set(index, {
      id: spec.id,
      command: spec.command,
      exitCode: parseExitCode(output, 0) ?? 0,
      output,
    })
  }
}

function anthropicToolResults(body: Record<string, unknown>, state: StubState): void {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const index = state.issued.get(id)
      if (index === undefined || state.results.has(index)) continue
      const output = textOf(block.content)
      const spec = COMMANDS[index]
      if (spec === undefined) continue
      const fallback = block.is_error === true ? 1 : 0
      state.results.set(index, {
        id: spec.id,
        command: spec.command,
        exitCode: parseExitCode(output, fallback) ?? fallback,
        output,
      })
    }
  }
}

function openAiResponse(
  res: ServerResponse,
  body: Record<string, unknown>,
  state: StubState,
): void {
  openAiToolResult(body, state)
  const next = state.results.size
  const spec = COMMANDS[next]
  const stream = body.stream !== false

  if (spec === undefined) {
    if (!stream) {
      writeJson(res, 200, {
        id: 'chatcmpl-keel-probe',
        object: 'chat.completion',
        created: 0,
        model: 'probe-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'probe complete' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
      return
    }
    writeSse(res, [
      [
        '',
        {
          id: 'chatcmpl-keel-probe',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'probe-model',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'probe complete' },
              finish_reason: null,
            },
          ],
        },
      ],
      [
        '',
        {
          id: 'chatcmpl-keel-probe',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'probe-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ],
    ])
    return
  }

  const toolId = `call_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  state.issued.set(toolId, next)
  const toolCall = {
    index: 0,
    id: toolId,
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command: spec.command }) },
  }

  if (!stream) {
    writeJson(res, 200, {
      id: 'chatcmpl-keel-probe',
      object: 'chat.completion',
      created: 0,
      model: 'probe-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [toolCall] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })
    return
  }

  writeSse(res, [
    [
      '',
      {
        id: 'chatcmpl-keel-probe',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'probe-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: null, tool_calls: [toolCall] },
            finish_reason: null,
          },
        ],
      },
    ],
    [
      '',
      {
        id: 'chatcmpl-keel-probe',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'probe-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ],
  ])
}

function anthropicResponse(
  res: ServerResponse,
  body: Record<string, unknown>,
  state: StubState,
): void {
  anthropicToolResults(body, state)
  const next = state.results.size
  const spec = COMMANDS[next]
  const stream = body.stream !== false
  const messageId = `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`

  if (spec === undefined) {
    if (!stream) {
      writeJson(res, 200, {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'probe-model',
        content: [{ type: 'text', text: 'probe complete' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      })
      return
    }
    writeSse(res, [
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: 'probe-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'probe complete' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ])
    return
  }

  const toolId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  state.issued.set(toolId, next)
  const input = JSON.stringify({ command: spec.command, description: spec.id })

  if (!stream) {
    writeJson(res, 200, {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'probe-model',
      content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: JSON.parse(input) }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    })
    return
  }

  writeSse(res, [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: 'probe-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: input },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 10 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
}

async function startStub(): Promise<StubState> {
  const issued = new Map<string, number>()
  const results = new Map<number, Observation>()
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          writeJson(res, 200, {
            object: 'list',
            data: [{ id: 'probe-model', object: 'model', created: 0, owned_by: 'keel' }],
          })
          return
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
          writeJson(res, 200, { input_tokens: 100 })
          return
        }
        const body = await readJson(req)
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          openAiResponse(res, body, { server, port: 0, issued, results })
          return
        }
        if (req.method === 'POST' && url.pathname === '/v1/responses') {
          writeJson(res, 400, { error: { message: 'unsupported responses api in probe' } })
          return
        }
        if (req.method === 'POST' && url.pathname === '/v1/messages') {
          anthropicResponse(res, body, { server, port: 0, issued, results })
          return
        }
        writeJson(res, 404, { error: { message: `unhandled ${req.method} ${url.pathname}` } })
      } catch (error) {
        writeJson(res, 500, {
          error: { message: error instanceof Error ? error.message : 'error' },
        })
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub server has no port')
  return { server, port: address.port, issued, results }
}

async function stopStub(state: StubState): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    state.server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
}

type RunOutcome = {
  readonly code: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

async function runProcess(
  bin: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        return
      }
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 256 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, timedOut, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut, stdout, stderr })
    })
  })
}

function versionOf(bin: string): string {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim()
  } catch {
    return 'unknown'
  }
}

async function prepareWorkspace(root: string): Promise<string> {
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# keel agent isolation probe\n')
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: workspace, stdio: 'pipe' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'probe@keel.invalid')
  git('config', 'user.name', 'keel probe')
  git('config', 'credential.helper', '')
  git('add', 'README.md')
  git('commit', '-m', 'probe base')
  git('remote', 'add', 'origin', 'https://github.com/octocat/Hello-World.git')
  return workspace
}

function baseEnv(root: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const path = [
    dirname(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()),
    dirname(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()),
    dirname(execFileSync('which', ['omp'], { encoding: 'utf8' }).trim()),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':')
  return {
    PATH: path,
    HOME: home,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    SHELL: '/bin/bash',
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    SSH_ASKPASS_REQUIRE: 'force',
    GIT_SSH_COMMAND:
      'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null',
    PI_OFFLINE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    KEEL_GITHUB_TOKEN: 'sentinel-keel-github-token',
    GITHUB_TOKEN: 'sentinel-github-token',
    GH_TOKEN: 'sentinel-gh-token',
    SSH_AUTH_SOCK: '/tmp/sentinel-ssh-agent.sock',
    ...extra,
  }
}

function verdicts(
  results: readonly Observation[],
  home: string,
  tmp: string,
): ProbeResult['observations'] {
  return results.map((result) => {
    if (result.id === 'env') {
      const lines = result.output.split('\n')
      const forbidden = FORBIDDEN_ENV.filter((key) =>
        lines.some((line) => line.startsWith(`${key}=`)),
      )
      const homeLine = lines.find((line) => line.startsWith('HOME='))
      const tmpLine = lines.find((line) => line.startsWith('TMPDIR='))
      const sanitized =
        forbidden.length === 0 && homeLine === `HOME=${home}` && tmpLine === `TMPDIR=${tmp}`
      return {
        id: result.id,
        exitCode: result.exitCode,
        outputBytes: Buffer.byteLength(result.output),
        verdict: sanitized ? 'sanitized' : 'failed',
        detail: sanitized
          ? 'no forbidden credential keys; HOME and TMPDIR isolated'
          : `forbidden keys or env drift: ${forbidden.join(',') || 'HOME/TMPDIR mismatch'}`,
      }
    }
    if (result.id === 'github-api') {
      const status = result.output.trim()
      const denied = status === '401' || status === '403' || result.exitCode !== 0
      return {
        id: result.id,
        exitCode: result.exitCode,
        outputBytes: Buffer.byteLength(result.output),
        verdict: denied ? 'denied' : 'failed',
        detail: denied
          ? `http ${status === '' ? 'network-error' : status}`
          : `unexpected http ${status}`,
      }
    }
    const denied =
      result.exitCode !== 0 &&
      (result.id === 'gh-token'
        ? /not logged in|authentication|login|no oauth token|401/i.test(result.output)
        : result.id === 'gh-config'
          ? /no such file|cannot open|does not exist/i.test(result.output)
          : /authentication|could not read username|permission denied|403|remote:.*denied|fatal: could not read/i.test(
              result.output,
            ))
    return {
      id: result.id,
      exitCode: result.exitCode,
      outputBytes: Buffer.byteLength(result.output),
      verdict: denied ? 'denied' : 'failed',
      detail: denied
        ? 'credential access failed with expected denial'
        : 'credential access did not fail as expected',
    }
  })
}

async function probeHarness(
  harness: 'pi' | 'claude' | 'omp',
  root: string,
  stub: StubState,
): Promise<ProbeResult> {
  const workspace = await prepareWorkspace(root)
  const prompt =
    'Credential boundary probe. Use the shell tool to run the requested commands. Do not ask questions and do not stop early.'
  let bin = harness
  let args: readonly string[]
  const sourceEnv = baseEnv(root, {})
  const prepared = await prepareManagedExecutorEnv({
    harness,
    ...(harness === 'omp' ? { model: 'keel-probe/probe-model' } : {}),
    ...(harness === 'pi' ? { model: 'probe-model' } : {}),
    sourceEnv,
    rootBase: root,
    ...(harness === 'pi'
      ? {
          piModels: {
            providers: {
              'keel-probe': {
                baseUrl: `http://127.0.0.1:${stub.port}/v1`,
                api: 'openai-completions',
                apiKey: 'probe-key',
                models: [
                  {
                    id: 'probe-model',
                    name: 'probe-model',
                    contextWindow: 128000,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        }
      : {}),
    ...(harness === 'omp'
      ? {
          ompModels: [
            'providers:',
            '  keel-probe:',
            `    baseUrl: http://127.0.0.1:${stub.port}/v1`,
            '    api: openai-completions',
            '    apiKey: probe-key',
            '    models:',
            '      - id: probe-model',
            '        name: probe-model',
            '        contextWindow: 128000',
            '        maxTokens: 4096',
            '',
          ].join('\n'),
        }
      : {}),
    ...(harness === 'claude'
      ? {
          claudeSettings: {
            env: {
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.port}`,
              ANTHROPIC_API_KEY: 'probe-key',
            },
          },
        }
      : {}),
  })
  if (!prepared.ok) throw new Error(prepared.error.detail)
  const env = prepared.value.env

  if (harness === 'pi') {
    args = [
      '--print',
      '--mode',
      'json',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-mcp',
      '--no-approve',
      '--no-session',
      '--provider',
      'keel-probe',
      '--model',
      'probe-model',
      '--tools',
      'bash',
      '--system-prompt',
      prompt,
      '--',
      prompt,
    ]
  } else if (harness === 'omp') {
    args = [
      '-p',
      '--mode=json',
      '--model=keel-probe/probe-model',
      `--cwd=${workspace}`,
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--no-pty',
      '--no-session',
      '--no-title',
      '--tools=bash',
      '--approval-mode=yolo',
      `--system-prompt=${prompt}`,
      prompt,
    ]
  } else {
    bin = 'claude'
    args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--bare',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Bash',
      '--allowedTools',
      'Bash',
      '--model',
      'probe-model',
    ]
  }

  try {
    const outcome = await runProcess(bin, args, {
      cwd: workspace,
      env,
      timeoutMs: 180_000,
    })
    const observations = [...stub.results.values()].sort(
      (a, b) => COMMANDS.findIndex((c) => c.id === a.id) - COMMANDS.findIndex((c) => c.id === b.id),
    )
    return {
      harness,
      version: versionOf(harness),
      processExitCode: outcome.code,
      timedOut: outcome.timedOut,
      debugOutput: outcome.stderr.trim().slice(-4000),
      observations: verdicts(observations, prepared.value.home, prepared.value.tmpdir),
    }
  } finally {
    await prepared.value.dispose()
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp('/tmp/keel-jt02a-agent-')
  const runs: ProbeResult[] = []
  let passed = true
  for (const harness of ['pi', 'claude', 'omp'] as const) {
    const stub = await startStub()
    const harnessRoot = join(root, harness)
    await mkdir(harnessRoot, { recursive: true })
    try {
      const result = await probeHarness(harness, harnessRoot, stub)
      runs.push(result)
      const ok =
        !result.timedOut &&
        result.observations.length === COMMANDS.length &&
        result.observations.every((observation) =>
          observation.id === 'env'
            ? observation.verdict === 'sanitized'
            : observation.verdict === 'denied',
        )
      if (!ok) passed = false
      console.log(`${harness}: ${ok ? 'PASS' : 'FAIL'} (${result.version})`)
      if (!ok && result.debugOutput !== '') console.log(`  diagnostic: ${result.debugOutput}`)
      for (const observation of result.observations) {
        console.log(`  ${observation.id}: ${observation.verdict} ${observation.detail}`)
      }
    } finally {
      await stopStub(stub)
    }
  }

  const evidenceDir = join(
    process.cwd(),
    '.keel',
    'jt02a-agent',
    new Date().toISOString().replaceAll(':', '-'),
  )
  await mkdir(evidenceDir, { recursive: true })
  const evidencePath = join(evidenceDir, 'evidence.json')
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schema: 'jt02a-agent-negative/1',
        generated_at: new Date().toISOString(),
        platform: `${process.platform}/${process.arch}`,
        pass: passed,
        harnesses: runs.map(({ debugOutput: _debugOutput, ...result }) => result),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`evidence: ${evidencePath}`)
  if (!passed) process.exitCode = 1
}

await main()
