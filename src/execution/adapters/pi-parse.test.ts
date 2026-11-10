import { describe, expect, it } from 'vitest'
import { PiStreamParser, parsePiStream } from './pi-parse.js'

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

describe('parsePiStream —— 完整流', () => {
  it('会话头 id 可直接作为诊断句柄', () => {
    const parsed = parsePiStream(OK_STREAM)
    expect(parsed.sessionRef).toBe('0199a4c4-0000-7000-8000-000000000001')
    expect(parsed.sawAgentEnd).toBe(true)
    expect(parsed.sawAgentSettled).toBe(true)
    expect(parsed.aborted).toBe(false)
  })

  it('终态文本来自末条 assistant 消息，thinking block 计数不算文本', () => {
    const parsed = parsePiStream(OK_STREAM)
    expect(parsed.text).toBe('ok')
    expect(parsed.nonTextBlocks).toBe(1)
  })

  it('usage 取 completed message_end 的累加值，口径 estimated', () => {
    const parsed = parsePiStream(OK_STREAM)
    expect(parsed.usage.tokens_in).toBe(100)
    expect(parsed.usage.tokens_out).toBe(7)
    expect(parsed.usage.cost_usd).toBeCloseTo(0.002)
    expect(parsed.usage.cost_basis).toBe('estimated')
  })

  it('末条 assistant 消息为空文本 → text null（不拿中间叙述冒充）', () => {
    const parsed = parsePiStream(
      [
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"过程叙述"}],"stopReason":"toolUse"}}',
        '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}',
      ].join('\n'),
    )
    expect(parsed.text).toBeNull()
  })

  it('usage 从未上报 → 全 null + unavailable，不补 0', () => {
    const parsed = parsePiStream(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}\n',
    )
    expect(parsed.usage).toEqual({
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      cost_basis: 'unavailable',
    })
  })

  it('assistant stopReason=error 与 errorMessage 被保留', () => {
    const parsed = parsePiStream(
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"529 overloaded"}}\n',
    )
    expect(parsed.stopReason).toBe('error')
    expect(parsed.errorMessage).toBe('529 overloaded')
  })

  it('auto_retry_end 的 finalError 进入 errorMessage，并标记重试最终失败', () => {
    const parsed = parsePiStream(
      '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"terminated"}\n',
    )
    expect(parsed.errorMessage).toBe('terminated')
    expect(parsed.autoRetryPending).toBe(false)
    expect(parsed.autoRetryFailed).toBe(true)
  })

  it('auto_retry_start 到 auto_retry_end 之间是未结束重试', () => {
    const pending = new PiStreamParser(() => 0)
    pending.push('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}\n')
    expect(pending.end().autoRetryPending).toBe(true)

    const recovered = parsePiStream(
      [
        '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}',
        '{"type":"auto_retry_end","success":true,"attempt":2}',
      ].join('\n'),
    )
    expect(recovered.autoRetryPending).toBe(false)
    expect(recovered.autoRetryFailed).toBe(false)
  })

  it('非 JSON 行被收集而非丢弃', () => {
    const parsed = parsePiStream('Error: no model configured\n')
    expect(parsed.nonJsonLines).toEqual(['Error: no model configured'])
    expect(parsed.text).toBeNull()
  })

  it('agent_settled.aborted 暴露为 aborted', () => {
    const parsed = parsePiStream('{"type":"agent_settled","aborted":true}\n')
    expect(parsed.aborted).toBe(true)
    expect(parsed.sawAgentSettled).toBe(true)
  })

  it('agent_end 不等于最终 settled', () => {
    const parsed = parsePiStream('{"type":"agent_end","messages":[],"willRetry":true}\n')
    expect(parsed.sawAgentEnd).toBe(true)
    expect(parsed.sawAgentSettled).toBe(false)
  })

  it('没有 message_end 时用 agent_end.messages 兜底', () => {
    const parsed = parsePiStream(
      [
        '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"fallback"}],"stopReason":"stop","usage":{"input":5,"output":1}}]}',
        '{"type":"agent_settled","aborted":false}',
      ].join('\n'),
    )
    expect(parsed.text).toBe('fallback')
    expect(parsed.usage.tokens_in).toBe(5)
    expect(parsed.usage.tokens_out).toBe(1)
    expect(parsed.stopReason).toBe('stop')
  })

  it('user / system 消息不参与文本与 usage', () => {
    const parsed = parsePiStream(
      [
        '{"type":"message_end","message":{"role":"user","content":"hi"}}',
        '{"type":"message_end","message":{"role":"system","content":"sys"}}',
      ].join('\n'),
    )
    expect(parsed.text).toBeNull()
    expect(parsed.usage.tokens_in).toBeNull()
  })
})

describe('PiStreamParser —— 增量与多轮', () => {
  const multiTurn = [
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

  it('中间轮次叙述不当终答，usage 跨消息累加', () => {
    const parsed = parsePiStream(multiTurn)
    expect(parsed.text).toBe('终答')
    expect(parsed.usage.tokens_in).toBe(30)
    expect(parsed.usage.tokens_out).toBe(7)
    expect(parsed.usage.cost_usd).toBeCloseTo(0.004)
  })

  it('半行留在缓冲区，按 LF 切行（Unicode 行分隔符不是边界）', () => {
    const parser = new PiStreamParser(() => 0)
    expect(parser.push('{"type":"agent_start"}\n{"type":"tur')).toHaveLength(1)
    const events = parser.push('n_start"}\n')
    expect(events.map((e) => e.kind)).toEqual(['turn_start'])
    const parsed = parser.end()
    expect(parsed.sawAgentEnd).toBe(false)
  })

  it('CRLF 与任意分块位置都能还原同一条 JSON 记录', () => {
    const line =
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop","usage":{"input":3,"output":1}}}\r\n'
    const parser = new PiStreamParser(() => 0)
    expect(parser.push(line.slice(0, 17))).toEqual([])
    expect(parser.push(line.slice(17, 61))).toEqual([])
    expect(parser.push(line.slice(61))).toEqual([])
    const parsed = parser.end()
    expect(parsed.text).toBe('ok')
    expect(parsed.stopReason).toBe('stop')
    expect(parsed.usage.tokens_in).toBe(3)
    expect(parsed.usage.tokens_out).toBe(1)
  })

  it('进展事件覆盖工具执行与自动重试，纯成本通知不入流', () => {
    const parser = new PiStreamParser(() => 0)
    const events = parser.push(
      [
        '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{}}',
        '{"type":"tool_execution_update","toolCallId":"c1","toolName":"bash","args":{},"partialResult":{}}',
        '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}',
        '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}',
        '{"type":"compaction_start","reason":"threshold"}',
        '{"type":"queue_update","steering":[],"followUp":[]}',
        '',
      ].join('\n'),
    )
    expect(events.map((e) => e.kind)).toEqual([
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
      'auto_retry_start',
      'compaction_start',
    ])
  })

  it('tool_execution_start 未配对时暴露 pendingToolCalls', () => {
    const parsed = parsePiStream(
      [
        '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{}}',
        '{"type":"tool_execution_start","toolCallId":"c2","toolName":"read","args":{}}',
        '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}',
      ].join('\n'),
    )
    expect(parsed.pendingToolCalls).toBe(1)
  })

  it('中断时仍在飞的 usage 计入（无 message_end）', () => {
    const parser = new PiStreamParser(() => 0)
    parser.push(
      [
        '{"type":"message_start","message":{"role":"assistant","content":[]}}',
        '{"type":"message_update","usage":{"input":4,"output":1}}',
        '{"type":"message_update","usage":{"input":8,"output":2,"cost":{"total":0.005}}}',
      ].join('\n'),
    )
    const parsed = parser.end()
    expect(parsed.usage.tokens_in).toBe(8)
    expect(parsed.usage.tokens_out).toBe(2)
    expect(parsed.usage.cost_usd).toBeCloseTo(0.005)
  })

  it('message_end 到达后不重复计入 message_update 的累计值', () => {
    const parser = new PiStreamParser(() => 0)
    parser.push(
      [
        '{"type":"message_start","message":{"role":"assistant","content":[]}}',
        '{"type":"message_update","usage":{"input":8,"output":2,"cost":{"total":0.005}}}',
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop","usage":{"input":8,"output":2,"cost":{"total":0.005}}}}',
      ].join('\n'),
    )
    const parsed = parser.end()
    expect(parsed.usage.tokens_in).toBe(8)
    expect(parsed.usage.tokens_out).toBe(2)
    expect(parsed.usage.cost_usd).toBeCloseTo(0.005)
  })
})
