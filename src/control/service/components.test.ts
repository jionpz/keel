import { beforeEach, describe, expect, it, vi } from 'vitest'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedInference } from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { createStopToken } from '../../ingress/poller.js'
import type { ManagedTicketWorker } from '../managed/ticket-runtime.js'
import { createManagedComponent } from './components.js'

const ticks = vi.hoisted(() => ({
  decision: vi.fn<() => Promise<Result<unknown>>>(),
  investigation: vi.fn<() => Promise<Result<unknown>>>(),
  ticket: vi.fn<() => Promise<Result<unknown>>>(),
  workflow: vi.fn<() => Promise<Result<unknown>>>(),
}))
vi.mock('../managed/ticket-tianwen.js', () => ({ tickPendingTicketTianwen: ticks.decision }))
vi.mock('../managed/runtime.js', () => ({ tickManaged: ticks.investigation }))
vi.mock('../managed/ticket-runtime.js', () => ({ tickManagedTicket: ticks.ticket }))
vi.mock('../managed/workflow-runtime.js', () => ({ tickManagedWorkflow: ticks.workflow }))

const unavailable = async () => ({
  ...err(makeError('HARNESS_UNAVAILABLE', 'fixture')),
  usage: ZERO_USAGE,
})
const worker = {
  harness: 'pi',
  toolInventory: [],
  run: unavailable,
  decide: unavailable,
} as ManagedTicketWorker
const infer = unavailable as ManagedInference
const context = {
  stop: createStopToken(),
  now: () => new Date().toISOString(),
  instanceId: 'fixture',
  heartbeat: async () => undefined,
}

beforeEach(() => {
  for (const tick of Object.values(ticks)) tick.mockReset().mockResolvedValue(ok(null))
})

describe('managed 调度', () => {
  it('决策冲突不阻断 ticket/workflow，且直到故障队列恢复都保持降级', async () => {
    ticks.decision.mockResolvedValue(err(makeError('CONFLICT', 'wrong decision identity')))
    ticks.ticket.mockResolvedValue(ok({ taskId: 't', stage: 'execute', status: 'READY' }))
    ticks.workflow.mockResolvedValue(ok({ workflowId: 'w', status: 'READY', action: 'sync' }))
    const component = createManagedComponent({ worker, infer })
    const first = await component.tick?.(context)
    expect(first).toMatchObject({
      worked: true,
      reasonCode: 'CONFLICT',
      checkpoint: { phase: 'ticket' },
    })
    const second = await component.tick?.(context)
    expect(second).toMatchObject({
      worked: true,
      reasonCode: 'CONFLICT',
      checkpoint: { phase: 'workflow' },
    })
    ticks.decision.mockResolvedValue(ok(null))
    expect(await component.tick?.(context)).toMatchObject({ reasonCode: null })
  })

  it('持续有决策工作也会轮到调查、ticket 和 workflow', async () => {
    ticks.decision.mockResolvedValue(ok({ taskId: 'd', requestId: 'r', status: 'READY' }))
    ticks.investigation.mockResolvedValue(ok({ taskId: 'i', status: 'READY' }))
    ticks.ticket.mockResolvedValue(ok({ taskId: 't', stage: 'execute', status: 'READY' }))
    ticks.workflow.mockResolvedValue(ok({ workflowId: 'w', status: 'READY', action: 'sync' }))
    const component = createManagedComponent({ worker, infer })
    const phases = []
    for (let i = 0; i < 5; i++) phases.push((await component.tick?.(context))?.checkpoint?.phase)
    expect(phases).toEqual(['decision', 'investigation', 'ticket', 'workflow', 'decision'])
  })
})
