/**
 * OMP `--mode=json` 事件流解析 —— 纯函数。
 *
 * 事实来源：`research/omp-interface.md` §2（本机实测 omp v17.4.2）。
 *
 * 单独成文件是刻意的：解析是纯的（字符串 → 结构），可以用真实抓到的
 * 事件流样本单测，不需要起进程。真实集成测试只验证 argv 与进程交互。
 * 两者分开，各测各的。
 */

import type { Usage } from '../../contracts/types.js'

/** 实测到的事件类型 */
export type OmpEventType =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_end'
  | 'agent_end'

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

/**
 * 解析完整的 NDJSON 输出。
 *
 * ⚠️ 调用方必须传入**完整**的 stdout。
 * 提前关闭管道会让 omp 收到 SIGPIPE 而在写会话文件前死掉 ——
 * 于是后续 --resume 报 not found。见 research/omp-interface.md §1。
 */
export function parseOmpStream(stdout: string): ParsedRun {
  let sessionRef: string | null = null
  let text = ''
  let nonTextBlocks = 0
  let sawAgentEnd = false
  const nonJsonLines: string[] = []
  let usage: OmpUsage = {}

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('{')) {
      // omp 的错误信息走这里（如 "Error: Session ... not found."）
      nonJsonLines.push(line)
      continue
    }

    let e: { type?: string; id?: string; message?: OmpMessage; messages?: OmpMessage[] }
    try {
      e = JSON.parse(line)
    } catch {
      nonJsonLines.push(line)
      continue
    }

    if (e.type === 'session' && typeof e.id === 'string') {
      sessionRef = e.id
      continue
    }

    if (e.type === 'agent_end') {
      sawAgentEnd = true
      for (const m of e.messages ?? []) {
        if (m.role !== 'assistant') continue
        const r = collectText(m.content ?? [])
        text += r.text
        nonTextBlocks += r.skipped
        if (m.usage !== undefined) usage = m.usage
      }
      continue
    }

    // turn_end / message_end 也带 usage，取最后一次见到的
    if ((e.type === 'turn_end' || e.type === 'message_end') && e.message?.usage !== undefined) {
      usage = e.message.usage
    }
  }

  return {
    sessionRef,
    text: text.trim(),
    usage: toUsage(usage),
    nonTextBlocks,
    nonJsonLines,
    sawAgentEnd,
  }
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
