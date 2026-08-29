/**
 * OmpAdapter —— Oh My Pi 的 HarnessAdapter 实现（L2）。
 *
 * 事实来源：`research/omp-interface.md`（本机实测 omp v17.4.2 + deepseek-v4-flash）。
 * 本文件中每一个 argv 参数都有实测依据，不是从文档推断的。
 */

import { type ChildProcess, spawn } from 'node:child_process'
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
import { collectGitDiff } from './git-diff.js'
import { parseOmpStream } from './omp-parse.js'
import { tierOf } from './tier.js'

/** 缺省模型。CLI / env 未指定时必须仍是这个值，避免五连基线漂移。 */
export const DEFAULT_OMP_MODEL = 'deepseek-v4-flash'

/** 实测确认的能力集（research/omp-interface.md §7） */
export const OMP_CAPABILITIES: readonly CapabilityId[] = [
  'CAP-HEADLESS',
  'CAP-STREAM',
  'CAP-RESUME',
  'CAP-COST',
  'CAP-PERMISSION',
  'CAP-MODEL_OVERRIDE',
  'CAP-UNTRUSTED_WORKSPACE',
  // 刻意不含 CAP-STRUCTURED_OUTPUT —— omp --help 中没有 schema 约束类开关。
  // 于是 Proposal 必须走 post_validate 路径。
]

export interface OmpOptions {
  /** 可执行文件，默认 'omp' */
  readonly bin?: string
  /** 默认模型 */
  readonly model?: string
  /** 覆盖 spawn，供测试注入 */
  readonly spawnFn?: typeof spawn
  /** interrupt 后 SIGTERM 到 SIGKILL 的兜底毫秒；默认 2000。测试注入短值 */
  readonly interruptKillTimeoutMs?: number
}

interface RunState {
  readonly handle: RunHandle
  readonly spec: RunSpec
  promise: Promise<Result<RunResult>>
  aborted: boolean
  /** interrupt reason='timeout' 时置 —— awaitResult 分流 TIMEOUT vs CANCELLED(方案 B) */
  timeout: boolean
  /** 已 spawn 的子进程 —— interrupt 需要它做优雅终止 */
  proc: ChildProcess | null
}

export class OmpAdapter implements HarnessAdapter {
  private readonly bin: string
  private readonly model: string
  /**
   * 幂等映射：idempotency_key → 运行状态。
   *
   * ⚠️ 进程内映射，v0.1 单进程够用。
   * 多进程部署时须改为查 run 表（UNIQUE(idempotency_key) 已在 DB 层）。
   */
  private readonly runs = new Map<string, RunState>()

  constructor(private readonly opts: OmpOptions = {}) {
    this.bin = opts.bin ?? 'omp'
    this.model = opts.model ?? DEFAULT_OMP_MODEL
  }

  describe(): HarnessDescriptor {
    return {
      harness_id: 'omp',
      version: 'unknown', // 可由 CAP-PROBE 在运行时校正；v0.1 不探测
      tier: tierOf(OMP_CAPABILITIES),
      capabilities: OMP_CAPABILITIES,
      // OMP 的 usage.cost.total 存在，但文档未说明口径。
      // 在确认前按 estimated —— 只有 billed 才可用于对外计费。
      cost_basis: 'estimated',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    // 契约要求：untrusted 而未声明该能力 → 拒绝，**不得降级执行**
    if (spec.workspace.untrusted && !OMP_CAPABILITIES.includes('CAP-UNTRUSTED_WORKSPACE')) {
      return err(
        makeError('CAPABILITY_UNSUPPORTED', 'workspace.untrusted 要求 CAP-UNTRUSTED_WORKSPACE'),
      )
    }
    // OMP 无原生结构化输出，native 模式不可用
    if (spec.output_contract.mode === 'native') {
      return err(
        makeError(
          'CAPABILITY_UNSUPPORTED',
          'OMP 无 CAP-STRUCTURED_OUTPUT，请改用 output_contract.mode = post_validate',
        ),
      )
    }

    // 幂等：相同 key 的重复调用返回已有句柄，不启动第二个进程
    const existing = this.runs.get(spec.idempotency_key)
    if (existing !== undefined) return ok(existing.handle)

    const handle: RunHandle = { run_id: spec.run.run_id, harness_id: 'omp' }
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
    // 标记 + 杀子进程组(R7,issue #23):
    //   spawn 用 detached:true 建了进程组,pid 是组 leader —— kill(-pid) 整组终止,
    //   防 omp 派生的子进程逃逸。
    //   SIGTERM 先给优雅退出机会;兜底超时后 SIGKILL(进程可能无视 TERM 不退出)。
    state.aborted = true
    // 方案 B:reason='timeout'(R-009 墙钟超时)与人工取消(R-010)分流 ——
    // awaitResult 依 timeout 返回 TIMEOUT 而非 CANCELLED,使 T-030 可重试
    state.timeout = _reason === 'timeout'
    const proc = state.proc
    if (proc === null || proc.pid === undefined) return ok(undefined)
    const group = -proc.pid
    try {
      process.kill(group, 'SIGTERM')
    } catch {
      // 进程已退出:无需兜底
      return ok(undefined)
    }
    const killTimeout = this.opts.interruptKillTimeoutMs ?? 2000
    const timer = setTimeout(() => {
      try {
        process.kill(group, 'SIGKILL')
      } catch {
        // 已退出 —— 兜底完成
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
      // OMP 的会话由它自己持久化到 ~/.omp/agent/sessions/，
      // dispose 只清本地引用，--resume 之后仍然可用
      session_ref_retained: true,
      workspace_cleaned: false,
    })
  }

  private find(handle: RunHandle): RunState | undefined {
    for (const v of this.runs.values()) if (v.handle.run_id === handle.run_id) return v
    return undefined
  }

  private async exec(spec: RunSpec, state: RunState): Promise<Result<RunResult>> {
    const argv = buildArgv(spec, this.model)
    const prompt = renderPrompt(spec)

    const proc = await run(
      this.bin,
      [...argv, prompt],
      spec.workspace.path,
      this.opts.spawnFn,
      // 子进程创建后立即持有引用 —— interrupt 需要 kill 它
      (p) => {
        state.proc = p
      },
    )

    // 进程已结束 —— 引用不再有意义
    state.proc = null

    if (state.aborted) {
      // 方案 B:timeout(R-009,墙钟超时→TIMEOUT→可重试)vs 人工取消(R-010→CANCELLED)
      return ok({
        status: state.timeout ? 'TIMEOUT' : 'CANCELLED',
        text: null,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      })
    }

    const parsed = parseOmpStream(proc.stdout)

    if (proc.code !== 0) {
      const detail = parsed.nonJsonLines.join(' ') || proc.stderr || `exit ${proc.code}`
      return err(makeError('HARNESS_UNAVAILABLE', `omp 退出码 ${proc.code}：${detail}`))
    }
    if (!parsed.sawAgentEnd) {
      return err(makeError('PROTOCOL_ERROR', 'omp 输出中没有 agent_end 事件'))
    }

    return ok({
      status: 'SUCCEEDED',
      // post_validate 模式的输入：Adapter 把文本原样带出，
      // 由调用方提取结构化提案
      text: parsed.text,
      // Proposal 的构造属 SessionManager；Adapter 不做解释
      proposals: [],
      usage: parsed.usage,
      session_ref: parsed.sessionRef,
    })
  }
}

/**
 * RunSpec → omp argv。
 *
 * 纯函数，可单测而无需起进程。每一项的依据见 research/omp-interface.md。
 */
export function buildArgv(spec: RunSpec, defaultModel: string): string[] {
  const argv = ['-p', '--mode=json', '--model', defaultModel]

  argv.push('--cwd', spec.workspace.path)

  // CAP-UNTRUSTED_WORKSPACE 的落点：等价于 Claude Code 的 --bare。
  // 不加这些，目标仓库里的扩展 / skills / rules 会被加载并执行。
  if (spec.workspace.untrusted) {
    argv.push('--no-extensions', '--no-skills', '--no-rules')
  }

  if (spec.permissions.allowed_tools.length === 0) {
    argv.push('--no-tools')
  } else {
    argv.push(`--tools=${spec.permissions.allowed_tools.join(',')}`)
  }

  argv.push(`--approval-mode=${approvalMode(spec.permissions.mode)}`)

  if (spec.limits.wall_clock_s > 0) {
    argv.push(`--max-time=${spec.limits.wall_clock_s}`)
  }

  return argv
}

/** Keel 的权限模式 → omp 的 approval-mode（always-ask | write | yolo） */
function approvalMode(mode: RunSpec['permissions']['mode']): string {
  switch (mode) {
    case 'manual':
      return 'always-ask'
    case 'accept_edits':
      return 'write'
    case 'auto':
      return 'yolo'
    case 'deny_unlisted':
      // omp 无完全对应项；用 always-ask 配合 --tools 白名单最接近
      return 'always-ask'
  }
}

/** Context → 提示词。v0.1 简单拼接；富格式属 ContextBuilder 的职责 */
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
 *
 * ⚠️ 这里不做流式提前返回是刻意的：
 * 提前关闭管道会让 omp 收到 SIGPIPE，在写会话文件前死掉 ——
 * 于是后续 --resume 报 "Session not found"。实测踩到过两次。
 * 见 research/omp-interface.md §1。
 *
 * stdin 显式关闭，否则 omp 可能等待输入而挂起（实测超时过一次）。
 *
 * `onSpawn` 在子进程创建后立即回调，把 `ChildProcess` 交给调用方 ——
 * 中断需要它来 kill(见 interrupt)。
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
      // R7(issue #23):独立进程组 —— interrupt 可用 kill(-pid) 整组终止,
      // 防 omp 派生的子进程逃逸
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
