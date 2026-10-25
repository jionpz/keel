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
  /**
   * prompt 必须**紧跟 `-p`**。2.1.300 起把 prompt 放 argv 末位会报
   * `Input must be provided either through stdin or as a prompt argument`。
   */
  readonly prompt?: string
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
  /** handle 对象身份 → state：多轮同 run_id 时区分「哪一轮」 */
  private readonly byHandle = new WeakMap<RunHandle, RunState>()

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

  /**
   * 定位 handle 对应的 state。
   *
   * RunHandle 只有 `run_id`，而 R-007 的回灌重试发生在**同一个 Run 内**：
   * `HarnessSessionManager.advance` 每轮都用同一 `run.run_id`、只把幂等键加上
   * `#turn<N>`。旧的「命中 run_id 第一个就返回」会让第 2 轮起的 `awaitResult`
   * 拿到第 1 轮那个**已结束**的 promise（实测：第 2 轮 12ms 就"完成"，真实进程
   * 还在后台跑），`interrupt` 也会打到陈旧 state 上打空 —— 墙钟因此形同虚设。
   *
   * 两步：调用方把 `startRun` 返回的 handle 原样传回来时按**对象身份**命中；
   * 传的是同形副本时（`SessionManager.interrupt` 就是这么构造的）退化为
   * 「该 run_id 最近的那个」—— 轮次串行，最近即当前轮。
   */
  private find(handle: RunHandle): RunState | undefined {
    const exact = this.byHandle.get(handle)
    if (exact !== undefined) return exact
    let latest: RunState | undefined
    for (const v of this.runs.values()) if (v.handle.run_id === handle.run_id) latest = v
    return latest
  }

  private async exec(spec: RunSpec, state: RunState): Promise<Result<RunResult>> {
    const prompt = renderPrompt(spec)
    const argvOpts: ClaudeArgvOpts = {
      ...(this.model === undefined ? {} : { model: this.model }),
      prompt,
    }
    const argv = buildClaudeArgv(spec, argvOpts)

    const proc = await run(this.bin, argv, spec.workspace.path, this.opts.spawnFn, (p) => {
      state.proc = p
    })

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
 * 认证探测结果：true=已登录，false=未登录，null=无法判定（缺二进制 / 超时 /
 * 输出不可解析）。null 必须**不**当作未登录 —— 否则缺 claude 时会误报 AUTH_FAILED，
 * 把「装没装」和「登没登」两个问题混成一个。
 */
export type ClaudeAuthProbe = (bin: string) => boolean | null

/** 已就绪的环境变量凭据名（只判断存在，不读取/转发值）。 */
export function envCredentialName(): 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | undefined {
  const key = process.env.ANTHROPIC_API_KEY
  if (key !== undefined && key.trim() !== '') return 'ANTHROPIC_API_KEY'
  const token = process.env.ANTHROPIC_AUTH_TOKEN
  if (token !== undefined && token.trim() !== '') return 'ANTHROPIC_AUTH_TOKEN'
  return undefined
}

/**
 * 读本地登录状态（零网络）。`--bare` 跳的是 hooks / LSP / 插件同步与
 * OAuth·钥匙串读取，**不影响** `~/.claude/settings.json` 里的网关 env，
 * 因此本机配置了网关 token 时 `auth status` 会如实报 loggedIn:true。
 */
export function probeClaudeAuth(bin = 'claude'): boolean | null {
  try {
    const out = execFileSync(bin, ['auth', 'status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      encoding: 'utf8',
    })
    const parsed = JSON.parse(out) as { loggedIn?: unknown }
    return parsed.loggedIn === true
  } catch {
    return null
  }
}

/**
 * `--bare` 不读 OAuth / 钥匙串，但**接受**三种凭据：环境变量 API key、
 * 环境变量 auth token、或 claude 自身配置里的登录态。CLI 与 preflight 共用。
 */
export function claudeAuthMissingDetail(): string {
  return [
    'Claude Code 在 --bare 下不读 OAuth 与系统钥匙串，但接受三种凭据：',
    '(1) 环境变量 ANTHROPIC_API_KEY；',
    '(2) 环境变量 ANTHROPIC_AUTH_TOKEN（网关场景）；',
    '(3) claude 自身配置已登录（`claude auth status` 报 loggedIn:true，',
    '    例如 ~/.claude/settings.json 的 env 里配了网关 BASE_URL + token）。',
    'Keel 指向不可信 worktree 时必须 --bare，不能为了本机 OAuth 能跑而省略；',
    'Keel 不读取也不转发任何 token 值。',
  ].join(' ')
}

export function requireClaudeAuth(
  bin = 'claude',
  probe: ClaudeAuthProbe = probeClaudeAuth,
): Result<void> {
  if (envCredentialName() !== undefined) return ok(undefined)
  const loggedIn = probe(bin)
  if (loggedIn === false) {
    return err(makeError('AUTH_FAILED', claudeAuthMissingDetail()))
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
 * 先认证（AUTH_FAILED）再二进制（HARNESS_UNAVAILABLE）：
 * 探测不可判定时认证放行，由二进制检查给出准确归类。
 */
export function requireClaudeReady(
  bin = 'claude',
  probe: ClaudeAuthProbe = probeClaudeAuth,
): Result<void> {
  const auth = requireClaudeAuth(bin, probe)
  if (!auth.ok) return auth
  return requireClaudeBinary(bin)
}

/**
 * RunSpec → claude argv。纯函数，可单测而无需起进程。
 *
 * 工作目录靠 spawn `cwd`，help 没有 `--cwd`。prompt 由 exec 放 argv 末位。
 */
export function buildClaudeArgv(spec: RunSpec, opts: ClaudeArgvOpts = {}): string[] {
  // prompt 紧跟 -p；`--verbose` 是 2.1.300 起 `--print` + `stream-json` 的硬要求
  // （报错原文：`--output-format=stream-json requires --verbose`）。
  const argv = ['-p', opts.prompt ?? '', '--output-format', 'stream-json', '--verbose']

  // S1 / S3：untrusted 必须 --bare。省略 = 目标仓 .claude/settings.json 可无提示执行。
  if (spec.workspace.untrusted) {
    argv.push('--bare')
  }

  argv.push('--permission-mode', permissionMode(spec.permissions.mode))

  const tools = spec.permissions.allowed_tools.map(claudeToolName)
  if (tools.length === 0) {
    // help：Use "" to disable all tools
    argv.push('--tools', '')
  } else if (spec.permissions.mode === 'deny_unlisted') {
    argv.push('--allowedTools', tools.join(','))
  } else {
    argv.push('--tools', tools.join(','))
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

/**
 * Keel 内部工具名 → Claude Code 真实工具名。
 *
 * 2.1.300 的可用工具是 `Bash` / `Edit` / `Read` —— **`Write` 已不存在**
 * （实测 `--tools Write` 得到空工具列表，且不报错，静默降级）。
 * 因此 `write` 映射到 `Edit`；新建文件的路径本版本未验证，不宣称支持。
 */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  read: 'Read',
  write: 'Edit',
  edit: 'Edit',
  bash: 'Bash',
}

function claudeToolName(tool: string): string {
  return CLAUDE_TOOL_NAMES[tool.toLowerCase()] ?? tool
}

function permissionMode(mode: RunSpec['permissions']['mode']): string {
  switch (mode) {
    case 'manual':
      return 'manual'
    case 'accept_edits':
      return 'acceptEdits'
    case 'auto':
      // `dontAsk` 在 2.1.300 下**拒绝** Edit（实测：Permission to use Edit has
      // been denied because Claude Code is running in don't ask mode），而 headless
      // 无人可问。`acceptEdits` 才是「不打断、允许落盘」的正确映射；只读阶段
      // 的 --tools 里没有 Edit，因此不会因此多出写权限。
      return 'acceptEdits'
    case 'deny_unlisted':
      return 'manual'
  }
}

function renderPrompt(spec: RunSpec): string {
  return spec.context.sections.map((s) => s.content).join('\n\n')
}

/**
 * 宿主的 Claude Code 运行时变量 —— 只在「Keel 本身跑在某个 Claude Code 会话里」
 * 时才存在。子 claude 继承它们会**冒充**自己是宿主托管的子会话：
 *
 * - `PROVIDER_MANAGED_BY_HOST` + `MODEL_CATALOG=0` → claude 认为 provider 由宿主
 *   托管，拒绝 settings 里配的模型（实测：`[claude-code:unrecognized_model]`，
 *   退出码 1，同一个 argv 在干净环境下退出码 0）；
 * - `MESSAGING_SOCKET` / `MESSAGING_TOKEN` → 子进程可以反向连回父会话的 IPC。
 *
 * 凭据（`ANTHROPIC_*`）与其余环境**原样保留**：它们才是用户真正的配置。
 * 用显式黑名单而不是白名单，避免误删 `CLAUDE_CONFIG_DIR` 这类合法配置与
 * 代理 / 证书 / `PATH` 等运行前提。
 */
const HOST_RUNTIME_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_MODEL_CATALOG',
  'CLAUDE_CODE_MODEL_CAPABILITIES',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
]

export function sanitizeClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (HOST_RUNTIME_ENV.includes(key)) continue
    out[key] = value
  }
  return out
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
 * env 剔除宿主运行时变量，见 `sanitizeClaudeEnv`。
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
      env: sanitizeClaudeEnv(process.env),
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
