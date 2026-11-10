import type { ProgressEvent as RunProgressEvent } from '../../contracts/harness-adapter.js'
import type { Usage } from '../../contracts/types.js'

export type PiProgressKind =
  | 'session'
  | 'agent_start'
  | 'turn_start'
  | 'message_update'
  | 'turn_end'
  | 'agent_end'
  | 'agent_settled'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end'
  | 'auto_retry_start'
  | 'auto_retry_end'
  | 'compaction_start'
  | 'compaction_end'

const PROGRESS_KINDS: ReadonlySet<string> = new Set<PiProgressKind>([
  'session',
  'agent_start',
  'turn_start',
  'message_update',
  'turn_end',
  'agent_end',
  'agent_settled',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'auto_retry_start',
  'auto_retry_end',
  'compaction_start',
  'compaction_end',
])

export interface PiProgressEvent extends RunProgressEvent {
  readonly kind: PiProgressKind
}

export interface ParsedPiRun {
  readonly sessionRef: string | null
  readonly text: string | null
  readonly usage: Usage
  readonly nonTextBlocks: number
  readonly nonJsonLines: readonly string[]
  readonly sawAgentEnd: boolean
  readonly sawAgentSettled: boolean
  readonly aborted: boolean
  readonly stopReason: string | null
  readonly errorMessage: string | null
  readonly pendingToolCalls: number
  readonly autoRetryPending: boolean
  readonly autoRetryFailed: boolean
}

interface PiUsage {
  input?: number
  output?: number
  cost?: { total?: number }
}

interface PiContentBlock {
  type?: string
  text?: string
}

interface PiMessage {
  role?: string
  content?: string | readonly PiContentBlock[]
  usage?: PiUsage | null
  stopReason?: string
  errorMessage?: string
}

interface PiEvent {
  type?: string
  id?: string
  message?: PiMessage
  messages?: readonly PiMessage[]
  usage?: PiUsage
  aborted?: boolean
  success?: boolean
  finalError?: string
}

interface UsageTotals {
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number | null
}

function addUsage(totals: UsageTotals, usage: PiUsage | null | undefined): void {
  if (usage === null || usage === undefined) return
  if (typeof usage.input === 'number') totals.tokensIn = (totals.tokensIn ?? 0) + usage.input
  if (typeof usage.output === 'number') totals.tokensOut = (totals.tokensOut ?? 0) + usage.output
  if (typeof usage.cost?.total === 'number') {
    totals.costUsd = (totals.costUsd ?? 0) + usage.cost.total
  }
}

function toUsage(totals: UsageTotals): Usage {
  return {
    tokens_in: totals.tokensIn,
    tokens_out: totals.tokensOut,
    cost_usd: totals.costUsd,
    cost_basis: totals.costUsd === null ? 'unavailable' : 'estimated',
  }
}

function collectText(content: PiMessage['content']): { text: string; nonText: number } {
  if (typeof content === 'string') return { text: content, nonText: 0 }
  if (!Array.isArray(content)) return { text: '', nonText: 0 }
  let text = ''
  let nonText = 0
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    } else {
      nonText++
    }
  }
  return { text, nonText }
}

export class PiStreamParser {
  private buffer = ''
  private sessionRef: string | null = null
  private lastText: string | null = null
  private nonTextBlocks = 0
  private sawAgentEnd = false
  private sawAgentSettled = false
  private aborted = false
  private stopReason: string | null = null
  private errorMessage: string | null = null
  private readonly nonJsonLines: string[] = []
  private readonly totals: UsageTotals = { tokensIn: null, tokensOut: null, costUsd: null }
  private inFlight = false
  private inFlightUsage: PiUsage | null = null
  private sawAssistantMessageEnd = false
  private pendingToolCalls = 0
  private autoRetryPending = false
  private autoRetryFailed = false

  constructor(private readonly now: () => number = () => performance.now()) {}

  push(chunk: string): PiProgressEvent[] {
    this.buffer += chunk
    const events: PiProgressEvent[] = []

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

  end(): ParsedPiRun {
    if (this.buffer.trim() !== '') this.consume(this.buffer)
    this.buffer = ''

    if (this.inFlight && this.inFlightUsage !== null) {
      addUsage(this.totals, this.inFlightUsage)
      this.inFlightUsage = null
    }

    return {
      sessionRef: this.sessionRef,
      text: this.lastText,
      usage: toUsage(this.totals),
      nonTextBlocks: this.nonTextBlocks,
      nonJsonLines: this.nonJsonLines,
      sawAgentEnd: this.sawAgentEnd,
      sawAgentSettled: this.sawAgentSettled,
      aborted: this.aborted,
      stopReason: this.stopReason,
      errorMessage: this.errorMessage,
      pendingToolCalls: this.pendingToolCalls,
      autoRetryPending: this.autoRetryPending,
      autoRetryFailed: this.autoRetryFailed,
    }
  }

  private consume(raw: string): PiProgressKind | null {
    const line = raw.trim()
    if (line === '') return null
    if (!line.startsWith('{')) {
      this.nonJsonLines.push(line)
      return null
    }

    let e: PiEvent
    try {
      e = JSON.parse(line) as PiEvent
    } catch {
      this.nonJsonLines.push(line)
      return null
    }

    const type = e.type

    if (type === 'session') {
      if (typeof e.id === 'string' && e.id !== '') this.sessionRef = e.id
      return 'session'
    }

    if (type === 'message_start') {
      if (e.message?.role === 'assistant') {
        this.inFlight = true
        this.inFlightUsage = null
      }
      return null
    }

    if (type === 'message_update') {
      if (this.inFlight && e.usage !== undefined) this.inFlightUsage = e.usage
      return 'message_update'
    }

    if (type === 'message_end') {
      const message = e.message
      if (message?.role === 'assistant') {
        this.finishAssistant(message)
        this.inFlight = false
        this.inFlightUsage = null
      }
      return null
    }

    if (type === 'agent_end') {
      this.sawAgentEnd = true
      if (!this.sawAssistantMessageEnd) this.absorbAgentEndMessages(e.messages ?? [])
      return 'agent_end'
    }

    if (type === 'agent_settled') {
      this.sawAgentSettled = true
      if (e.aborted === true) this.aborted = true
      return 'agent_settled'
    }

    if (type === 'tool_execution_start') {
      this.pendingToolCalls++
      return 'tool_execution_start'
    }

    if (type === 'tool_execution_end') {
      if (this.pendingToolCalls > 0) this.pendingToolCalls--
      return 'tool_execution_end'
    }

    if (type === 'auto_retry_start') {
      this.autoRetryPending = true
      this.autoRetryFailed = false
      return 'auto_retry_start'
    }

    if (type === 'auto_retry_end') {
      this.autoRetryPending = false
      if (e.success === false) {
        this.autoRetryFailed = true
        if (typeof e.finalError === 'string' && e.finalError !== '') {
          this.errorMessage = e.finalError
        }
      } else {
        this.autoRetryFailed = false
      }
      return 'auto_retry_end'
    }

    if (type !== undefined && PROGRESS_KINDS.has(type)) return type as PiProgressKind
    return null
  }

  private finishAssistant(message: PiMessage): void {
    this.sawAssistantMessageEnd = true
    if (typeof message.stopReason === 'string') this.stopReason = message.stopReason
    if (
      message.stopReason === 'error' &&
      typeof message.errorMessage === 'string' &&
      message.errorMessage !== ''
    ) {
      this.errorMessage = message.errorMessage
    }
    if (message.stopReason === 'stop') this.autoRetryFailed = false
    const collected = collectText(message.content)
    this.nonTextBlocks += collected.nonText
    const text = collected.text.trim()
    this.lastText = text === '' ? null : text
    addUsage(this.totals, message.usage)
  }

  private absorbAgentEndMessages(messages: readonly PiMessage[]): void {
    const assistants = messages.filter((m) => m.role === 'assistant')
    const last = assistants[assistants.length - 1]
    if (last === undefined) return
    for (const m of assistants.slice(0, -1)) addUsage(this.totals, m.usage)
    this.finishAssistant(last)
    this.inFlight = false
    this.inFlightUsage = null
  }
}

export function parsePiStream(stdout: string): ParsedPiRun {
  const parser = new PiStreamParser(() => 0)
  parser.push(stdout)
  return parser.end()
}
