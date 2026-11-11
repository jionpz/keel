import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  ManagedActionOutboxClaim,
  ManagedActionOutboxRecord,
  ManagedActionOutboxStatus,
  ManagedTicketTask,
} from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import type { ManagedActionIntent, ManagedExecutionPermit } from '../../generated/managed.js'
import type { ActionAuthorization } from './action-authorization.js'
import { actionTargetDigest } from './action-protocol.js'
import { insertCheckTarget } from './check-store.js'
import { ticketEvent } from './ticket-store.js'

const INTENT_JSON = `jsonb_strip_nulls(to_jsonb(i)) AS body
  FROM (
    SELECT id, '1.0'::text AS schema_version, project_id, repo_id, task_id, action,
      remote_url, base_branch, head_branch, head_sha, diff_digest, environment,
      reversibility, affected_resources, pr_title, pr_body,
      CASE WHEN decision_request_id IS NULL THEN NULL ELSE jsonb_build_object(
        'request_id', decision_request_id,
        'request_revision', decision_request_revision,
        'resolution_id', decision_resolution_id,
        'digest', decision_digest
      ) END AS decision,
      idempotency_key, created_at
    FROM managed_action_intent
  ) i`

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function outboxRow(row: Record<string, unknown>): ManagedActionOutboxRecord {
  return {
    id: String(row.id),
    action_intent_id: String(row.action_intent_id),
    status: row.status as ManagedActionOutboxStatus,
    lease_token: row.lease_token === null ? null : String(row.lease_token),
    lease_until: iso(row.lease_until as Date | string | null),
    fence: Number(row.fence),
    attempts: Number(row.attempts),
    permit_id: row.permit_id === null ? null : String(row.permit_id),
    remote_kind: (row.remote_kind as 'pull_request' | null) ?? null,
    remote_id: row.remote_id === null ? null : String(row.remote_id),
    remote_url: row.remote_url === null ? null : String(row.remote_url),
    result: row.result,
    last_error: row.last_error === null ? null : String(row.last_error),
    next_attempt_at: iso(row.next_attempt_at as Date | string | null),
    created_at: iso(row.created_at as Date | string) ?? String(row.created_at),
    updated_at: iso(row.updated_at as Date | string) ?? String(row.updated_at),
  }
}

function permitRow(row: Record<string, unknown>): ManagedExecutionPermit {
  const checks = row.required_checks
  if (!Array.isArray(checks) || !checks.every((item): item is string => typeof item === 'string'))
    throw makeError('PROTOCOL_ERROR', 'ExecutionPermit required_checks 不是字符串数组')
  const budget = row.budget
  if (typeof budget !== 'object' || budget === null || Array.isArray(budget))
    throw makeError('PROTOCOL_ERROR', 'ExecutionPermit budget 不是对象')
  const decision =
    row.decision_request_id === null
      ? undefined
      : {
          request_id: String(row.decision_request_id),
          request_revision: Number(row.decision_request_revision),
          resolution_id: String(row.decision_resolution_id),
          digest: String(row.decision_digest),
        }
  return {
    schema_version: '1.0',
    id: String(row.id),
    action_intent_id: String(row.action_intent_id),
    project_id: String(row.project_id),
    repo_id: String(row.repo_id),
    action: 'push_and_pr',
    authorization: {
      kind: 'delegation_policy',
      id: String(row.authorization_id),
      version: Number(row.authorization_version),
      rule_id: String(row.authorization_rule_id),
      digest: String(row.authorization_digest),
    },
    authorization_epoch: Number(row.authorization_epoch),
    task_control_generation: Number(row.task_control_generation),
    budget: budget as ManagedExecutionPermit['budget'],
    ...(decision === undefined ? {} : { decision }),
    expected_sha: String(row.expected_sha),
    diff_digest: String(row.diff_digest),
    target_digest: String(row.target_digest),
    required_checks: checks,
    environment: row.environment as ManagedExecutionPermit['environment'],
    fencing_token: Number(row.fencing_token),
    idempotency_key: String(row.idempotency_key),
    issued_at: iso(row.issued_at as Date | string) ?? String(row.issued_at),
    expires_at: iso(row.expires_at as Date | string) ?? String(row.expires_at),
    status: row.status as ManagedExecutionPermit['status'],
  }
}

export interface EnqueueActionInput {
  readonly task_id: string
  readonly project_id: string
  readonly repo_id: string
  readonly remote_url: string
  readonly base_branch: string
  readonly head_branch: string
  readonly head_sha: string
  readonly diff_digest: string
  readonly environment: ManagedActionIntent['environment']
  readonly reversibility: ManagedActionIntent['reversibility']
  readonly affected_resources: readonly string[]
  readonly pr_title: string
  readonly pr_body: string
  readonly decision?: ManagedActionIntent['decision']
  readonly created_at: string
}

export interface EnqueuedAction {
  readonly intentId: string
  readonly outboxId: string
}

export async function enqueueActionIntent(
  c: PoolClient,
  input: EnqueueActionInput,
): Promise<EnqueuedAction> {
  const intentId = randomUUID()
  const outboxId = randomUUID()
  const idempotencyKey = `ticket:${input.task_id}:push_and_pr`
  await c.query(
    `INSERT INTO managed_action_intent(
      id,task_id,project_id,repo_id,action,remote_url,base_branch,head_branch,
      head_sha,diff_digest,environment,reversibility,affected_resources,
      pr_title,pr_body,decision_request_id,decision_request_revision,
      decision_resolution_id,decision_digest,idempotency_key,created_at
    ) VALUES(
      $1,$2,$3,$4,'push_and_pr',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,
      $15,$16,$17,$18,$19,$20
    )`,
    [
      intentId,
      input.task_id,
      input.project_id,
      input.repo_id,
      input.remote_url,
      input.base_branch,
      input.head_branch,
      input.head_sha,
      input.diff_digest,
      input.environment,
      input.reversibility,
      JSON.stringify(input.affected_resources),
      input.pr_title,
      input.pr_body,
      input.decision?.request_id ?? null,
      input.decision?.request_revision ?? null,
      input.decision?.resolution_id ?? null,
      input.decision?.digest ?? null,
      idempotencyKey,
      input.created_at,
    ],
  )
  await c.query(
    `INSERT INTO managed_action_outbox(id,action_intent_id,status,created_at,updated_at)
     VALUES($1,$2,'PENDING',$3,$3)`,
    [outboxId, intentId, input.created_at],
  )
  await c.query(
    `UPDATE managed_ticket_task SET status='WAITING_GATEWAY',
       handoff=$2::jsonb,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=$3
     WHERE id=$1`,
    [
      input.task_id,
      JSON.stringify({
        action_intent_id: intentId,
        outbox_id: outboxId,
        action: 'push_and_pr',
        remote_url: input.remote_url,
        base_branch: input.base_branch,
        head_branch: input.head_branch,
        head_sha: input.head_sha,
        diff_digest: input.diff_digest,
        completion_target: 'pr_ready',
      }),
      input.created_at,
    ],
  )
  await ticketEvent(c, input.task_id, 'ManagedTicketActionQueued', {
    actionIntentId: intentId,
    outboxId,
    action: 'push_and_pr',
    remoteUrl: input.remote_url,
    baseBranch: input.base_branch,
    headBranch: input.head_branch,
    headSha: input.head_sha,
    diffDigest: input.diff_digest,
  })
  return { intentId, outboxId }
}

export async function getActionIntent(
  id: string,
  client?: PoolClient,
): Promise<ManagedActionIntent | null> {
  const run = async (c: PoolClient): Promise<ManagedActionIntent | null> => {
    const row = await c.query<{ body: unknown }>(`SELECT ${INTENT_JSON} WHERE i.id=$1`, [id])
    return (row.rows[0]?.body as ManagedActionIntent | undefined) ?? null
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function getActionOutbox(
  id: string,
  client?: PoolClient,
): Promise<ManagedActionOutboxRecord | null> {
  const run = async (c: PoolClient): Promise<ManagedActionOutboxRecord | null> => {
    const row = await c.query<Record<string, unknown>>(
      'SELECT * FROM managed_action_outbox WHERE id=$1',
      [id],
    )
    return row.rows[0] === undefined ? null : outboxRow(row.rows[0])
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function getManagedActionTask(
  taskId: string,
  client?: PoolClient,
): Promise<ManagedTicketTask | null> {
  const run = async (c: PoolClient): Promise<ManagedTicketTask | null> => {
    const row = await c.query<ManagedTicketTask>('SELECT * FROM managed_ticket_task WHERE id=$1', [
      taskId,
    ])
    return row.rows[0] ?? null
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function getRepoBinding(
  repoId: string,
  client?: PoolClient,
): Promise<{ remote_url: string; default_branch: string } | null> {
  const run = async (
    c: PoolClient,
  ): Promise<{ remote_url: string; default_branch: string } | null> => {
    const row = await c.query<{ remote_url: string; default_branch: string }>(
      'SELECT remote_url, default_branch FROM repo WHERE id=$1',
      [repoId],
    )
    return row.rows[0] ?? null
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function claimActionOutbox(now: string): Promise<ManagedActionOutboxClaim | null> {
  return asRole('keel_control', async (c) => {
    const candidates = await c.query<Record<string, unknown>>(
      `SELECT o.* FROM managed_action_outbox o
       JOIN managed_action_intent i ON i.id=o.action_intent_id
       JOIN (
         SELECT DISTINCT ON (i2.project_id) o2.id
         FROM managed_action_outbox o2
         JOIN managed_action_intent i2 ON i2.id=o2.action_intent_id
         WHERE (o2.status='PENDING' AND (o2.next_attempt_at IS NULL OR o2.next_attempt_at <= $1))
            OR (o2.status='LEASED' AND o2.lease_until <= $1)
         ORDER BY i2.project_id,o2.created_at,o2.id
       ) fair ON fair.id=o.id
       ORDER BY o.created_at,o.id
       FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
      [now],
    )
    const row = candidates.rows[0]
    if (row === undefined) return null
    const leaseToken = randomUUID()
    const leaseUntil = new Date(Date.parse(now) + 120_000).toISOString()
    await c.query(
      `UPDATE managed_action_outbox SET status='LEASED',lease_token=$2,lease_until=$3,
         attempts=attempts+1,updated_at=$1 WHERE id=$4`,
      [now, leaseToken, leaseUntil, row.id],
    )
    const intent = await getActionIntent(String(row.action_intent_id), c)
    if (intent === null) throw makeError('PROTOCOL_ERROR', 'action outbox 引用的 intent 不存在')
    const outbox = await getActionOutbox(String(row.id), c)
    if (outbox === null) throw makeError('PROTOCOL_ERROR', 'action outbox 刚刚消失')
    return { outbox, intent }
  })
}

export async function expireExecutingActions(now: string): Promise<number> {
  return asRole('keel_control', async (c) => {
    const rows = await c.query<{
      id: string
      permit_id: string | null
      task_id: string
    }>(
      `SELECT o.id,o.permit_id,i.task_id
       FROM managed_action_outbox o JOIN managed_action_intent i ON i.id=o.action_intent_id
       WHERE o.status='EXECUTING' AND o.lease_until <= $1
       FOR UPDATE OF o SKIP LOCKED`,
      [now],
    )
    for (const row of rows.rows) {
      await c.query(
        `UPDATE managed_action_outbox SET status='UNCERTAIN',
           last_error='gateway lease expired while executing',lease_token=NULL,
           lease_until=NULL,updated_at=$1 WHERE id=$2`,
        [now, row.id],
      )
      if (row.permit_id !== null) {
        await c.query(
          `UPDATE managed_execution_permit SET status='EXPIRED'
           WHERE id=$1 AND status='VALID'`,
          [row.permit_id],
        )
      }
      await c.query(
        `UPDATE managed_ticket_task SET status='PAUSED',
           last_error='ACTION_UNCERTAIN: gateway lease expired while executing',
           updated_at=$1 WHERE id=$2 AND status='WAITING_GATEWAY'`,
        [now, row.task_id],
      )
      await ticketEvent(c, row.task_id, 'ManagedActionLeaseExpired', {
        outboxId: row.id,
        permitId: row.permit_id,
      })
    }
    return rows.rowCount ?? 0
  })
}

export async function issuePermit(
  claim: ManagedActionOutboxClaim,
  authorization: Extract<ActionAuthorization, { ok: true }>,
  now: string,
): Promise<ManagedExecutionPermit> {
  return asRole('keel_control', async (c) => {
    const locked = await c.query<{ available: boolean }>(
      `SELECT managed_action_policy_available($1,$2,$3,$4::timestamptz) AS available`,
      [authorization.policy_id, claim.intent.project_id, authorization.policy_version, now],
    )
    if (locked.rows[0]?.available !== true)
      throw makeError('CONFLICT', '授权策略在签发许可前已失效')
    const memory = await c.query<{ epoch: string | number }>(
      'SELECT managed_project_memory_lock($1,$2::timestamptz) AS epoch',
      [claim.intent.project_id, now],
    )
    const authorizationEpoch = Number(memory.rows[0]?.epoch)
    if (!Number.isSafeInteger(authorizationEpoch) || authorizationEpoch < 0)
      throw makeError('CONFLICT', '项目授权 epoch 无效')
    const task = await c.query<{ control_generation: string | number }>(
      'SELECT control_generation FROM managed_ticket_task WHERE id=$1 FOR SHARE',
      [claim.intent.task_id],
    )
    const taskControlGeneration = Number(task.rows[0]?.control_generation)
    if (!Number.isSafeInteger(taskControlGeneration) || taskControlGeneration < 0)
      throw makeError('CONFLICT', 'ticket task 不存在或控制代次无效')
    await c.query(
      `UPDATE managed_execution_permit SET status='REVOKED'
       WHERE action_intent_id=$1 AND status='VALID'`,
      [claim.intent.id],
    )
    const expiresAt = new Date(Date.parse(now) + 300_000).toISOString()
    const permitId = randomUUID()
    const inserted = await c.query<Record<string, unknown>>(
      `INSERT INTO managed_execution_permit(
        id,action_intent_id,project_id,repo_id,action,authorization_kind,
        authorization_id,authorization_version,authorization_rule_id,authorization_digest,
        authorization_epoch,task_control_generation,budget,
        decision_request_id,decision_request_revision,decision_resolution_id,decision_digest,
        expected_sha,diff_digest,target_digest,required_checks,environment,
        idempotency_key,issued_at,expires_at
      ) VALUES(
        $1,$2,$3,$4,'push_and_pr','delegation_policy',$5,$6,$7,$8,$9,$10,$11::jsonb,
        $12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23
      )
      RETURNING *`,
      [
        permitId,
        claim.intent.id,
        claim.intent.project_id,
        claim.intent.repo_id,
        authorization.policy_id,
        authorization.policy_version,
        authorization.rule_id,
        authorization.digest,
        authorizationEpoch,
        taskControlGeneration,
        JSON.stringify(authorization.budget),
        claim.intent.decision?.request_id ?? null,
        claim.intent.decision?.request_revision ?? null,
        claim.intent.decision?.resolution_id ?? null,
        claim.intent.decision?.digest ?? null,
        claim.intent.head_sha,
        claim.intent.diff_digest,
        actionTargetDigest(claim.intent),
        JSON.stringify(authorization.required_checks),
        claim.intent.environment,
        `permit:${claim.intent.id}:${randomUUID()}`,
        now,
        expiresAt,
      ],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw makeError('CONFLICT', '执行许可写入失败')
    const available = await c.query<{ available: boolean }>(
      `SELECT managed_execution_permit_available($1,$2::timestamptz) AS available`,
      [permitId, now],
    )
    if (available.rows[0]?.available !== true)
      throw makeError('CONFLICT', '执行许可的决定、授权或任务控制状态已失效')
    return permitRow(row)
  })
}

export async function executionPermitAvailable(
  permitId: string,
  at: string,
  client?: PoolClient,
): Promise<boolean> {
  const run = async (c: PoolClient): Promise<boolean> => {
    const row = await c.query<{ available: boolean }>(
      'SELECT managed_execution_permit_available($1,$2::timestamptz) AS available',
      [permitId, at],
    )
    return row.rows[0]?.available === true
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function getExecutionPermit(
  id: string,
  client?: PoolClient,
): Promise<ManagedExecutionPermit | null> {
  const run = async (c: PoolClient): Promise<ManagedExecutionPermit | null> => {
    const row = (
      await c.query<Record<string, unknown>>('SELECT * FROM managed_execution_permit WHERE id=$1', [
        id,
      ])
    ).rows[0]
    return row === undefined ? null : permitRow(row)
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function markActionExecuting(
  claim: ManagedActionOutboxClaim,
  permit: ManagedExecutionPermit,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const available = await c.query<{ available: boolean }>(
      `SELECT managed_execution_permit_available($1,$2::timestamptz) AS available`,
      [permit.id, now],
    )
    if (available.rows[0]?.available !== true)
      return err(makeError('CONFLICT', '执行许可在开始动作前已失效'))
    const leaseUntil = new Date(Date.parse(now) + 300_000).toISOString()
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='EXECUTING',permit_id=$2,fence=$3,
         lease_until=$4,updated_at=$1
       WHERE id=$5 AND status='LEASED' AND lease_token=$6 AND fence <= $3
       RETURNING *`,
      [now, permit.id, permit.fencing_token, leaseUntil, claim.outbox.id, claim.outbox.lease_token],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox lease 已过期或被其他 gateway 替代'))
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function blockAction(
  claim: ManagedActionOutboxClaim,
  reason: string,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='BLOCKED',last_error=$2,lease_token=NULL,
         lease_until=NULL,updated_at=$1
       WHERE id=$3 AND status='LEASED' AND lease_token=$4
       RETURNING *`,
      [now, reason, claim.outbox.id, claim.outbox.lease_token],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox lease 已过期或被其他 gateway 替代'))
    await c.query(
      `UPDATE managed_ticket_task SET status='PAUSED',last_error=$2,updated_at=$1
       WHERE id=$3 AND status='WAITING_GATEWAY'`,
      [now, `ACTION_BLOCKED: ${reason}`, claim.intent.task_id],
    )
    await ticketEvent(c, claim.intent.task_id, 'ManagedActionBlocked', {
      outboxId: claim.outbox.id,
      reason,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function settleActionSuccess(
  claim: ManagedActionOutboxClaim,
  permit: ManagedExecutionPermit,
  pullRequest: { readonly number: number; readonly url: string; readonly created: boolean },
  now: string,
  deadlineAt = new Date(Date.parse(now) + 30 * 60_000).toISOString(),
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const result = {
      pull_request: {
        number: pullRequest.number,
        url: pullRequest.url,
        created: pullRequest.created,
      },
    }
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='SUCCEEDED',remote_kind='pull_request',
         remote_id=$2,remote_url=$3,result=$4::jsonb,lease_token=NULL,lease_until=NULL,
         last_error=NULL,updated_at=$1
       WHERE id=$5 AND status='EXECUTING' AND permit_id=$6 AND fence=$7
       RETURNING *`,
      [
        now,
        String(pullRequest.number),
        pullRequest.url,
        JSON.stringify(result),
        claim.outbox.id,
        permit.id,
        permit.fencing_token,
      ],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox fence 不匹配，拒绝写入成功结果'))
    await insertCheckTarget(c, permit, claim.intent, pullRequest, deadlineAt, now)
    await c.query(
      `UPDATE managed_execution_permit SET status='CONSUMED' WHERE id=$1 AND status='VALID'`,
      [permit.id],
    )
    const task = (
      await c.query<{ status: string }>(
        'SELECT status FROM managed_ticket_task WHERE id=$1 FOR UPDATE',
        [claim.intent.task_id],
      )
    ).rows[0]
    if (task === undefined) return err(makeError('NOT_FOUND', '找不到 managed ticket task'))
    if (task.status === 'WAITING_GATEWAY') {
      await c.query(
        `UPDATE managed_ticket_task SET status='PR_OPENED',
           handoff=COALESCE(handoff,'{}'::jsonb) || $2::jsonb,last_error=NULL,updated_at=$1
         WHERE id=$3`,
        [
          now,
          JSON.stringify({
            pull_request: result.pull_request,
            completion_target: 'pr_ready',
          }),
          claim.intent.task_id,
        ],
      )
    } else if (task.status === 'PAUSED' || task.status === 'CANCELLED') {
      await c.query(
        `UPDATE managed_ticket_task
         SET handoff=COALESCE(handoff,'{}'::jsonb) || $2::jsonb,updated_at=$1
         WHERE id=$3`,
        [
          now,
          JSON.stringify({
            pull_request: result.pull_request,
            completion_target: 'pr_ready',
            external_action_completed: true,
            external_action_completed_at: now,
          }),
          claim.intent.task_id,
        ],
      )
      await ticketEvent(c, claim.intent.task_id, 'ManagedActionSucceededWhileControlled', {
        outboxId: claim.outbox.id,
        permitId: permit.id,
        pullRequest: result.pull_request,
        taskStatus: task.status,
        boundary: 'remote action completed after human control; task remains controlled',
      })
    } else {
      return err(makeError('CONFLICT', `ticket task 当前是 ${task.status}，不能写入成功结算`))
    }
    await ticketEvent(c, claim.intent.task_id, 'ManagedActionSucceeded', {
      outboxId: claim.outbox.id,
      permitId: permit.id,
      pullRequest: result.pull_request,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function settleActionFailure(
  claim: ManagedActionOutboxClaim,
  permit: ManagedExecutionPermit,
  status: 'FAILED' | 'UNCERTAIN',
  error: string,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status=$2,last_error=$3,lease_token=NULL,
         lease_until=NULL,updated_at=$1
       WHERE id=$4 AND status='EXECUTING' AND permit_id=$5 AND fence=$6
       RETURNING *`,
      [now, status, error, claim.outbox.id, permit.id, permit.fencing_token],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox fence 不匹配，拒绝写入失败结果'))
    if (status === 'FAILED') {
      await c.query(
        `UPDATE managed_execution_permit SET status='REVOKED'
         WHERE id=$1 AND status='VALID'`,
        [permit.id],
      )
    }
    await c.query(
      `UPDATE managed_ticket_task SET status='PAUSED',last_error=$2,updated_at=$1
       WHERE id=$3 AND status='WAITING_GATEWAY'`,
      [now, `ACTION_${status}: ${error}`, claim.intent.task_id],
    )
    await ticketEvent(c, claim.intent.task_id, `ManagedAction${status}`, {
      outboxId: claim.outbox.id,
      permitId: permit.id,
      error,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function listUncertainActions(
  limit = 20,
): Promise<readonly ManagedActionOutboxClaim[]> {
  return asRole('keel_control', async (c) => {
    const rows = await c.query<Record<string, unknown>>(
      `SELECT * FROM managed_action_outbox WHERE status='UNCERTAIN'
       ORDER BY updated_at,id LIMIT $1`,
      [limit],
    )
    const out: ManagedActionOutboxClaim[] = []
    for (const row of rows.rows) {
      const intent = await getActionIntent(String(row.action_intent_id), c)
      if (intent === null) continue
      out.push({ outbox: outboxRow(row), intent })
    }
    return out
  })
}

export async function markReconciledRetry(
  claim: ManagedActionOutboxClaim,
  reason: string,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='PENDING',last_error=$2,lease_token=NULL,
         lease_until=NULL,next_attempt_at=$1,updated_at=$1
       WHERE id=$3 AND status='UNCERTAIN'
       RETURNING *`,
      [now, reason, claim.outbox.id],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox 已不在 UNCERTAIN 状态'))
    if (claim.outbox.permit_id !== null) {
      await c.query(
        `UPDATE managed_execution_permit SET status='REVOKED'
         WHERE id=$1 AND status='VALID'`,
        [claim.outbox.permit_id],
      )
    }
    await c.query(
      `UPDATE managed_ticket_task SET status='WAITING_GATEWAY',last_error=NULL,updated_at=$1
       WHERE id=$2 AND status='PAUSED'`,
      [now, claim.intent.task_id],
    )
    await ticketEvent(c, claim.intent.task_id, 'ManagedActionReconciledRetry', {
      outboxId: claim.outbox.id,
      reason,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function markReconciledFailure(
  claim: ManagedActionOutboxClaim,
  error: string,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='FAILED',last_error=$2,lease_token=NULL,
         lease_until=NULL,updated_at=$1
       WHERE id=$3 AND status='UNCERTAIN'
       RETURNING *`,
      [now, error, claim.outbox.id],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox 已不在 UNCERTAIN 状态'))
    if (claim.outbox.permit_id !== null) {
      await c.query(
        `UPDATE managed_execution_permit SET status='REVOKED'
         WHERE id=$1 AND status='VALID'`,
        [claim.outbox.permit_id],
      )
    }
    await c.query(
      `UPDATE managed_ticket_task SET status='PAUSED',last_error=$2,updated_at=$1
       WHERE id=$3 AND status='PAUSED'`,
      [now, `ACTION_UNCERTAIN: ${error}`, claim.intent.task_id],
    )
    await ticketEvent(c, claim.intent.task_id, 'ManagedActionReconciledFailure', {
      outboxId: claim.outbox.id,
      error,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function markReconciledSuccess(
  claim: ManagedActionOutboxClaim,
  pullRequest: { readonly number: number; readonly url: string; readonly created: boolean },
  now: string,
  deadlineAt = new Date(Date.parse(now) + 30 * 60_000).toISOString(),
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const result = {
      pull_request: {
        number: pullRequest.number,
        url: pullRequest.url,
        created: pullRequest.created,
      },
      reconciled: true,
    }
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='SUCCEEDED',remote_kind='pull_request',
         remote_id=$2,remote_url=$3,result=$4::jsonb,lease_token=NULL,lease_until=NULL,
         last_error=NULL,updated_at=$1
       WHERE id=$5 AND status='UNCERTAIN'
       RETURNING *`,
      [now, String(pullRequest.number), pullRequest.url, JSON.stringify(result), claim.outbox.id],
    )
    if (updated.rows[0] === undefined)
      return err(makeError('CONFLICT', 'action outbox 已不在 UNCERTAIN 状态'))
    if (claim.outbox.permit_id === null)
      throw makeError('CONFLICT', 'UNCERTAIN action 缺少 ExecutionPermit')
    const permit = await getExecutionPermit(claim.outbox.permit_id, c)
    if (permit === null) throw makeError('NOT_FOUND', '找不到 ExecutionPermit')
    await insertCheckTarget(c, permit, claim.intent, pullRequest, deadlineAt, now)
    if (claim.outbox.permit_id !== null) {
      await c.query(
        `UPDATE managed_execution_permit SET status='CONSUMED'
         WHERE id=$1 AND status IN ('VALID','EXPIRED')`,
        [claim.outbox.permit_id],
      )
    }
    await c.query(
      `UPDATE managed_ticket_task SET status='PR_OPENED',
         handoff=COALESCE(handoff,'{}'::jsonb) || $2::jsonb,last_error=NULL,updated_at=$1
       WHERE id=$3 AND status IN ('WAITING_GATEWAY','PAUSED')`,
      [
        now,
        JSON.stringify({
          pull_request: result.pull_request,
          completion_target: 'pr_ready',
          reconciled: true,
        }),
        claim.intent.task_id,
      ],
    )
    await ticketEvent(c, claim.intent.task_id, 'ManagedActionReconciledSuccess', {
      outboxId: claim.outbox.id,
      pullRequest: result.pull_request,
    })
    return ok(outboxRow(updated.rows[0]))
  })
}

export async function retryAction(
  outboxId: string,
  now: string,
): Promise<Result<ManagedActionOutboxRecord>> {
  return asRole('keel_control', async (c) => {
    const row = await c.query<Record<string, unknown>>(
      'SELECT * FROM managed_action_outbox WHERE id=$1 FOR UPDATE',
      [outboxId],
    )
    const outbox = row.rows[0]
    if (outbox === undefined) return err(makeError('NOT_FOUND', '找不到 action outbox'))
    if (outbox.status !== 'BLOCKED' && outbox.status !== 'FAILED')
      return err(makeError('CONFLICT', `action outbox 当前是 ${String(outbox.status)}，不能重试`))
    const intent = await getActionIntent(String(outbox.action_intent_id), c)
    if (intent === null) return err(makeError('NOT_FOUND', '找不到 action intent'))
    const updated = await c.query<Record<string, unknown>>(
      `UPDATE managed_action_outbox SET status='PENDING',last_error=NULL,lease_token=NULL,
         lease_until=NULL,permit_id=NULL,next_attempt_at=$1,updated_at=$1
       WHERE id=$2 RETURNING *`,
      [now, outboxId],
    )
    if (outbox.permit_id !== null) {
      await c.query(
        `UPDATE managed_execution_permit SET status='REVOKED'
         WHERE id=$1 AND status='VALID'`,
        [outbox.permit_id],
      )
    }
    await c.query(
      `UPDATE managed_ticket_task SET status='WAITING_GATEWAY',last_error=NULL,updated_at=$1
       WHERE id=$2`,
      [now, intent.task_id],
    )
    await ticketEvent(c, intent.task_id, 'ManagedActionRetryRequested', { outboxId })
    return ok(outboxRow(updated.rows[0] as Record<string, unknown>))
  })
}

export async function listActions(taskId?: string): Promise<
  readonly (ManagedActionOutboxRecord & {
    readonly action: string
    readonly head_branch: string
    readonly head_sha: string
    readonly pr_title: string
  })[]
> {
  return asRole('keel_control', async (c) => {
    const rows = await c.query<Record<string, unknown>>(
      `SELECT o.*,i.action,i.head_branch,i.head_sha,i.pr_title
       FROM managed_action_outbox o JOIN managed_action_intent i ON i.id=o.action_intent_id
       WHERE ($1::uuid IS NULL OR i.task_id=$1)
       ORDER BY o.created_at DESC`,
      [taskId ?? null],
    )
    return rows.rows.map((row) => ({
      ...outboxRow(row),
      action: String(row.action),
      head_branch: String(row.head_branch),
      head_sha: String(row.head_sha),
      pr_title: String(row.pr_title),
    }))
  })
}
