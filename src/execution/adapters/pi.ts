import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  InterruptReason,
  RunHandle,
  RunHooks,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import type { Usage } from '../../contracts/types.js'
import type { CapabilityId } from '../../shared/ids.js'
import { collectGitDiff, gitHeadSha } from './git-diff.js'
import { type PiProgressEvent, PiStreamParser } from './pi-parse.js'
import { tierOf } from './tier.js'

export const PI_CAPABILITIES: readonly CapabilityId[] = [
  'CAP-HEADLESS',
  'CAP-UNTRUSTED_WORKSPACE',
  'CAP-STREAM',
  'CAP-COST',
  'CAP-PERMISSION',
  'CAP-MODEL_OVERRIDE',
]

export const PI_BUILTIN_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'] as const
export const PI_SUBAGENT_TOOLS = ['Agent', 'get_subagent_result', 'steer_subagent'] as const

export interface PiOptions {
  readonly bin?: string
  readonly model?: string
  readonly provider?: string
  readonly thinking?: string
  readonly extensions?: readonly string[]
  readonly trustedTools?: readonly string[]
  readonly autoSubagents?: boolean
  readonly spawnFn?: typeof spawn
  readonly interruptKillTimeoutMs?: number
}

interface RunState {
  readonly handle: RunHandle
  readonly spec: RunSpec
  readonly model: string | undefined
  readonly baseSha: string | null
  promise: Promise<Result<RunResult>>
  aborted: boolean
  timeout: boolean
  proc: ChildProcess | null
}

export class PiAdapter implements HarnessAdapter {
  private readonly bin: string
  private readonly model: string | undefined
  private readonly opts: PiOptions
  private readonly runs = new Map<string, RunState>()
  private readonly byHandle = new WeakMap<RunHandle, RunState>()

  constructor(opts: PiOptions = {}) {
    this.bin = opts.bin ?? 'pi'
    this.model = opts.model
    const auto =
      opts.autoSubagents === false ||
      opts.extensions !== undefined ||
      opts.trustedTools !== undefined
        ? null
        : discoverPiSubagentsExtension()
    this.opts = {
      ...opts,
      extensions: opts.extensions ?? (auto === null ? [] : [auto]),
      trustedTools: opts.trustedTools ?? (auto === null ? [] : PI_SUBAGENT_TOOLS),
    }
  }

  describe(): HarnessDescriptor {
    const trusted = this.opts.trustedTools ?? []
    const toolInventory: string[] = [...PI_BUILTIN_TOOLS]
    for (const tool of trusted) if (!toolInventory.includes(tool)) toolInventory.push(tool)
    return {
      harness_id: 'pi',
      version: 'unknown',
      tier: tierOf(PI_CAPABILITIES),
      capabilities: PI_CAPABILITIES,
      tool_inventory: toolInventory,
      cost_basis: 'estimated',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec, hooks?: RunHooks): Promise<Result<RunHandle>> {
    const config = validatePiConfig(this.opts)
    if (!config.ok) return config

    if (spec.workspace.untrusted && !PI_CAPABILITIES.includes('CAP-UNTRUSTED_WORKSPACE')) {
      return err(
        makeError('CAPABILITY_UNSUPPORTED', 'workspace.untrusted 要求 CAP-UNTRUSTED_WORKSPACE'),
      )
    }
    if (spec.output_contract.mode === 'native') {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          'Pi 无 CAP-STRUCTURED_OUTPUT（help 无 schema 约束开关），请改用 output_contract.mode = post_validate',
        ),
      )
    }
    if (spec.permissions.mode === 'manual') {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          'Pi 在 headless 下没有逐次审批通道；manual 无法兑现，拒绝降级为自动执行。' +
            '请用 auto / accept_edits / deny_unlisted，并用 allowed_tools 收紧边界。',
        ),
      )
    }

    const tools = resolvePiTools(spec.permissions.allowed_tools, this.opts.trustedTools ?? [])
    if (!tools.ok) return tools

    const model = resolvePiModel(spec.model, this.model)
    if (!model.ok) return model

    if (this.opts.provider !== undefined && model.value === undefined) {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          'Pi 的 --provider 必须与 --model 一起使用；只设 provider 不指定模型会被 Pi 拒绝。',
        ),
      )
    }

    const thinking = resolvePiThinking(this.opts.thinking)
    if (!thinking.ok) return thinking

    const existing = this.runs.get(spec.idempotency_key)
    if (existing !== undefined) return ok(existing.handle)

    const head = await gitHeadSha(spec.workspace.path)
    const raced = this.runs.get(spec.idempotency_key)
    if (raced !== undefined) return ok(raced.handle)

    const handle: RunHandle = { run_id: spec.run.run_id, harness_id: 'pi' }
    const state: RunState = {
      handle,
      spec,
      model: model.value,
      baseSha: head.ok ? head.value : null,
      aborted: false,
      timeout: false,
      proc: null,
      promise: Promise.resolve(ok({} as RunResult)),
    }
    state.promise = this.exec(spec, state, [...tools.value], hooks)
    this.runs.set(spec.idempotency_key, state)
    this.byHandle.set(handle, state)
    return ok(handle)
  }

  async awaitResult(handle: RunHandle): Promise<Result<RunResult>> {
    const state = this.find(handle)
    if (state === undefined) {
      return err(makeError('NOT_FOUND', `未知 run ${handle.run_id}`))
    }
    return state.promise
  }

  async collectChanges(handle: RunHandle): Promise<Result<WorkspaceDiff>> {
    const state = this.find(handle)
    if (state === undefined) {
      return err(makeError('NOT_FOUND', `未知 run ${handle.run_id}`))
    }
    return collectGitDiff(state.spec.workspace.path, { since: state.baseSha })
  }

  async interrupt(handle: RunHandle, reason: InterruptReason): Promise<Result<void>> {
    const state = this.find(handle)
    if (state === undefined) {
      return err(makeError('NOT_FOUND', `未知 run ${handle.run_id}`))
    }
    state.aborted = true
    state.timeout = reason === 'timeout' || reason === 'stalled'
    const proc = state.proc
    if (proc === null || proc.pid === undefined) return ok(undefined)
    const group = -proc.pid
    try {
      process.kill(group, 'SIGTERM')
    } catch {
      return ok(undefined)
    }
    const killTimeout = this.opts.interruptKillTimeoutMs ?? 2000
    const timer = setTimeout(() => {
      try {
        process.kill(group, 'SIGKILL')
      } catch {
        return
      }
    }, killTimeout)
    timer.unref()
    return ok(undefined)
  }

  async dispose(handle: RunHandle): Promise<Result<DisposeReport>> {
    const state = this.find(handle)
    if (state !== undefined) {
      for (const [k, v] of this.runs) if (v === state) this.runs.delete(k)
    }
    return ok({
      session_ref_retained: false,
      workspace_cleaned: false,
    })
  }

  private find(handle: RunHandle): RunState | undefined {
    const exact = this.byHandle.get(handle)
    if (exact !== undefined) return exact
    let latest: RunState | undefined
    for (const v of this.runs.values()) if (v.handle.run_id === handle.run_id) latest = v
    return latest
  }

  private async exec(
    spec: RunSpec,
    state: RunState,
    tools: readonly string[],
    hooks?: RunHooks,
  ): Promise<Result<RunResult>> {
    const prompt = renderPrompt(spec)
    const argv = buildPiArgv(spec, {
      ...(state.model === undefined ? {} : { model: state.model }),
      ...(this.opts.provider === undefined ? {} : { provider: this.opts.provider }),
      ...(this.opts.thinking === undefined ? {} : { thinking: this.opts.thinking }),
      ...(this.opts.extensions === undefined ? {} : { extensions: this.opts.extensions }),
      tools,
      prompt,
    })

    const parser = new PiStreamParser()
    let lastMessageUpdateAt = Number.NEGATIVE_INFINITY
    let firstProgress = true
    let childPid: number | undefined
    let childStartedAt: string | null = null

    const emitProgress = (event: PiProgressEvent): void => {
      const sink = hooks?.onProgress
      if (sink === undefined) return
      if (event.kind === 'message_update') {
        if (event.at - lastMessageUpdateAt < MESSAGE_UPDATE_THROTTLE_MS) return
        lastMessageUpdateAt = event.at
      }
      const withProcess =
        firstProgress && childPid !== undefined
          ? {
              ...event,
              pid: childPid,
              pgid: childPid,
              ...(childStartedAt === null ? {} : { startedAt: childStartedAt }),
            }
          : event
      firstProgress = false
      try {
        sink(withProcess)
      } catch {
        return
      }
    }

    const proc = await run(
      this.bin,
      argv,
      spec.workspace.path,
      this.opts.spawnFn,
      (p) => {
        state.proc = p
        childPid = p.pid
        childStartedAt = new Date().toISOString()
      },
      (chunk) => {
        for (const event of parser.push(chunk)) emitProgress(event)
      },
    )

    state.proc = null
    const parsed = parser.end()

    if (state.aborted) {
      return ok({
        status: state.timeout ? 'TIMEOUT' : 'CANCELLED',
        text: null,
        proposals: [],
        usage: parsed.usage,
        session_ref: null,
      })
    }

    if (proc.code !== 0) {
      const detail = parsed.nonJsonLines.join(' ') || proc.stderr || `exit ${proc.code}`
      if (hasReportedUsage(parsed.usage)) {
        return ok({
          status: 'FAILED',
          text: parsed.text,
          proposals: [],
          usage: parsed.usage,
          session_ref: parsed.sessionRef,
        })
      }
      return err(makeError('HARNESS_UNAVAILABLE', `pi 退出码 ${proc.code}：${detail}`))
    }

    if (parsed.aborted) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          `pi 在未收到 interrupt 的情况下 agent_settled.aborted=true：${parsed.errorMessage ?? '无错误文本'}`,
        ),
      )
    }
    if (!parsed.sawAgentSettled) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          'pi 输出中没有最终 agent_settled：agent_end 之后仍可能有重试、压缩恢复或续跑',
        ),
      )
    }
    if (parsed.autoRetryPending) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          'pi 的自动重试尚未结束（auto_retry_start 后没有 auto_retry_end）',
        ),
      )
    }
    if (parsed.autoRetryFailed) {
      return err(
        makeError('PROTOCOL_ERROR', `pi 自动重试最终失败：${parsed.errorMessage ?? '无错误文本'}`),
      )
    }
    if (parsed.pendingToolCalls > 0) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          `pi 在 agent_settled 时仍有 ${parsed.pendingToolCalls} 个工具调用未结束`,
        ),
      )
    }
    if (parsed.stopReason !== 'stop') {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          `pi 末条 assistant stopReason=${parsed.stopReason ?? 'none'}（成功要求 stop）：` +
            `${parsed.errorMessage ?? (parsed.nonJsonLines.join(' ') || '无错误文本')}`,
        ),
      )
    }
    if (parsed.text === null) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          'pi 末条 assistant 消息没有文本（post_validate 需要非空 text）',
        ),
      )
    }

    return ok({
      status: 'SUCCEEDED',
      text: parsed.text,
      proposals: [],
      usage: parsed.usage,
      session_ref: parsed.sessionRef,
    })
  }
}

function invalidPiConfig<T>(detail: string): Result<T> {
  return err(makeError('CAPABILITY_UNSUPPORTED', detail))
}

function validatePiConfig(opts: PiOptions): Result<undefined> {
  if (opts.model !== undefined && opts.model.trim() === '') {
    return invalidPiConfig('PiAdapter 的 model 不能为空白；空白不等于未指定')
  }
  if (opts.provider !== undefined && opts.provider.trim() === '') {
    return invalidPiConfig('PiAdapter 的 provider 不能为空白')
  }
  if (opts.thinking !== undefined && opts.thinking.trim() === '') {
    return invalidPiConfig('PiAdapter 的 thinking 不能为空白；省略它表示不覆盖模型默认值')
  }
  const extensions = opts.extensions ?? []
  for (const extension of extensions) {
    if (extension.trim() === '') {
      return invalidPiConfig('PiAdapter 的 extensions 不能包含空白项')
    }
  }
  const trustedTools = opts.trustedTools ?? []
  for (const tool of trustedTools) {
    if (tool.trim() === '') {
      return invalidPiConfig('PiAdapter 的 trustedTools 不能包含空白项')
    }
  }
  if (trustedTools.length > 0 && extensions.length === 0) {
    return invalidPiConfig(
      'trustedTools 需要显式 extensions：没有 -e 加载的扩展不可能提供这些工具，' +
        '否则工具会在 Pi 里静默缺失',
    )
  }
  return ok(undefined)
}

function resolvePiModel(
  specModel: string | undefined,
  adapterModel: string | undefined,
): Result<string | undefined> {
  if (specModel !== undefined) {
    const trimmed = specModel.trim()
    if (trimmed === '') {
      return invalidPiConfig('spec.model 不能为空白；空白不等于未指定')
    }
    return ok(trimmed)
  }
  if (adapterModel === undefined) return ok(undefined)
  const trimmed = adapterModel.trim()
  if (trimmed === '') {
    return invalidPiConfig('PiAdapter 的 model 不能为空白；空白不等于未指定')
  }
  return ok(trimmed)
}

function resolvePiThinking(thinking: string | undefined): Result<string | undefined> {
  if (thinking === undefined) return ok(undefined)
  const trimmed = thinking.trim()
  if (trimmed === '') {
    return invalidPiConfig('thinking 不能为空白；省略它表示不覆盖模型默认值')
  }
  return ok(trimmed)
}

export function resolvePiTools(
  tools: readonly string[],
  trustedTools: readonly string[] = [],
): Result<readonly string[]> {
  const out: string[] = []
  for (const raw of tools) {
    const name = resolvePiToolName(raw, trustedTools)
    if (name === null) {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          `未知工具名 ${raw}：Pi 内置工具是 ${PI_BUILTIN_TOOLS.join(', ')}；` +
            '扩展工具必须由显式受信配置提供（构造参数 trustedTools / extensions）。' +
            '不会把它静默丢掉。',
        ),
      )
    }
    if (!out.includes(name)) out.push(name)
  }
  return ok(out)
}

function resolvePiToolName(raw: string, trustedTools: readonly string[]): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const builtin = PI_BUILTIN_TOOLS.find((name) => name === trimmed.toLowerCase())
  if (builtin !== undefined) return builtin
  const trusted = trustedTools.find((name) => name === trimmed)
  return trusted ?? null
}

export function discoverPiSubagentsExtension(env: NodeJS.ProcessEnv = process.env): string | null {
  const agentDir = env.PI_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const packageDir = join(agentDir, 'npm', 'node_modules', '@tintinweb', 'pi-subagents')
  for (const candidate of [
    join(packageDir, 'src', 'index.ts'),
    join(packageDir, 'dist', 'index.js'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function requirePiTools(tools: readonly string[], trustedTools: readonly string[]): string[] {
  const resolved = resolvePiTools(tools, trustedTools)
  if (!resolved.ok) throw new Error(resolved.error.detail)
  return [...resolved.value]
}

export interface PiArgvOpts {
  readonly model?: string
  readonly provider?: string
  readonly thinking?: string
  readonly prompt?: string
  readonly extensions?: readonly string[]
  readonly trustedTools?: readonly string[]
  readonly tools?: readonly string[]
}

export function buildPiArgv(spec: RunSpec, opts: PiArgvOpts = {}): string[] {
  if (opts.model !== undefined && opts.model.trim() === '') {
    throw new Error('model 不能为空白；空白不等于未指定')
  }
  if (opts.provider !== undefined && opts.provider.trim() === '') {
    throw new Error('provider 不能为空白')
  }
  if (opts.thinking !== undefined && opts.thinking.trim() === '') {
    throw new Error('thinking 不能为空白；省略它表示不覆盖模型默认值')
  }
  if ((opts.trustedTools?.length ?? 0) > 0 && (opts.extensions?.length ?? 0) === 0) {
    throw new Error('trustedTools 需要显式 extensions')
  }
  for (const extension of opts.extensions ?? []) {
    if (extension.trim() === '') throw new Error('extensions 不能包含空白项')
  }
  for (const tool of opts.trustedTools ?? []) {
    if (tool.trim() === '') throw new Error('trustedTools 不能包含空白项')
  }

  const argv = [
    '--print',
    '--mode',
    'json',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--no-approve',
  ]

  for (const extension of opts.extensions ?? []) argv.push('-e', extension)

  const tools =
    opts.tools ?? requirePiTools(spec.permissions.allowed_tools, opts.trustedTools ?? [])
  if (tools.length === 0) {
    argv.push('--no-tools')
  } else {
    argv.push('--tools', tools.join(','))
  }

  if (opts.model !== undefined) {
    argv.push('--model', opts.model.trim())
    if (opts.provider !== undefined) {
      argv.push('--provider', opts.provider.trim())
    }
  }

  if (opts.thinking !== undefined) {
    argv.push('--thinking', opts.thinking.trim())
  }

  argv.push('--', opts.prompt ?? '')
  return argv
}

const PI_PROMPT_PREFIX = '任务上下文如下：\n\n'

function renderPrompt(spec: RunSpec): string {
  return `${PI_PROMPT_PREFIX}${spec.context.sections.map((s) => s.content).join('\n\n')}`
}

const MESSAGE_UPDATE_THROTTLE_MS = 250

interface ProcResult {
  code: number
  stdout: string
  stderr: string
}

function hasReportedUsage(usage: Usage): boolean {
  return usage.tokens_in !== null || usage.tokens_out !== null || usage.cost_usd !== null
}

function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  spawnFn: typeof spawn = spawn,
  onSpawn?: (p: ChildProcess) => void,
  onChunk?: (chunk: string) => void,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const p = spawnFn(bin, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    onSpawn?.(p)
    let stdout = ''
    let stderr = ''
    p.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8')
      stdout += chunk
      onChunk?.(chunk)
    })
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    p.on('error', (e: Error) => resolve({ code: -1, stdout, stderr: e.message }))
    p.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export function requirePiBinary(bin = 'pi'): Result<void> {
  try {
    execFileSync(bin, ['--version'], { stdio: 'pipe' })
    return ok(undefined)
  } catch {
    return err(
      makeError(
        'HARNESS_UNAVAILABLE',
        `找不到可用的 \`${bin}\` CLI。缺它时每个 run 都会失败并重试到 T-031 升人工。` +
          '补法：安装 Pi coding agent（`pi` 在 PATH 上）。',
      ),
    )
  }
}
