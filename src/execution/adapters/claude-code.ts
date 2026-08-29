/**
 * ClaudeCodeAdapter —— Claude Code 官方 CLI 的 HarnessAdapter 实现（L2）。
 *
 * 事实来源：`.trellis/tasks/08-29-second-harness/research/claude-code-interface.md`
 * （本机 claude 2.1.222 `--help`）。argv 以 help 为准；事件字段本会话未抓到
 * live stdout，parser 缺字段则 null。
 *
 * 本任务不接线 `--json-schema`，不声明 CAP-STRUCTURED_OUTPUT。
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  InterruptReason,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import type { CapabilityId } from '../../shared/ids.js'
import { parseClaudeStream } from './claude-code-parse.js'
import { collectGitDiff } from './git-diff.js'
import { tierOf } from './tier.js'

/**
 * 本任务声明的能力。STRUCTURED_OUTPUT / INTERRUPT / PROBE 刻意不含：
 * json-schema 未接线；中断靠进程组 SIGTERM，不宣称 SDK interrupt；
 * system/init.capabilities[] 本机未验证。
 */
export const CLAUDE_CAPABILITIES: readonly CapabilityId[] = [
  'CAP-HEADLESS',
  'CAP-UNTRUSTED_WORKSPACE',
  'CAP-STREAM',
  'CAP-RESUME',
  'CAP-COST',
  'CAP-PERMISSION',
]

export interface ClaudeCodeOptions {
  /** 可执行文件，默认 'claude' */
  readonly bin?: string
  /**
   * 仅当调用方显式指定时传入 argv `--model`。
   * 缺省**不传** —— 禁止把 OMP 缺省 `deepseek-v4-flash` 塞给 claude。
   */
  readonly model?: string
  readonly spawnFn?: typeof spawn
  readonly interruptKillTimeoutMs?: number
}

export interface ClaudeArgvOpts {
  readonly model?: string
  /** 有上一轮 session_ref 时加 `--resume`。RunSpec 无此字段，由调用方传入。 */
  readonly sessionRef?: string
}

interface RunState {
  readonly handle: RunHandle
  readonly spec: RunSpec
  promise: Promise<Result<RunResult>>
  aborted: boolean
  timeout: boolean
  proc: ChildProcess | null
}

export class ClaudeCodeAdapter implements HarnessAdapter {
  private readonly bin: string
  private readonly model: string | undefined
  private readonly runs = new Map<string, RunState>()

  constructor(private readonly opts: ClaudeCodeOptions = {}) {
    this.bin = opts.bin ?? 'claude'
    this.model = opts.model
  }

  describe(): HarnessDescriptor {
    return {
      harness_id: 'claude',
      version: 'unknown',
      tier: tierOf(CLAUDE_CAPABILITIES),
      capabilities: CLAUDE_CAPABILITIES,
      cost_basis: 'estimated',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    if (spec.workspace.untrusted && !CLAUDE_CAPABILITIES.includes('CAP-UNTRUSTED_WORKSPACE')) {
      return err(
        makeError('CAPABILITY_UNSUPPORTED', 'workspace.untrusted 要求 CAP-UNTRUSTED_WORKSPACE'),
      )
    }
    if (spec.output_contract.mode === 'native') {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          'Claude Code Adapter 本任务未接线 --json-schema，请改用 output_contract.mode = post_validate',
        ),
      )
    }

    const existing = this.runs.get(spec.idempotency_key)
    if (existing !== undefined) return ok(existing.handle)

    const handle: RunHandle = { run_id: spec.run.run_id, harness_id: 'claude' }
    const state: RunState = {
      handle,
      spec,
      aborted: false,
      timeout: false,
      proc: null,
      promise: Promise.resolve(ok({} as RunResult)),
    }
    state.promise = this.exec(spec, state)
    this.runs.set(spec.idempotency_key, state)
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
    return collectGitDiff(state.spec.workspace.path)
  }

  async interrupt(handle: RunHandle, _reason: InterruptReason): Promise<Result<void>> {
    const state = this.find(handle)
    if (state === undefined) {
      return err(makeError('NOT_FOUND', `未知 run ${handle.run_id}`))
    }
    state.aborted = true
    state.timeout = _reason === 'timeout'
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
        // 已退出
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
      session_ref_retained: true,
      workspace_cleaned: false,
    })
  }

  private find(handle: RunHandle): RunState | undefined {
    for (const v of this.runs.values()) if (v.handle.run_id === handle.run_id) return v
    return undefined
  }

  private async exec(spec: RunSpec, state: RunState): Promise<Result<RunResult>> {
    const argvOpts: ClaudeArgvOpts = this.model === undefined ? {} : { model: this.model }
    const argv = buildClaudeArgv(spec, argvOpts)
    const prompt = renderPrompt(spec)

    const proc = await run(
      this.bin,
      [...argv, prompt],
      spec.workspace.path,
      this.opts.spawnFn,
      (p) => {
        state.proc = p
      },
    )

    state.proc = null

    if (state.aborted) {
      return ok({
        status: state.timeout ? 'TIMEOUT' : 'CANCELLED',
        text: null,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      })
    }

    const parsed = parseClaudeStream(proc.stdout)

    if (proc.code !== 0) {
      const detail = parsed.nonJsonLines.join(' ') || proc.stderr || `exit ${proc.code}`
      return err(makeError('HARNESS_UNAVAILABLE', `claude 退出码 ${proc.code}：${detail}`))
    }
    if (parsed.isError) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          `claude result.is_error：${parsed.text ?? (parsed.nonJsonLines.join(' ') || '无文本')}`,
        ),
      )
    }
    if (!parsed.sawResult || parsed.text === null) {
      return err(
        makeError(
          'PROTOCOL_ERROR',
          'claude 输出中没有 type=result 或文本为空（post_validate 需要非空 text）',
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

/**
 * `--bare` 不读 OAuth / 钥匙串。untrusted 路径缺 ANTHROPIC_API_KEY 时的文案。
 * CLI 与 preflight 共用，避免两处漂移。
 */
export function anthropicKeyMissingDetail(): string {
  return [
    'Claude Code 在 --bare 下不读 OAuth 与系统钥匙串，只认 ANTHROPIC_API_KEY。',
    'Keel 指向不可信 worktree 时必须 --bare，不能为了本机 OAuth 能跑而省略。',
    '设置：export ANTHROPIC_API_KEY=...',
  ].join(' ')
}

export function requireAnthropicApiKeyForBare(): Result<void> {
  const key = process.env.ANTHROPIC_API_KEY
  if (key === undefined || key.trim() === '') {
    return err(makeError('AUTH_FAILED', anthropicKeyMissingDetail()))
  }
  return ok(undefined)
}

/**
 * `claude --version` 失败 → HARNESS_UNAVAILABLE。
 * 必须在进 loop / ingest **之前**调用：缺二进制若拖到 spawn，错误可重试，
 * 会一路 T-030 落到 T-031，与 Policy 闸门同终态。
 */
export function requireClaudeBinary(bin = 'claude'): Result<void> {
  try {
    execFileSync(bin, ['--version'], { stdio: 'pipe' })
    return ok(undefined)
  } catch {
    return err(
      makeError(
        'HARNESS_UNAVAILABLE',
        `找不到可用的 \`${bin}\` CLI。缺它时每个 run 都会失败并重试到 T-031 升人工，` +
          '与 Policy 闸门同终态。补法：安装 Claude Code CLI（`claude` 在 PATH 上）。',
      ),
    )
  }
}

/**
 * CLI / run-issue 在副作用之前调用。
 * 先 key（AUTH_FAILED，现有单测不依赖本机有 claude）再二进制。
 */
export function requireClaudeReady(bin = 'claude'): Result<void> {
  const key = requireAnthropicApiKeyForBare()
  if (!key.ok) return key
  return requireClaudeBinary(bin)
}

/**
 * RunSpec → claude argv。纯函数，可单测而无需起进程。
 *
 * 工作目录靠 spawn `cwd`，help 没有 `--cwd`。prompt 由 exec 放 argv 末位。
 */
export function buildClaudeArgv(spec: RunSpec, opts: ClaudeArgvOpts = {}): string[] {
  const argv = ['-p', '--output-format', 'stream-json']

  // S1 / S3：untrusted 必须 --bare。省略 = 目标仓 .claude/settings.json 可无提示执行。
  if (spec.workspace.untrusted) {
    argv.push('--bare')
  }

  argv.push('--permission-mode', permissionMode(spec.permissions.mode))

  if (spec.permissions.allowed_tools.length === 0) {
    // help：Use "" to disable all tools
    argv.push('--tools', '')
  } else if (spec.permissions.mode === 'deny_unlisted') {
    argv.push('--allowedTools', spec.permissions.allowed_tools.join(','))
  } else {
    argv.push('--tools', spec.permissions.allowed_tools.join(','))
  }

  if (opts.sessionRef !== undefined && opts.sessionRef !== '') {
    argv.push('--resume', opts.sessionRef)
  }

  if (opts.model !== undefined && opts.model !== '') {
    argv.push('--model', opts.model)
  }

  if (spec.limits.budget_usd !== null) {
    argv.push('--max-budget-usd', String(spec.limits.budget_usd))
  }

  return argv
}

function permissionMode(mode: RunSpec['permissions']['mode']): string {
  switch (mode) {
    case 'manual':
      return 'manual'
    case 'accept_edits':
      return 'acceptEdits'
    case 'auto':
      return 'dontAsk'
    case 'deny_unlisted':
      return 'manual'
  }
}

function renderPrompt(spec: RunSpec): string {
  return spec.context.sections.map((s) => s.content).join('\n\n')
}

interface ProcResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 执行子进程并**完整收集 stdout**。
 * 提前关管道会 SIGPIPE，会话可能没落盘（OMP 实测课，Claude 同样适用）。
 * stdin ignore：否则 claude 可能等输入挂起。
 */
function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  spawnFn: typeof spawn = spawn,
  onSpawn?: (p: ChildProcess) => void,
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
      stdout += d.toString('utf8')
    })
    p.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    p.on('error', (e: Error) => resolve({ code: -1, stdout, stderr: e.message }))
    p.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
