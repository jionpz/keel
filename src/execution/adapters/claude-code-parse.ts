/**
 * Claude Code `--output-format stream-json` 解析 —— 纯函数。
 *
 * 事实来源：`research/claude-code-interface.md` + 归档
 * `harness-interfaces.md` §1.3（官方文档形状）。
 *
 * 本会话**未抓到**本机 stdout。字段以文档为准：缺则 null，不编造
 * session id / 金额 / token。fixture 标了 `.docs.jsonl`，不是 live capture。
 *
 * ⚠️ 调用方必须传入**完整** stdout。提前关管道会 SIGPIPE，
 * 会话文件可能没落盘（OMP 实测课，对 Claude 同样适用）。
 */

import type { Usage } from '../../contracts/types.js'

export interface ParsedClaudeRun {
  /** `type=result` 的 `session_id`；缺则 null，不从别处编造 */
  readonly sessionRef: string | null
  /** `type=result` 的 `result` 文本；缺或非字符串为 null */
  readonly text: string | null
  readonly usage: Usage
  readonly nonJsonLines: readonly string[]
  /** 是否见到过 `type=result` 行 */
  readonly sawResult: boolean
  /** 文档：失败也可能打在 stdout 的 result 上 */
  readonly isError: boolean
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
}

interface ClaudeResultEvent {
  type?: string
  result?: unknown
  session_id?: unknown
  total_cost_usd?: unknown
  usage?: ClaudeUsage
  is_error?: unknown
}

/**
 * 解析完整的 stream-json / NDJSON 输出。
 *
 * 文本、费用、session 只认文档所述末行（或流中）`type=result`。
 * 中间 `assistant` / `stream_event` 的增量**不**当作终态文本 ——
 * 否则会把 partial 当成 post_validate 输入。
 */
export function parseClaudeStream(stdout: string): ParsedClaudeRun {
  let sessionRef: string | null = null
  let text: string | null = null
  let sawResult = false
  let isError = false
  const nonJsonLines: string[] = []
  let costUsd: number | null = null
  let tokensIn: number | null = null
  let tokensOut: number | null = null

  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (!line.startsWith('{')) {
      nonJsonLines.push(line)
      continue
    }

    let e: ClaudeResultEvent
    try {
      e = JSON.parse(line) as ClaudeResultEvent
    } catch {
      nonJsonLines.push(line)
      continue
    }

    if (e.type !== 'result') continue

    sawResult = true
    isError = e.is_error === true

    if (typeof e.session_id === 'string' && e.session_id !== '') {
      sessionRef = e.session_id
    } else {
      sessionRef = null
    }

    if (typeof e.result === 'string') {
      const trimmed = e.result.trim()
      text = trimmed === '' ? null : trimmed
    } else {
      text = null
    }

    if (typeof e.total_cost_usd === 'number') {
      costUsd = e.total_cost_usd
    } else {
      costUsd = null
    }

    tokensIn = typeof e.usage?.input_tokens === 'number' ? e.usage.input_tokens : null
    tokensOut = typeof e.usage?.output_tokens === 'number' ? e.usage.output_tokens : null
  }

  return {
    sessionRef,
    text,
    usage: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      // 文档明确 total_cost_usd 是 client-side estimate。
      // 没有数字时诚实报 unavailable，不用 0 冒充。
      cost_basis: costUsd === null ? 'unavailable' : 'estimated',
    },
    nonJsonLines,
    sawResult,
    isError,
  }
}
