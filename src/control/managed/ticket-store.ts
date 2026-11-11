import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedTicketStageRecord, ManagedTicketTask } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'

export interface ManagedTicketClaim {
  readonly task: ManagedTicketTask
  readonly token: string
  readonly attempt: number
}

export async function ticketEvent(
  c: PoolClient,
  taskId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await c.query('INSERT INTO managed_ticket_event(task_id,type,payload) VALUES($1,$2,$3::jsonb)', [
    taskId,
    type,
    JSON.stringify(payload),
  ])
}

export async function getManagedTicketTask(id: string): Promise<ManagedTicketTask | null> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedTicketTask>('SELECT * FROM managed_ticket_task WHERE id=$1', [id]),
  )
  return result.rows[0] ?? null
}

export async function listManagedTicketStages(
  taskId: string,
): Promise<readonly ManagedTicketStageRecord[]> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedTicketStageRecord>(
      'SELECT * FROM managed_ticket_stage WHERE task_id=$1 ORDER BY started_at, stage, attempt',
      [taskId],
    ),
  )
  return result.rows
}

export async function claimManagedTicketTask(
  now: string,
  taskId?: string,
): Promise<ManagedTicketClaim | null> {
  return asRole('keel_control', async (c) => {
    const candidates = await c.query<ManagedTicketTask>(
      `SELECT t.* FROM managed_ticket_task t
       JOIN (
         SELECT DISTINCT ON (repo_id) id
         FROM managed_ticket_task
         WHERE ($1::uuid IS NULL OR id=$1)
           AND (status='READY' OR (status='RUNNING' AND lease_until <= clock_timestamp()))
         ORDER BY repo_id,updated_at,id
       ) fair ON fair.id=t.id
       ORDER BY t.updated_at,t.id
       FOR UPDATE OF t SKIP LOCKED LIMIT 1`,
      [taskId ?? null],
    )
    const task = candidates.rows[0]
    if (task === undefined) return null
    if (task.status === 'RUNNING') {
      await c.query(
        `UPDATE managed_ticket_stage SET status='FAILED',ended_at=$2,error='owner lease expired'
         WHERE task_id=$1 AND status='RUNNING'`,
        [task.id, now],
      )
      await ticketEvent(c, task.id, 'ManagedTicketLeaseExpired', { token: task.lease_token })
    }
    if (task.attempts >= task.max_attempts) {
      await c.query(
        `UPDATE managed_ticket_task SET status='FAILED',last_error='managed ticket attempt budget exhausted',
           lease_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1`,
        [task.id, now],
      )
      await ticketEvent(c, task.id, 'ManagedTicketBudgetExhausted', {})
      return null
    }
    const token = randomUUID()
    const attempt = task.attempts + 1
    await c.query(
      `UPDATE managed_ticket_task SET status='RUNNING',lease_token=$2,
         lease_until=clock_timestamp() + interval '300 seconds',
         attempts=attempts+1,last_error=NULL,updated_at=$3 WHERE id=$1`,
      [task.id, token, now],
    )
    await ticketEvent(c, task.id, 'ManagedTicketAttemptStarted', {
      attempt,
      token,
      stage: task.current_stage,
    })
    return {
      task: { ...task, status: 'RUNNING', lease_token: token, attempts: attempt },
      token,
      attempt,
    }
  })
}

export async function withManagedTicketClaim<T>(
  claim: ManagedTicketClaim,
  fn: (c: PoolClient) => Promise<T>,
): Promise<Result<T>> {
  return asRole('keel_control', async (c) => {
    const locked = await c.query(
      `SELECT id FROM managed_ticket_task
       WHERE id=$1 AND status='RUNNING' AND lease_token=$2 AND lease_until > clock_timestamp()
       FOR UPDATE`,
      [claim.task.id, claim.token],
    )
    if (locked.rowCount !== 1)
      return err(makeError('CONFLICT', 'managed ticket lease 已过期或被其他 worker 替代'))
    return ok(await fn(c))
  })
}
