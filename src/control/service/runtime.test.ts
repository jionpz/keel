import { describe, expect, it } from 'vitest'
import { createStopToken, type StopToken } from '../../ingress/poller.js'
import type { ServiceHealthRecord } from './health.js'
import {
  runService,
  type ServiceComponent,
  type ServiceComponentContext,
  type ServiceSignalSource,
} from './runtime.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSignals implements ServiceSignalSource {
  private readonly handlers = new Map<'SIGTERM' | 'SIGINT', () => void>()

  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void {
    this.handlers.set(signal, handler)
  }

  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal)
  }

  emit(signal: 'SIGTERM' | 'SIGINT'): void {
    this.handlers.get(signal)?.()
  }

  get listenerCount(): number {
    return this.handlers.size
  }
}

function recordingHealth(): {
  readonly records: ServiceHealthRecord[]
  readonly record: (record: ServiceHealthRecord) => Promise<void>
} {
  const records: ServiceHealthRecord[] = []
  return {
    records,
    record: async (record) => {
      records.push(record)
    },
  }
}

function tickComponent(
  name: ServiceComponent['name'],
  tick: (context: ServiceComponentContext) => Promise<{ worked: boolean }>,
): ServiceComponent {
  return {
    name,
    intervalMs: 1,
    tick,
  }
}

describe('runService', () => {
  it('一个组件失败只降级自己，其他组件继续运行并能在停止后收尾', async () => {
    const signals = new FakeSignals()
    const stop = createStopToken()
    const health = recordingHealth()
    let outboxTicks = 0

    const managed = tickComponent('managed', async () => {
      throw Object.assign(new Error('provider timeout'), { kind: 'TIMEOUT' })
    })
    const outbox = tickComponent('outbox', async () => {
      outboxTicks += 1
      if (outboxTicks >= 2) stop.request()
      return { worked: true }
    })

    await runService({
      components: [managed, outbox],
      signals,
      externalStop: stop,
      recordHealth: health.record,
      heartbeatMs: 2,
      backoffBaseMs: 2,
      backoffMaxMs: 8,
    })

    expect(outboxTicks).toBeGreaterThanOrEqual(2)
    expect(
      health.records.some(
        (record) =>
          record.component === 'managed' &&
          record.status === 'DEGRADED' &&
          record.reasonCode === 'TIMEOUT',
      ),
    ).toBe(true)
    expect(
      health.records.some((record) => record.component === 'outbox' && record.status === 'RUNNING'),
    ).toBe(true)
    expect(signals.listenerCount).toBe(0)
    expect(health.records.at(-1)?.status).toBe('STOPPED')
    expect(health.records.at(-1)?.component).toBe('service')
  })

  it('失败组件按指数退避重试，恢复后写回 RUNNING', async () => {
    const stop = createStopToken()
    const health = recordingHealth()
    const logs: Record<string, unknown>[] = []
    let attempts = 0
    let stopperTicks = 0

    const flaky = tickComponent('managed', async () => {
      attempts += 1
      if (attempts <= 3) {
        throw Object.assign(new Error('not yet'), { kind: 'COMPONENT_ERROR' })
      }
      stop.request()
      return { worked: true }
    })
    const stopper = tickComponent('outbox', async () => {
      stopperTicks += 1
      if (attempts >= 4 && stopperTicks >= 1) stop.request()
      return { worked: false }
    })

    await runService({
      components: [flaky, stopper],
      signals: new FakeSignals(),
      externalStop: stop,
      recordHealth: health.record,
      onLog: (line) => logs.push(line),
      heartbeatMs: 1,
      backoffBaseMs: 2,
      backoffMaxMs: 8,
    })

    const retries = logs
      .filter((line) => line.event === 'component_error' && line.component === 'managed')
      .map((line) => Number(line.retry_in_ms))
    expect(retries.slice(0, 3)).toEqual([2, 4, 8])
    expect(
      health.records.some(
        (record) =>
          record.component === 'managed' &&
          record.status === 'RUNNING' &&
          record.lastSuccessAt !== null,
      ),
    ).toBe(true)
    expect(attempts).toBeGreaterThanOrEqual(4)
  })

  it('SIGTERM 后不再启动新 tick，正在执行的 tick 收尾后才停止', async () => {
    const signals = new FakeSignals()
    const health = recordingHealth()
    let ticks = 0
    let releaseTick: (() => void) | undefined
    const tickGate = new Promise<void>((resolve) => {
      releaseTick = resolve
    })

    const component = tickComponent('managed', async () => {
      ticks += 1
      await tickGate
      return { worked: true }
    })

    const running = runService({
      components: [component],
      signals,
      recordHealth: health.record,
      heartbeatMs: 2,
      backoffBaseMs: 2,
      backoffMaxMs: 8,
    })

    await sleep(15)
    signals.emit('SIGTERM')
    releaseTick?.()
    await running

    expect(ticks).toBe(1)
    expect(health.records.at(-1)?.status).toBe('STOPPED')
  })

  it('service 自身周期心跳覆盖长任务，不会因组件执行超过 stale 阈值而失联', async () => {
    const stop = createStopToken()
    const health = recordingHealth()
    const component = tickComponent('managed', async () => {
      await sleep(25)
      stop.request()
      return { worked: true }
    })

    await runService({
      components: [component],
      signals: new FakeSignals(),
      externalStop: stop,
      recordHealth: health.record,
      heartbeatMs: 5,
      backoffBaseMs: 5,
      backoffMaxMs: 5,
    })

    const serviceRunning = health.records.filter(
      (record) => record.component === 'service' && record.status === 'RUNNING',
    )
    expect(serviceRunning.length).toBeGreaterThan(1)
    expect(serviceRunning.every((record) => record.checkpoint !== undefined)).toBe(true)
  })

  it('停止令牌在启动前已请求时不会执行组件', async () => {
    const stop: StopToken = createStopToken()
    stop.request()
    const health = recordingHealth()
    let ticks = 0

    await runService({
      components: [
        tickComponent('managed', async () => {
          ticks += 1
          return { worked: true }
        }),
      ],
      signals: new FakeSignals(),
      externalStop: stop,
      recordHealth: health.record,
    })

    expect(ticks).toBe(0)
    expect(health.records[0]?.status).toBe('STARTING')
    expect(health.records.at(-1)?.status).toBe('STOPPED')
  })
})
