/**
 * 常驻服务的角色健康与只读状态快照（JT-06）。
 *
 * 健康检查只读 `worker_health` 与队列表，不触发认领、回查、模型调用或外部动作。
 * 写入只发生在服务自己的心跳路径；查询失败必须向上抛出，不能把数据库不可用
 * 说成“没有异常”。
 */

import type { PoolClient } from 'pg'
import { asRole } from '../../fact/db.js'

export const SERVICE_COMPONENT_NAMES = [
  'service',
  'ingress',
  'managed',
  'memory',
  'maintenance',
  'outbox',
  'checks',
] as const

export type ServiceComponentName = (typeof SERVICE_COMPONENT_NAMES)[number]

export const REQUIRED_SERVICE_COMPONENTS = [
  'service',
  'managed',
  'memory',
  'maintenance',
  'outbox',
  'checks',
] as const satisfies readonly ServiceComponentName[]

export type ServiceHealthStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'DEGRADED'
  | 'STOPPING'
  | 'STOPPED'
  | 'BLOCKED'

export type EffectiveServiceHealthStatus = ServiceHealthStatus | 'STALE' | 'MISSING'

export interface ServiceCheckpoint {
  readonly [key: string]: unknown
}

export interface ServiceHealthRecord {
  readonly component: ServiceComponentName
  readonly status: ServiceHealthStatus
  readonly now: string
  readonly instanceId?: string
  readonly pid?: number
  readonly reasonCode?: string | null
  readonly detail?: string | null
  readonly checkpoint?: ServiceCheckpoint
  readonly startedAt?: string | null
  readonly lastSuccessAt?: string | null
}

export interface ServiceHealthRow {
  readonly name: string
  readonly status: ServiceHealthStatus
  readonly reason_code: string | null
  readonly detail: string | null
  readonly checkpoint: unknown
  readonly last_seen_at: string
  readonly last_error: string | null
  readonly started_at: string | null
  readonly last_success_at: string | null
  readonly instance_id: string | null
  readonly pid: number | null
}

export interface ServiceComponentSnapshot extends ServiceHealthRow {
  readonly age_ms: number
  readonly effective_status: EffectiveServiceHealthStatus
  readonly stale: boolean
}

export type StatusCounts = Readonly<Record<string, number>>

export interface ServiceQueueSnapshot {
  readonly managed_tasks: StatusCounts
  readonly tickets: StatusCounts
  readonly workflows: StatusCounts
  readonly workflow_nodes: StatusCounts
  readonly decisions: StatusCounts
  readonly outbox: StatusCounts
  readonly checks: StatusCounts
}

export interface ServiceRecoverySnapshot {
  readonly awaiting_human: number
  readonly awaiting_tianwen: number
  readonly leased_actions: number
  readonly executing_actions: number
  readonly uncertain_actions: number
  readonly blocked_actions: number
}

export interface ServiceStatusSnapshot {
  readonly format: 'keel-service-status/v1'
  readonly observed_at: string
  readonly stale_after_ms: number
  readonly state: 'healthy' | 'degraded' | 'unhealthy'
  readonly ok: boolean
  readonly components: readonly ServiceComponentSnapshot[]
  readonly missing_components: readonly ServiceComponentName[]
  readonly queues: ServiceQueueSnapshot
  readonly pending: {
    readonly questions: number
    readonly decisions: number
    readonly tickets: number
    readonly workflows: number
    readonly outbox: number
  }
  readonly dead_letter: {
    readonly tickets: number
    readonly workflows: number
    readonly outbox: number
    readonly managed_tasks: number
  }
  readonly recovery: ServiceRecoverySnapshot
}

const CHECKPOINT_LIMIT = 64 * 1024
const DETAIL_LIMIT = 2_000

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}…[truncated]`
}

function redacted(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://***')
}

function normalizedDetail(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null
  return clipped(redacted(value), DETAIL_LIMIT)
}

function normalizedCheckpoint(value: ServiceCheckpoint | undefined): ServiceCheckpoint {
  if (value === undefined) return {}
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch {
    return { serialization_error: true }
  }
  if (Buffer.byteLength(encoded) > CHECKPOINT_LIMIT)
    return { checkpoint_truncated: true, bytes: Buffer.byteLength(encoded) }
  return value
}

/** 写一次角色心跳；旧的三参数 worker_health 路径不受影响。 */
export async function recordServiceHealth(record: ServiceHealthRecord): Promise<void> {
  const checkpoint = normalizedCheckpoint(record.checkpoint)
  const detail = normalizedDetail(record.detail)
  const lastError =
    record.status === 'DEGRADED' || record.status === 'BLOCKED'
      ? (detail ?? record.reasonCode)
      : null
  await asRole('keel_control', async (c) => {
    await c.query(
      `INSERT INTO worker_health(
         name,last_seen_at,last_error,instance_id,pid,status,reason_code,detail,
         checkpoint,started_at,last_success_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
       ON CONFLICT (name) DO UPDATE SET
         last_seen_at=EXCLUDED.last_seen_at,
         last_error=EXCLUDED.last_error,
         instance_id=EXCLUDED.instance_id,
         pid=EXCLUDED.pid,
         status=EXCLUDED.status,
         reason_code=EXCLUDED.reason_code,
         detail=EXCLUDED.detail,
         checkpoint=EXCLUDED.checkpoint,
         started_at=COALESCE(EXCLUDED.started_at,worker_health.started_at),
         last_success_at=COALESCE(EXCLUDED.last_success_at,worker_health.last_success_at)`,
      [
        record.component,
        record.now,
        lastError,
        record.instanceId ?? null,
        record.pid ?? null,
        record.status,
        record.reasonCode ?? null,
        detail,
        JSON.stringify(checkpoint),
        record.startedAt ?? null,
        record.lastSuccessAt ?? null,
      ],
    )
  })
}

/** 启动前置检查：只读确认 JT-06 增量迁移已应用。 */
export async function assertServiceSchema(): Promise<void> {
  await asRole('keel_control', async (c) => {
    await c.query(
      `SELECT status,reason_code,detail,checkpoint,instance_id,pid,started_at,last_success_at
       FROM worker_health LIMIT 0`,
    )
  })
}

async function statusCounts(client: PoolClient, table: string): Promise<StatusCounts> {
  const result = await client.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM ${table} GROUP BY status ORDER BY status`,
  )
  return Object.fromEntries(
    result.rows.map((row) => [String(row.status), Number(row.count)]),
  ) as StatusCounts
}

async function scalar(client: PoolClient, sql: string, params: unknown[] = []): Promise<number> {
  const result = await client.query<{ count: number }>(sql, params)
  return Number(result.rows[0]?.count ?? 0)
}

function sumStatuses(counts: StatusCounts, statuses: readonly string[]): number {
  return statuses.reduce((total, status) => total + (counts[status] ?? 0), 0)
}

function expectedComponents(rows: readonly ServiceHealthRow[]): Set<ServiceComponentName> {
  const expected = new Set<ServiceComponentName>(REQUIRED_SERVICE_COMPONENTS)
  const service = rows.find((row) => row.name === 'service')
  const checkpoint = service?.checkpoint
  if (typeof checkpoint !== 'object' || checkpoint === null || !('components' in checkpoint))
    return expected
  const declared = (checkpoint as { components?: unknown }).components
  if (!Array.isArray(declared)) return expected
  for (const name of declared) {
    if (typeof name === 'string' && (SERVICE_COMPONENT_NAMES as readonly string[]).includes(name)) {
      expected.add(name as ServiceComponentName)
    }
  }
  return expected
}

function effectiveComponent(
  row: ServiceHealthRow,
  nowMs: number,
  staleAfterMs: number,
): ServiceComponentSnapshot {
  const seen = Date.parse(row.last_seen_at)
  const age = Number.isFinite(seen) ? Math.max(0, nowMs - seen) : Number.MAX_SAFE_INTEGER
  const stale = age > staleAfterMs
  const effective =
    stale && ['STARTING', 'RUNNING', 'STOPPING'].includes(row.status) ? 'STALE' : row.status
  return {
    ...row,
    age_ms: age,
    stale,
    effective_status: effective,
  }
}

/**
 * 读取一份无副作用状态快照。
 *
 * `staleAfterMs` 是显示阈值，不是“超过就安全重启”的许可：服务重启仍必须先
 * 获取 `keel-service` 会话锁，队列恢复仍依赖数据库租约。
 */
export async function readServiceStatus(
  options: { readonly now?: string; readonly staleAfterMs?: number } = {},
): Promise<ServiceStatusSnapshot> {
  const now = options.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new Error('service status 的 now 不是合法时间')
  const staleAfterMs = options.staleAfterMs ?? 30_000
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0)
    throw new Error('staleAfterMs 必须是正整数')

  return asRole('keel_control', async (c) => {
    const healthRows = await c.query<ServiceHealthRow>(
      `SELECT name,status,reason_code,detail,checkpoint,last_seen_at,last_error,
              started_at,last_success_at,instance_id,pid
       FROM worker_health
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [[...SERVICE_COMPONENT_NAMES]],
    )
    const components = healthRows.rows.map((row) => effectiveComponent(row, nowMs, staleAfterMs))
    const present = new Set(components.map((component) => component.name))
    const missing = REQUIRED_SERVICE_COMPONENTS.filter((name) => !present.has(name))
    const expected = expectedComponents(healthRows.rows)

    const queues: ServiceQueueSnapshot = {
      managed_tasks: await statusCounts(c, 'managed_task'),
      tickets: await statusCounts(c, 'managed_ticket_task'),
      workflows: await statusCounts(c, 'managed_workflow'),
      workflow_nodes: await statusCounts(c, 'managed_workflow_node'),
      decisions: await statusCounts(c, 'managed_decision_request'),
      outbox: await statusCounts(c, 'managed_action_outbox'),
      checks: await statusCounts(c, 'managed_check_target'),
    }

    const pending = {
      questions: await scalar(
        c,
        `SELECT count(*)::int AS count FROM managed_question WHERE status <> 'RESOLVED'`,
      ),
      decisions: sumStatuses(queues.decisions, ['OPEN', 'PROCESSING', 'WAITING_HUMAN']),
      tickets: sumStatuses(queues.tickets, [
        'READY',
        'RUNNING',
        'WAITING_HUMAN',
        'WAITING_GATEWAY',
        'PAUSED',
      ]),
      workflows: Object.entries(queues.workflows)
        .filter(([status]) => !['DONE', 'FAILED', 'CANCELLED'].includes(status))
        .reduce((total, [, count]) => total + count, 0),
      outbox: sumStatuses(queues.outbox, [
        'PENDING',
        'LEASED',
        'EXECUTING',
        'UNCERTAIN',
        'BLOCKED',
      ]),
    }

    const deadLetter = {
      tickets: queues.tickets.FAILED ?? 0,
      workflows: queues.workflows.FAILED ?? 0,
      outbox: queues.outbox.FAILED ?? 0,
      managedTasks: queues.managed_tasks.FAILED ?? 0,
    }

    const recovery: ServiceRecoverySnapshot = {
      awaiting_human: (queues.decisions.WAITING_HUMAN ?? 0) + (queues.tickets.WAITING_HUMAN ?? 0),
      awaiting_tianwen: queues.decisions.PROCESSING ?? 0,
      leased_actions: queues.outbox.LEASED ?? 0,
      executing_actions: queues.outbox.EXECUTING ?? 0,
      uncertain_actions: queues.outbox.UNCERTAIN ?? 0,
      blocked_actions: queues.outbox.BLOCKED ?? 0,
    }

    const unhealthy =
      missing.length > 0 ||
      components.some(
        (component) =>
          expected.has(component.name as ServiceComponentName) &&
          ['STALE', 'MISSING', 'DEGRADED', 'BLOCKED', 'STOPPED'].includes(
            component.effective_status,
          ),
      )
    const degraded =
      !unhealthy &&
      (recovery.uncertain_actions > 0 ||
        recovery.blocked_actions > 0 ||
        deadLetter.tickets + deadLetter.workflows + deadLetter.outbox + deadLetter.managedTasks > 0)
    const state = unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy'

    return {
      format: 'keel-service-status/v1',
      observed_at: now,
      stale_after_ms: staleAfterMs,
      state,
      ok: state === 'healthy',
      components,
      missing_components: missing,
      queues,
      pending,
      dead_letter: {
        tickets: deadLetter.tickets,
        workflows: deadLetter.workflows,
        outbox: deadLetter.outbox,
        managed_tasks: deadLetter.managedTasks,
      },
      recovery,
    }
  })
}

/** 给运行时使用：健康写入失败不能拖垮已开始的业务 tick，但必须留下日志。 */
export async function tryRecordServiceHealth(
  record: ServiceHealthRecord,
  onError: (error: unknown) => void = (error) =>
    console.warn('[service] health write failed', error),
): Promise<boolean> {
  try {
    await recordServiceHealth(record)
    return true
  } catch (error) {
    onError(error)
    return false
  }
}

export function isoNow(now: () => string): string {
  return iso(now())
}
