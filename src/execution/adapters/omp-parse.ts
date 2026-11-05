/**
 * OMP `--mode=json` 事件流解析 —— 纯函数 + 有状态增量解析器。
 *
 * 事实来源：`research/omp-interface.md` §2（本机实测 omp v17.4.2）。
 *
 * 单独成文件是刻意的：解析是纯的（字符串 → 结构），可以用真实抓到的
 * 事件流样本单测，不需要起进程。真实集成测试只验证 argv 与进程交互。
 * 两者分开，各测各的。
 */

import type { ProgressEvent as RunProgressEvent } from '../../contracts/harness-adapter.js'
import type { Usage } from '../../contracts/types.js'

/** 实测到的事件类型（顶层） */
export type OmpEventType =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_end'
  | 'agent_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'advisor_cost_changed'

/**
 * 算作「Run 还在动」的事件。
 *
 * - `message_update` 的嵌套类型（thinking_* / toolcall_* / text_*）都算；
 * - 工具执行阶段没有文本，也必须算进展，否则长编译会被误判卡死；
 * - `advisor_cost_changed` 是纯成本通知，不证明模型在动。
 */
export type ProgressKind =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_update'
  | 'turn_end'
  | 'agent_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'

const PROGRESS_KINDS: ReadonlySet<string> = new Set<ProgressKind>([
  'session',
  'agent_start',
  'turn_start',
  'message_update',
  'turn_end',
  'agent_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
])

export interface ProgressEvent extends RunProgressEvent {
  readonly kind: ProgressKind
}

export interface ParsedRun {
  /** 首个 session 事件的 id —— resume 句柄 */
  readonly sessionRef: string | null
  /** 助手输出的纯文本（按 content block 拼接） */
  readonly text: string
  readonly usage: Usage
  /** 被忽略的非文本 content block 计数（thinking 等），用于诊断 */
  readonly nonTextBlocks: number
  /** 无法解析为 JSON 的行 —— 通常是 omp 的错误输出 */
  readonly nonJsonLines: readonly string[]
  readonly sawAgentEnd: boolean
}

interface OmpUsage {
  input?: number
  output?: number
  totalTokens?: number
  cost?: { total?: number }
}

interface ContentBlock {
  type?: string
  text?: string
}

interface OmpMessage {
  role?: string
  content?: ContentBlock[]
  usage?: OmpUsage
}

interface OmpEvent {
  type?: string
  id?: string
  message?: OmpMessage
  messages?: OmpMessage[]
}

/**
 * 有状态增量解析器。
 *
 * 只消费完整行；半行留在缓冲区，等下一个 chunk。非 JSON 行继续进
 * `nonJsonLines`，不会因为流式化丢失错误信息。
 */
export class OmpStreamParser {
  private buffer = ''
  private sessionRef: string | null = null
  private text = ''
  private nonTextBlocks = 0
  private sawAgentEnd = false
  private readonly nonJsonLines: string[] = []
  private usage: OmpUsage = {}

  /**
   * @param now 单调时钟。控制面注入；默认 `performance.now()`（同进程单调）。
   *            parser 不读系统墙钟 —— 墙钟跳变不得影响 liveness。
   */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** 消费一个 chunk，返回其中完整行产生的进展事件 */
  push(chunk: string): ProgressEvent[] {
    this.buffer += chunk
    const events: ProgressEvent[] = []

    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)

      const kind = this.consume(line)
      if (kind === null) continue
      events.push({
        kind,
        at: this.now(),
        ...(this.sessionRef === null ? {} : { sessionRef: this.sessionRef }),
      })
    }

    return events
  }

  /** 冲刷残留行，返回与 `parseOmpStream(完整 stdout)` 等价的最终结果 */
  end(): ParsedRun {
    if (this.buffer.trim() !== '') this.consume(this.buffer)
    this.buffer = ''

    return {
      sessionRef: this.sessionRef,
      text: this.text.trim(),
      usage: toUsage(this.usage),
      nonTextBlocks: this.nonTextBlocks,
      nonJsonLines: this.nonJsonLines,
      sawAgentEnd: this.sawAgentEnd,
    }
  }

  /** 解析一行；返回进展类型，或 null（非 JSON / 非进展事件） */
  private consume(raw: string): ProgressKind | null {
    const line = raw.trim()
    if (line === '') return null
    if (!line.startsWith('{')) {
      // omp 的错误信息走这里（如 "Error: Session ... not found."）
      this.nonJsonLines.push(line)
      return null
    }

    let e: OmpEvent
    try {
      e = JSON.parse(line) as OmpEvent
    } catch {
      this.nonJsonLines.push(line)
      return null
    }

    const type = e.type

    if (type === 'session') {
      if (typeof e.id === 'string') this.sessionRef = e.id
      return 'session'
    }

    if (type === 'agent_end') {
      this.sawAgentEnd = true
      for (const m of e.messages ?? []) {
        if (m.role !== 'assistant') continue
        const r = collectText(m.content ?? [])
        this.text += r.text
        this.nonTextBlocks += r.skipped
        if (m.usage !== undefined) this.usage = m.usage
      }
      return 'agent_end'
    }

    // turn_end / message_end 也带 usage，取最后一次见到的
    if ((type === 'turn_end' || type === 'message_end') && e.message?.usage !== undefined) {
      this.usage = e.message.usage
    }

    if (type !== undefined && PROGRESS_KINDS.has(type)) return type as ProgressKind
    return null
  }
}

/**
 * 解析完整的 NDJSON 输出。
 *
 * ⚠️ 调用方必须传入**完整**的 stdout。
 * 提前关闭管道会让 omp 收到 SIGPIPE 而在写会话文件前死掉 ——
 * 于是后续 --resume 报 not found。见 research/omp-interface.md §1。
 */
export function parseOmpStream(stdout: string): ParsedRun {
  const parser = new OmpStreamParser(() => 0)
  parser.push(stdout)
  return parser.end()
}

/**
 * 遍历全部 content block 并按 type 分派。
 *
 * ⚠️ **不能假设 `content[0].type === 'text'`** ——
 * 实测 deepseek 返回 `[{type:'thinking'}, {type:'text'}]`。
 * 第一版解析脚本正是因为这个假设而崩溃。
 */
function collectText(blocks: readonly ContentBlock[]): { text: string; skipped: number } {
  let text = ''
  let skipped = 0
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text
    } else {
      skipped++
    }
  }
  return { text, skipped }
}

function toUsage(u: OmpUsage): Usage {
  return {
    tokens_in: typeof u.input === 'number' ? u.input : null,
    tokens_out: typeof u.output === 'number' ? u.output : null,
    cost_usd: typeof u.cost?.total === 'number' ? u.cost.total : null,
    // OMP 的文档未说明 cost 是 billed 还是 estimated。
    // 在确认前按 estimated 上报 —— 与 Claude Code 一致，宁可保守。
    // docs/08-cross-cutting.md §3.1：只有 billed 才可用于对外计费。
    cost_basis: typeof u.cost?.total === 'number' ? 'estimated' : 'unavailable',
  }
}
