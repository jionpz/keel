import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { asRole } from '../../fact/db.js'
import { ticketEvent } from './ticket-store.js'

export interface ManagedActionControlBoundary {
  readonly blockedOutboxIds: readonly string[]
  readonly executingOutboxIds: readonly string[]
}

export interface ManagedTicketControlResult extends ManagedActionControlBoundary {
  readonly taskId: string
  readonly status: 'PAUSED' | 'READY' | 'CANCELLED'
  readonly controlGeneration: number
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 控制面覆盖先锁 outbox，再锁 task，和 gateway 的 outbox -> permit/task 顺序一致。
 * 尚未开始的动作变 BLOCKED；已经 EXECUTING 的只记录外部边界，不谎报撤销。
 */
export async function blockPendingActionsInTx(
  c: PoolClient,
  taskId: string,
  reason: string,
  now: string,
): Promise<ManagedActionControlBoundary> {
  const rows = await c.query<{
    id: string
    status: string
    permit_id: string | null
  }>(
    `SELECT o.id,o.status,o.permit_id
     FROM managed_action_outbox o
     JOIN managed_action_intent i ON i.id=o.action_intent_id
     WHERE i.task_id=$1 AND o.status IN ('PENDING','LEASED','EXECUTING')
     ORDER BY o.id
     FOR UPDATE OF o`,
    [taskId],
  )
  const task = await c.query('SELECT id FROM managed_ticket_task WHERE id=$1 FOR UPDATE', [taskId])
  if (task.rowCount !== 1) throw makeError('NOT_FOUND', '找不到 managed ticket task')
  const blockedOutboxIds: string[] = []
  const executingOutboxIds: string[] = []
  for (const row of rows.rows) {
    if (row.status === 'PENDING' || row.status === 'LEASED') {
      const updated = await c.query(
        `UPDATE managed_action_outbox
         SET status='BLOCKED',last_error=$2,lease_token=NULL,lease_until=NULL,updated_at=$1
         WHERE id=$3 AND status IN ('PENDING','LEASED')`,
        [now, `CONTROL_OVERRIDE: ${reason}`, row.id],
      )
      if (updated.rowCount === 1) blockedOutboxIds.push(row.id)
    } else {
      executingOutboxIds.push(row.id)
    }
  }
  await c.query(
    `UPDATE managed_execution_permit p
     SET status='REVOKED'
     FROM managed_action_intent i
     WHERE p.action_intent_id=i.id
       AND i.task_id=$1
       AND p.status='VALID'`,
    [taskId],
  )
  if (blockedOutboxIds.length > 0) {
    await ticketEvent(c, taskId, 'ManagedActionBlockedByControl', {
      reason,
      outboxIds: blockedOutboxIds,
    })
  }
  if (executingOutboxIds.length > 0) {
    await ticketEvent(c, taskId, 'ManagedActionControlBoundary', {
      reason,
      outboxIds: executingOutboxIds,
      boundary: 'external action already started; check remote state before retry or compensation',
    })
  }
  return { blockedOutboxIds, executingOutboxIds }
}

async function controlTicket(
  taskId: string,
  target: 'PAUSED' | 'CANCELLED',
  reason: string,
  now: string,
): Promise<Result<ManagedTicketControlResult>> {
  if (!reason.trim()) return err(makeError('SCHEMA_VIOLATION', '控制原因不能为空'))
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '控制时间不是合法时间'))
  return asRole('keel_control', async (c) => {
    const task = await c.query<{
      id: string
      status: string
      control_generation: string | number
    }>(
      `SELECT id,status,control_generation FROM managed_ticket_task
       WHERE id=$1`,
      [taskId],
    )
    const preflight = task.rows[0]
    if (preflight === undefined) return err(makeError('NOT_FOUND', '找不到 managed ticket task'))
    if (['DONE', 'FAILED', 'CANCELLED'].includes(preflight.status))
      return err(makeError('CONFLICT', `ticket task 当前是 ${preflight.status}，不能人工控制`))

    const boundary = await blockPendingActionsInTx(c, taskId, reason, now)
    const locked = await c.query<{ control_generation: string | number }>(
      'SELECT control_generation FROM managed_ticket_task WHERE id=$1',
      [taskId],
    )
    const generation = Number(locked.rows[0]?.control_generation) + 1
    if (!Number.isSafeInteger(generation) || generation < 1)
      return err(makeError('CONFLICT', 'ticket task 控制代次溢出'))
    await c.query(
      `UPDATE managed_ticket_stage
       SET status='FAILED',error='HUMAN_OVERRODE_ACTIVE_STAGE',ended_at=$2
       WHERE task_id=$1 AND status='RUNNING'`,
      [taskId, now],
    )
    await c.query(
      `UPDATE managed_ticket_task
       SET status=$2,control_generation=$3,lease_token=NULL,lease_until=NULL,
           pending_decision_id=NULL,pending_decision_revision=NULL,
           last_error=$4,updated_at=$1
       WHERE id=$5`,
      [now, target, generation, `${target}: ${reason.trim()}`, taskId],
    )
    await c.query(
      `UPDATE managed_decision_request
       SET status='CANCELLED',updated_at=$2
       WHERE managed_ticket_task_id=$1
         AND status IN ('OPEN','PROCESSING','WAITING_HUMAN')`,
      [taskId, now],
    )
    await ticketEvent(c, taskId, `ManagedTicket${target === 'PAUSED' ? 'Paused' : 'Cancelled'}`, {
      reason: reason.trim(),
      controlGeneration: generation,
      ...boundary,
    })
    return ok({
      taskId,
      status: target,
      controlGeneration: generation,
      ...boundary,
    })
  })
}

export async function pauseManagedTicket(
  taskId: string,
  reason: string,
  now: string,
): Promise<Result<ManagedTicketControlResult>> {
  return controlTicket(taskId, 'PAUSED', reason, now)
}

export async function cancelManagedTicket(
  taskId: string,
  reason: string,
  now: string,
): Promise<Result<ManagedTicketControlResult>> {
  return controlTicket(taskId, 'CANCELLED', reason, now)
}

export async function resumeManagedTicket(
  taskId: string,
  now: string,
): Promise<Result<ManagedTicketControlResult>> {
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '恢复时间不是合法时间'))
  return asRole('keel_control', async (c) => {
    const task = await c.query<{
      status: string
      control_generation: string | number
    }>(`SELECT status,control_generation FROM managed_ticket_task WHERE id=$1 FOR UPDATE`, [taskId])
    const row = task.rows[0]
    if (row === undefined) return err(makeError('NOT_FOUND', '找不到 managed ticket task'))
    if (row.status !== 'PAUSED')
      return err(makeError('CONFLICT', `ticket task 当前是 ${row.status}，不是 PAUSED`))
    const generation = Number(row.control_generation) + 1
    await c.query(
      `UPDATE managed_ticket_task
       SET status='READY',control_generation=$2,lease_token=NULL,lease_until=NULL,
           last_error=NULL,updated_at=$1
       WHERE id=$3`,
      [now, generation, taskId],
    )
    await ticketEvent(c, taskId, 'ManagedTicketResumed', {
      controlGeneration: generation,
    })
    return ok({
      taskId,
      status: 'READY',
      controlGeneration: generation,
      blockedOutboxIds: [],
      executingOutboxIds: [],
    })
  })
}
