/**
 * 统一服务运行器。
 *
 * 每个角色一个独立 promise；角色异常只降级自己并按指数退避重启，不拖垮
 * 其他角色。SIGTERM / SIGINT 只停止“下一轮认领”：当前 tick 或长驻扫描
 * 自然收尾后再退出，因此不会在模型调用或外部动作中途强杀。
 */

import { randomUUID } from 'node:crypto'
import type { KeelError } from '../../contracts/errors.js'
import { createStopToken, interruptibleSleep, type StopToken } from '../../ingress/poller.js'
import {
  recordServiceHealth,
  type ServiceCheckpoint,
  type ServiceComponentName,
  type ServiceHealthRecord,
  type ServiceHealthStatus,
} from './health.js'

export interface ServiceTickResult {
  readonly worked: boolean
  readonly reasonCode?: string | null
  readonly detail?: string | null
  readonly checkpoint?: ServiceCheckpoint
}

export interface ServiceComponentContext {
  readonly stop: StopToken
  readonly now: () => string
  readonly instanceId: string
  heartbeat(checkpoint?: ServiceCheckpoint): Promise<void>
}

export interface ServiceComponent {
  readonly name: ServiceComponentName
  /** tick 模式两次空闲轮询之间的等待；常驻 run 模式忽略 */
  readonly intervalMs: number
  readonly tick?: (context: ServiceComponentContext) => Promise<ServiceTickResult>
  readonly run?: (context: ServiceComponentContext) => Promise<void>
}

export interface ServiceSignalSource {
  on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
  off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void
}

const processSignals: ServiceSignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler)
  },
  off: (signal, handler) => {
    process.off(signal, handler)
  },
}

export interface RunServiceOptions {
  readonly components: readonly ServiceComponent[]
  readonly signals?: ServiceSignalSource
  readonly now?: () => string
  readonly instanceId?: string
  readonly pid?: number
  readonly heartbeatMs?: number
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
  readonly externalStop?: StopToken
  readonly onLog?: (line: Record<string, unknown>) => void
  readonly onHealthError?: (error: unknown) => void
  /** 测试注入；生产默认写 `worker_health`。 */
  readonly recordHealth?: (record: ServiceHealthRecord) => Promise<void>
}

interface ComponentState {
  failures: number
  lastHeartbeatAt: number
  lastSuccessAt: string | null
  checkpoint: ServiceCheckpoint
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function clipped(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}…[truncated]`
}

function errorDetail(error: unknown): string {
  const raw =
    typeof error === 'object' &&
    error !== null &&
    'detail' in error &&
    typeof (error as { detail?: unknown }).detail === 'string'
      ? String((error as { detail: string }).detail)
      : error instanceof Error
        ? error.message
        : String(error)
  return clipped(raw.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://***'))
}

export function serviceReasonCode(error: unknown): string {
  const kind =
    typeof error === 'object' &&
    error !== null &&
    'kind' in error &&
    typeof (error as { kind?: unknown }).kind === 'string'
      ? String((error as KeelError).kind)
      : null
  if (kind !== null) return kind
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : null
  if (
    code !== null &&
    ['57P01', '57P02', '57P03', '08000', '08001', '08003', '08006', 'ECONNREFUSED'].includes(code)
  )
    return 'DB_UNAVAILABLE'
  if (code === 'ETIMEDOUT' || (error instanceof Error && error.name === 'TimeoutError'))
    return 'TIMEOUT'
  return 'COMPONENT_ERROR'
}

function validComponent(component: ServiceComponent): void {
  if ((component.tick === undefined) === (component.run === undefined))
    throw new Error(`服务组件 ${component.name} 必须且只能提供 tick 或 run`)
  if (!Number.isSafeInteger(component.intervalMs) || component.intervalMs <= 0)
    throw new Error(`服务组件 ${component.name} 的 intervalMs 必须是正整数`)
}

function backoffMs(failures: number, base: number, max: number): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(max, base * 2 ** Math.min(exponent, 20))
}

/**
 * 启动全部组件，直到收到停止信号。
 *
 * 返回值只在所有组件都已收尾后产生；调用方可以据此关闭连接池和释放实例锁。
 */
export async function runService(options: RunServiceOptions): Promise<void> {
  for (const component of options.components) validComponent(component)
  if (
    new Set(options.components.map((component) => component.name)).size !==
    options.components.length
  )
    throw new Error('服务组件名称不能重复')

  const now = options.now ?? (() => new Date().toISOString())
  const instanceId = options.instanceId ?? randomUUID()
  const pid = options.pid ?? process.pid
  const heartbeatMs = options.heartbeatMs ?? 10_000
  const backoffBaseMs = options.backoffBaseMs ?? 1_000
  const backoffMaxMs = options.backoffMaxMs ?? 60_000
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0)
    throw new Error('heartbeatMs 必须是正整数')
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs <= 0)
    throw new Error('backoffBaseMs 必须是正整数')
  if (!Number.isSafeInteger(backoffMaxMs) || backoffMaxMs < backoffBaseMs)
    throw new Error('backoffMaxMs 必须是不小于 backoffBaseMs 的正整数')

  const signals = options.signals ?? processSignals
  const stop = options.externalStop ?? createStopToken()
  const onLog = options.onLog ?? ((line) => console.log(JSON.stringify(line)))
  const persistHealth = options.recordHealth ?? recordServiceHealth
  const onHealthError =
    options.onHealthError ??
    ((error: unknown) => console.warn('[service] health write failed', error))
  const startedAt = now()
  const componentStartedAt = new Map<ServiceComponentName, string>()

  const write = (
    component: ServiceComponentName,
    status: ServiceHealthStatus,
    input: {
      reasonCode?: string | null
      detail?: string | null
      checkpoint?: ServiceCheckpoint
      lastSuccessAt?: string | null
    } = {},
  ): Promise<boolean> =>
    persistHealth({
      component,
      status,
      now: now(),
      instanceId,
      pid,
      reasonCode: input.reasonCode ?? null,
      detail: input.detail ?? null,
      checkpoint: input.checkpoint ?? {},
      startedAt: componentStartedAt.get(component) ?? null,
      lastSuccessAt: input.lastSuccessAt ?? null,
    }).then(
      () => true,
      (error: unknown) => {
        onHealthError(error)
        return false
      },
    )

  const onSignal = (): void => {
    if (stop.requested) return
    stop.request()
    onLog({ ts: now(), event: 'service', state: 'stopping', instance_id: instanceId })
  }

  signals.on('SIGTERM', onSignal)
  signals.on('SIGINT', onSignal)
  componentStartedAt.set('service', startedAt)
  await write('service', 'STARTING', {
    checkpoint: {
      components: options.components.map((component) => component.name),
      pid,
    },
  })

  const states = new Map<ServiceComponentName, ComponentState>()
  for (const component of options.components) {
    componentStartedAt.set(component.name, now())
    states.set(component.name, {
      failures: 0,
      lastHeartbeatAt: 0,
      lastSuccessAt: null,
      checkpoint: { mode: component.run === undefined ? 'tick' : 'long_running' },
    })
    await write(component.name, 'STARTING', {
      checkpoint: states.get(component.name)?.checkpoint ?? {},
    })
  }
  await write('service', 'RUNNING', {
    checkpoint: {
      components: options.components.map((component) => component.name),
      pid,
      started_at: startedAt,
    },
  })
  onLog({ ts: now(), event: 'service', state: 'running', instance_id: instanceId, pid })

  let serviceHeartbeatActive = true
  const serviceCheckpoint = (): ServiceCheckpoint => ({
    components: options.components.map((component) => component.name),
    pid,
    started_at: startedAt,
  })
  let pendingServiceHeartbeat: Promise<boolean> | undefined
  const serviceHeartbeat = setInterval(() => {
    if (!serviceHeartbeatActive) return
    pendingServiceHeartbeat = write('service', 'RUNNING', {
      checkpoint: serviceCheckpoint(),
    })
  }, heartbeatMs)
  serviceHeartbeat.unref?.()

  const heartbeat = async (
    name: ServiceComponentName,
    checkpoint?: ServiceCheckpoint,
    force = false,
  ): Promise<void> => {
    const state = states.get(name)
    if (state === undefined) return
    if (checkpoint !== undefined) state.checkpoint = checkpoint
    const current = Date.parse(now())
    if (
      !force &&
      Number.isFinite(current) &&
      state.lastHeartbeatAt > 0 &&
      current - state.lastHeartbeatAt < heartbeatMs
    )
      return
    if (Number.isFinite(current)) state.lastHeartbeatAt = current
    await write(name, 'RUNNING', {
      checkpoint: state.checkpoint,
      lastSuccessAt: state.lastSuccessAt,
    })
  }

  const withPeriodicHeartbeat = async <T>(
    name: ServiceComponentName,
    fn: () => Promise<T>,
    checkpoint: ServiceCheckpoint,
  ): Promise<T> => {
    const timer = setInterval(() => {
      void heartbeat(name, checkpoint)
    }, heartbeatMs)
    timer.unref?.()
    try {
      return await fn()
    } finally {
      clearInterval(timer)
    }
  }

  const recordFailure = async (
    component: ServiceComponent,
    state: ComponentState,
    error: unknown,
  ): Promise<void> => {
    state.failures += 1
    const reason = serviceReasonCode(error)
    const detail = errorDetail(error)
    const delay = backoffMs(state.failures, backoffBaseMs, backoffMaxMs)
    state.checkpoint = {
      mode: component.run === undefined ? 'tick' : 'long_running',
      failures: state.failures,
      next_retry_in_ms: delay,
    }
    await write(component.name, 'DEGRADED', {
      reasonCode: reason,
      detail,
      checkpoint: state.checkpoint,
      lastSuccessAt: state.lastSuccessAt,
    })
    onLog({
      ts: now(),
      event: 'component_error',
      component: component.name,
      reason_code: reason,
      detail,
      failures: state.failures,
      retry_in_ms: delay,
    })
  }

  const tickLoop = async (
    component: ServiceComponent & {
      tick: NonNullable<ServiceComponent['tick']>
    },
  ): Promise<void> => {
    const state = states.get(component.name)
    if (state === undefined) return
    const context: ServiceComponentContext = {
      stop,
      now,
      instanceId,
      heartbeat: (checkpoint) => heartbeat(component.name, checkpoint),
    }
    while (!stop.requested) {
      try {
        const result = await withPeriodicHeartbeat(
          component.name,
          () => component.tick(context),
          state.checkpoint,
        )
        if (result.checkpoint !== undefined) state.checkpoint = result.checkpoint
        if (result.reasonCode != null) {
          if (result.worked) state.lastSuccessAt = now()
          await write(component.name, 'DEGRADED', {
            reasonCode: result.reasonCode,
            detail:
              result.detail === undefined || result.detail === null
                ? null
                : errorDetail(result.detail),
            checkpoint: state.checkpoint,
            lastSuccessAt: state.lastSuccessAt,
          })
          if (!stop.requested) await interruptibleSleep(component.intervalMs, stop)
          continue
        }
        if (result.worked) {
          state.failures = 0
          state.lastSuccessAt = now()
          state.lastHeartbeatAt = Date.parse(state.lastSuccessAt)
          await write(component.name, 'RUNNING', {
            reasonCode: result.reasonCode ?? null,
            detail: result.detail ?? null,
            checkpoint: state.checkpoint,
            lastSuccessAt: state.lastSuccessAt,
          })
          continue
        }
        state.failures = 0
        await heartbeat(component.name, state.checkpoint)
        if (!stop.requested) await interruptibleSleep(component.intervalMs, stop)
      } catch (error) {
        if (stop.requested) break
        await recordFailure(component, state, error)
        await interruptibleSleep(backoffMs(state.failures, backoffBaseMs, backoffMaxMs), stop)
      }
    }
  }

  const runLoop = async (
    component: ServiceComponent & {
      run: NonNullable<ServiceComponent['run']>
    },
  ): Promise<void> => {
    const state = states.get(component.name)
    if (state === undefined) return
    const context: ServiceComponentContext = {
      stop,
      now,
      instanceId,
      heartbeat: (checkpoint) => heartbeat(component.name, checkpoint),
    }
    while (!stop.requested) {
      try {
        await withPeriodicHeartbeat(component.name, () => component.run(context), state.checkpoint)
        if (stop.requested) break
        await recordFailure(
          component,
          state,
          Object.assign(new Error('长驻组件在未收到停止信号时返回'), {
            kind: 'UNEXPECTED_COMPONENT_RETURN',
          }),
        )
        await interruptibleSleep(backoffMs(state.failures, backoffBaseMs, backoffMaxMs), stop)
      } catch (error) {
        if (stop.requested) break
        await recordFailure(component, state, error)
        await interruptibleSleep(backoffMs(state.failures, backoffBaseMs, backoffMaxMs), stop)
      }
    }
  }

  try {
    await Promise.all(
      options.components.map(async (component) => {
        if (component.tick !== undefined) await tickLoop({ ...component, tick: component.tick })
        else if (component.run !== undefined) await runLoop({ ...component, run: component.run })
      }),
    )
  } finally {
    serviceHeartbeatActive = false
    clearInterval(serviceHeartbeat)
    await pendingServiceHeartbeat
    signals.off('SIGTERM', onSignal)
    signals.off('SIGINT', onSignal)
    await write('service', 'STOPPING', {
      checkpoint: {
        components: options.components.map((component) => component.name),
        stopped_at: now(),
      },
    })
    for (const component of options.components) {
      const state = states.get(component.name)
      await write(component.name, 'STOPPED', {
        checkpoint: state?.checkpoint ?? {},
        lastSuccessAt: state?.lastSuccessAt ?? null,
      })
    }
    await write('service', 'STOPPED', {
      checkpoint: {
        components: options.components.map((component) => component.name),
        started_at: startedAt,
        stopped_at: iso(now()),
      },
    })
    onLog({ ts: now(), event: 'service', state: 'stopped', instance_id: instanceId })
  }
}
