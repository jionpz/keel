/** 持久认领、等待与答复；所有写入以 control 角色完成，外部推理不持事务。 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedQuestion, ManagedTask } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import { answerManagedQuestionWithDecision } from './decision-store.js'

export async function managedEvent(
  c: PoolClient,
  taskId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await c.query('INSERT INTO managed_event(task_id,type,payload) VALUES ($1,$2,$3::jsonb)', [
    taskId,
    type,
    JSON.stringify(payload),
  ])
}

export async function getManagedTask(id: string): Promise<ManagedTask | null> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedTask>('SELECT * FROM managed_task WHERE id=$1', [id]),
  )
  return result.rows[0] ?? null
}

export async function getManagedQuestion(id: string): Promise<ManagedQuestion | null> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedQuestion>(
      `SELECT q.id,q.task_id,q.question,q.options,
         CASE WHEN correction.answer IS NULL THEN q.status ELSE 'RESOLVED' END AS status,
         q.suggestion,COALESCE(correction.answer,q.answer) AS answer
       FROM managed_question q
       LEFT JOIN LATERAL (
         SELECT answer FROM managed_question_correction
         WHERE question_id=q.id ORDER BY created_at DESC LIMIT 1
       ) correction ON true
       WHERE q.id=$1`,
      [id],
    ),
  )
  return result.rows[0] ?? null
}

export interface ManagedClaim {
  readonly task: ManagedTask
  readonly attemptId: string
  readonly token: string
}

export async function claimManagedTask(now: string, taskId?: string): Promise<ManagedClaim | null> {
  return asRole('keel_control', async (c) => {
    const candidates = await c.query<ManagedTask>(
      `SELECT * FROM managed_task WHERE ($1::uuid IS NULL OR id=$1)
       AND (status IN ('READY','WAITING_TIANWEN') OR (status='RUNNING' AND lease_until <= clock_timestamp()))
       ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
      [taskId ?? null],
    )
    const task = candidates.rows[0]
    if (task === undefined) return null
    if (task.status === 'RUNNING') {
      await c.query(
        `UPDATE managed_attempt SET status='TIMEOUT', ended_at=$2, error='owner lease expired'
        WHERE task_id=$1 AND status='RUNNING'`,
        [task.id, now],
      )
      await managedEvent(c, task.id, 'ManagedLeaseExpired', { token: task.lease_token })
    }
    if (task.attempts >= task.max_attempts) {
      // 耗尽全局调用预算明确失败，不自动冒充任何答复或批准。
      await c.query(
        `UPDATE managed_task SET status='FAILED',error='managed attempt budget exhausted',lease_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1`,
        [task.id, now],
      )
      await managedEvent(c, task.id, 'ManagedBudgetExhausted', {})
      return null
    }
    const token = randomUUID()
    const attemptId = randomUUID()
    await c.query(
      `UPDATE managed_task SET status='RUNNING',lease_token=$2,lease_until=clock_timestamp() + interval '120 seconds',attempts=attempts+1,updated_at=$3 WHERE id=$1`,
      [task.id, token, now],
    )
    await c.query(
      `INSERT INTO managed_attempt(id,task_id,phase,lease_token,status,context,started_at) VALUES($1,$2,$3,$4,'RUNNING','{}',$5)`,
      [attemptId, task.id, task.phase, token, now],
    )
    await managedEvent(
      c,
      task.id,
      task.phase === 'tianwen' ? 'TianwenAttemptStarted' : 'ManagedAttemptStarted',
      { attemptId, token, phase: task.phase },
    )
    return {
      task: { ...task, status: 'RUNNING', lease_token: token, attempts: task.attempts + 1 },
      token,
      attemptId,
    }
  })
}

/** 认领者每次提交必须匹配当前 lease，迟到 worker 不能覆盖新结果。 */
export async function withManagedClaim<T>(
  claim: ManagedClaim,
  fn: (c: PoolClient) => Promise<T>,
): Promise<Result<T>> {
  return asRole('keel_control', async (c) => {
    const locked = await c.query(
      `SELECT id FROM managed_task WHERE id=$1 AND status='RUNNING' AND lease_token=$2 AND lease_until > clock_timestamp() FOR UPDATE`,
      [claim.task.id, claim.token],
    )
    if (locked.rowCount !== 1)
      return err(makeError('CONFLICT', 'managed lease 已过期或被其他 worker 替代'))
    return ok(await fn(c))
  })
}

/** CLI 是本轮唯一可信本机操作者入口；不允许调用者自填 actor/source。 */
export async function answerManagedQuestion(id: string, text: string): Promise<Result<string>> {
  return answerManagedQuestionWithDecision(id, text)
}
