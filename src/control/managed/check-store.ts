import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, type KeelError, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedTicketTask } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import type { ManagedActionIntent, ManagedExecutionPermit } from '../../generated/managed.js'
import { ticketEvent } from './ticket-store.js'

export type ManagedCheckTargetStatus = 'PENDING' | 'CHECKING' | 'READY' | 'FAILED'
export type ManagedCheckSource = 'check_run' | 'commit_status' | 'none'

export interface ManagedCheckTargetRecord {
  readonly id: string
  readonly action_intent_id: string
  readonly permit_id: string
  readonly task_id: string
  readonly project_id: string
  readonly repo_id: string
  readonly remote_url: string
  readonly base_branch: string
  readonly head_branch: string
  readonly head_sha: string
  readonly diff_digest: string
  readonly authorization_id: string
  readonly authorization_version: number
  readonly pr_number: number
  readonly pr_url: string
  readonly required_checks: readonly string[]
  readonly status: ManagedCheckTargetStatus
  readonly lease_token: string | null
  readonly lease_until: string | null
  readonly attempts: number
  readonly next_attempt_at: string | null
  readonly last_observed_at: string | null
  readonly deadline_at: string
  readonly evidence_digest: string | null
  readonly last_error: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface ManagedCheckObservationRecord {
  readonly id: string
  readonly target_id: string
  readonly attempt: number
  readonly repo: string
  readonly repo_url: string
  readonly pr_number: number
  readonly pr_url: string
  readonly pr_state: 'open' | 'closed'
  readonly head_branch: string
  readonly base_branch: string
  readonly head_sha: string
  readonly check_name: string
  readonly source: ManagedCheckSource
  readonly conclusion: string
  readonly external_id: string | null
  readonly details_url: string | null
  readonly observed_at: string
  readonly created_at: string
}

export interface ManagedCheckObservationDraft {
  readonly repo: string
  readonly repoUrl: string
  readonly prNumber: number
  readonly prUrl: string
  readonly prState: 'open' | 'closed'
  readonly headBranch: string
  readonly baseBranch: string
  readonly headSha: string
  readonly checkName: string
  readonly source: ManagedCheckSource
  readonly conclusion: string
  readonly externalId: string | null
  readonly detailsUrl: string | null
  readonly observedAt: string
}

export interface ManagedCheckClaim {
  readonly target: ManagedCheckTargetRecord
  readonly task: ManagedTicketTask
}

export interface ManagedCheckEvidenceView {
  readonly target: ManagedCheckTargetRecord
  readonly observations: readonly ManagedCheckObservationRecord[]
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : value
}

function requiredChecks(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string'))
    throw makeError('PROTOCOL_ERROR', 'check target required_checks 不是字符串数组')
  return value
}

function targetRow(row: Record<string, unknown>): ManagedCheckTargetRecord {
  return {
    id: String(row.id),
    action_intent_id: String(row.action_intent_id),
    permit_id: String(row.permit_id),
    task_id: String(row.task_id),
    project_id: String(row.project_id),
    repo_id: String(row.repo_id),
    remote_url: String(row.remote_url),
    base_branch: String(row.base_branch),
    head_branch: String(row.head_branch),
    head_sha: String(row.head_sha),
    diff_digest: String(row.diff_digest),
    authorization_id: String(row.authorization_id),
    authorization_version: Number(row.authorization_version),
    pr_number: Number(row.pr_number),
    pr_url: String(row.pr_url),
    required_checks: requiredChecks(row.required_checks),
    status: row.status as ManagedCheckTargetStatus,
    lease_token: row.lease_token === null ? null : String(row.lease_token),
    lease_until: iso(row.lease_until as Date | string | null),
    attempts: Number(row.attempts),
    next_attempt_at: iso(row.next_attempt_at as Date | string | null),
    last_observed_at: iso(row.last_observed_at as Date | string | null),
    deadline_at: iso(row.deadline_at as Date | string) ?? String(row.deadline_at),
    evidence_digest: row.evidence_digest === null ? null : String(row.evidence_digest),
    last_error: row.last_error === null ? null : String(row.last_error),
    created_at: iso(row.created_at as Date | string) ?? String(row.created_at),
    updated_at: iso(row.updated_at as Date | string) ?? String(row.updated_at),
  }
}

function observationRow(row: Record<string, unknown>): ManagedCheckObservationRecord {
  return {
    id: String(row.id),
    target_id: String(row.target_id),
    attempt: Number(row.attempt),
    repo: String(row.repo),
    repo_url: String(row.repo_url),
    pr_number: Number(row.pr_number),
    pr_url: String(row.pr_url),
    pr_state: row.pr_state as 'open' | 'closed',
    head_branch: String(row.head_branch),
    base_branch: String(row.base_branch),
    head_sha: String(row.head_sha),
    check_name: String(row.check_name),
    source: row.source as ManagedCheckSource,
    conclusion: String(row.conclusion),
    external_id: row.external_id === null ? null : String(row.external_id),
    details_url: row.details_url === null ? null : String(row.details_url),
    observed_at: iso(row.observed_at as Date | string) ?? String(row.observed_at),
    created_at: iso(row.created_at as Date | string) ?? String(row.created_at),
  }
}

export async function insertCheckTarget(
  c: PoolClient,
  permit: ManagedExecutionPermit,
  intent: ManagedActionIntent,
  pullRequest: { readonly number: number; readonly url: string },
  deadlineAt: string,
  now: string,
): Promise<string> {
  const id = randomUUID()
  await c.query(
    `INSERT INTO managed_check_target(
      id,action_intent_id,permit_id,task_id,project_id,repo_id,remote_url,
      base_branch,head_branch,head_sha,diff_digest,authorization_id,authorization_version,
      pr_number,pr_url,required_checks,status,next_attempt_at,deadline_at,created_at,updated_at
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
      'PENDING',$17,$18,$17,$17
    )`,
    [
      id,
      intent.id,
      permit.id,
      intent.task_id,
      intent.project_id,
      intent.repo_id,
      intent.remote_url,
      intent.base_branch,
      intent.head_branch,
      permit.expected_sha,
      permit.diff_digest,
      permit.authorization.id,
      permit.authorization.version,
      pullRequest.number,
      pullRequest.url,
      JSON.stringify(permit.required_checks),
      now,
      deadlineAt,
    ],
  )
  return id
}

export async function claimCheckTarget(
  now: string,
  leaseMs = 120_000,
): Promise<ManagedCheckClaim | null> {
  return asRole('keel_control', async (c) => {
    const row = (
      await c.query<Record<string, unknown>>(
        `SELECT t.* FROM managed_check_target t
         JOIN managed_ticket_task task ON task.id=t.task_id
         WHERE t.status IN ('PENDING','CHECKING')
           AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= $1)
           AND (t.lease_until IS NULL OR t.lease_until <= $1)
           AND task.status IN ('PR_OPENED','CHECKING')
         ORDER BY t.created_at,t.id
         FOR UPDATE OF t SKIP LOCKED
         LIMIT 1`,
        [now],
      )
    ).rows[0]
    if (row === undefined) return null
    const previous = row.status as ManagedCheckTargetStatus
    const leaseToken = randomUUID()
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
    const updated = (
      await c.query<Record<string, unknown>>(
        `UPDATE managed_check_target
         SET status='CHECKING',lease_token=$2,lease_until=$3,attempts=attempts+1,updated_at=$1
         WHERE id=$4
         RETURNING *`,
        [now, leaseToken, leaseUntil, row.id],
      )
    ).rows[0]
    if (updated === undefined) throw makeError('CONFLICT', 'check target 认领失败')
    const task = (
      await c.query<ManagedTicketTask>(
        `UPDATE managed_ticket_task
         SET status='CHECKING',lease_token=NULL,lease_until=NULL,updated_at=$1
         WHERE id=$2 AND status IN ('PR_OPENED','CHECKING')
         RETURNING *`,
        [now, row.task_id],
      )
    ).rows[0]
    if (task === undefined) throw makeError('CONFLICT', 'ticket task 已不等待 check')
    if (previous === 'PENDING') {
      await ticketEvent(c, task.id, 'ManagedChecksStarted', {
        targetId: String(row.id),
        attempt: Number(updated.attempts),
        prNumber: Number(updated.pr_number),
        headSha: String(updated.head_sha),
      })
    }
    return { target: targetRow(updated), task }
  })
}

async function insertObservations(
  c: PoolClient,
  claim: ManagedCheckClaim,
  observations: readonly ManagedCheckObservationDraft[],
): Promise<void> {
  for (const observation of observations) {
    await c.query(
      `INSERT INTO managed_check_observation(
        id,target_id,attempt,repo,repo_url,pr_number,pr_url,pr_state,head_branch,
        base_branch,head_sha,check_name,source,conclusion,external_id,details_url,observed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (target_id,attempt,check_name,source) DO NOTHING`,
      [
        randomUUID(),
        claim.target.id,
        claim.target.attempts,
        observation.repo,
        observation.repoUrl,
        observation.prNumber,
        observation.prUrl,
        observation.prState,
        observation.headBranch,
        observation.baseBranch,
        observation.headSha,
        observation.checkName,
        observation.source,
        observation.conclusion,
        observation.externalId,
        observation.detailsUrl,
        observation.observedAt,
      ],
    )
  }
}

async function lockLease(
  c: PoolClient,
  claim: ManagedCheckClaim,
): Promise<Record<string, unknown>> {
  const row = (
    await c.query<Record<string, unknown>>(
      `SELECT * FROM managed_check_target
       WHERE id=$1 AND status='CHECKING' AND lease_token=$2
       FOR UPDATE`,
      [claim.target.id, claim.target.lease_token],
    )
  ).rows[0]
  if (row === undefined) throw makeError('CONFLICT', 'check target lease 已过期')
  return row
}

function resultError(cause: unknown): KeelError {
  if (typeof cause === 'object' && cause !== null && 'kind' in cause) {
    const kind = cause.kind
    const detail = 'detail' in cause ? cause.detail : undefined
    if (typeof kind === 'string' && typeof detail === 'string')
      return { ...(cause as KeelError), kind: kind as KeelError['kind'], detail }
  }
  throw cause
}

export async function deferCheck(
  claim: ManagedCheckClaim,
  observations: readonly ManagedCheckObservationDraft[],
  nextAttemptAt: string,
  error: string | null,
  now: string,
): Promise<Result<ManagedCheckTargetRecord>> {
  try {
    return ok(
      await asRole('keel_control', async (c) => {
        await lockLease(c, claim)
        await insertObservations(c, claim, observations)
        const updated = (
          await c.query<Record<string, unknown>>(
            `UPDATE managed_check_target
             SET last_observed_at=COALESCE($3::timestamptz,$4::timestamptz),last_error=$5,
               next_attempt_at=$2,
               lease_token=NULL,lease_until=NULL,updated_at=$1
             WHERE id=$6 AND status='CHECKING' AND lease_token=$7
             RETURNING *`,
            [
              now,
              nextAttemptAt,
              observations[0]?.observedAt ?? null,
              now,
              error,
              claim.target.id,
              claim.target.lease_token,
            ],
          )
        ).rows[0]
        if (updated === undefined) throw makeError('CONFLICT', 'check target lease 已过期')
        await c.query(
          `UPDATE managed_ticket_task SET last_error=$2,updated_at=$1
           WHERE id=$3 AND status='CHECKING'`,
          [now, error === null ? null : `CHECK_PENDING: ${error}`, claim.target.task_id],
        )
        await ticketEvent(c, claim.target.task_id, 'ManagedChecksPending', {
          targetId: claim.target.id,
          attempt: claim.target.attempts,
          prNumber: claim.target.pr_number,
          headSha: claim.target.head_sha,
          checks: observations.map((item) => ({
            name: item.checkName,
            source: item.source,
            conclusion: item.conclusion,
            observedAt: item.observedAt,
          })),
          error,
        })
        return targetRow(updated)
      }),
    )
  } catch (cause) {
    return err(resultError(cause))
  }
}

export async function finalizeCheckReady(
  claim: ManagedCheckClaim,
  observations: readonly ManagedCheckObservationDraft[],
  evidenceDigest: string,
  handoff: unknown,
  now: string,
): Promise<Result<ManagedCheckTargetRecord>> {
  try {
    return ok(
      await asRole('keel_control', async (c) => {
        await lockLease(c, claim)
        await insertObservations(c, claim, observations)
        const updated = (
          await c.query<Record<string, unknown>>(
            `UPDATE managed_check_target
             SET status='READY',last_observed_at=$2,evidence_digest=$3,last_error=NULL,
               next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=$1
             WHERE id=$4 AND status='CHECKING' AND lease_token=$5
             RETURNING *`,
            [now, now, evidenceDigest, claim.target.id, claim.target.lease_token],
          )
        ).rows[0]
        if (updated === undefined) throw makeError('CONFLICT', 'check target lease 已过期')
        const task = await c.query(
          `UPDATE managed_ticket_task
           SET status='PR_READY',last_error=NULL,
             handoff=COALESCE(handoff,'{}'::jsonb) || $2::jsonb,updated_at=$1
           WHERE id=$3 AND status='CHECKING'`,
          [now, JSON.stringify(handoff), claim.target.task_id],
        )
        if (task.rowCount !== 1) throw makeError('CONFLICT', 'ticket task 不在 CHECKING')
        await ticketEvent(c, claim.target.task_id, 'ManagedChecksPassed', {
          targetId: claim.target.id,
          attempt: claim.target.attempts,
          prNumber: claim.target.pr_number,
          headSha: claim.target.head_sha,
          evidenceDigest,
        })
        return targetRow(updated)
      }),
    )
  } catch (cause) {
    return err(resultError(cause))
  }
}

export async function finalizeCheckFailed(
  claim: ManagedCheckClaim,
  observations: readonly ManagedCheckObservationDraft[],
  error: string,
  handoff: unknown,
  now: string,
): Promise<Result<ManagedCheckTargetRecord>> {
  try {
    return ok(
      await asRole('keel_control', async (c) => {
        await lockLease(c, claim)
        await insertObservations(c, claim, observations)
        const updated = (
          await c.query<Record<string, unknown>>(
            `UPDATE managed_check_target
             SET status='FAILED',
               last_observed_at=COALESCE($3::timestamptz,$4::timestamptz),last_error=$2,
               next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=$1
             WHERE id=$5 AND status='CHECKING' AND lease_token=$6
             RETURNING *`,
            [
              now,
              error,
              observations[0]?.observedAt ?? null,
              now,
              claim.target.id,
              claim.target.lease_token,
            ],
          )
        ).rows[0]
        if (updated === undefined) throw makeError('CONFLICT', 'check target lease 已过期')
        const task = await c.query(
          `UPDATE managed_ticket_task
           SET status='PR_CHECKS_FAILED',last_error=$2,
             handoff=COALESCE(handoff,'{}'::jsonb) || $3::jsonb,updated_at=$1
           WHERE id=$4 AND status='CHECKING'`,
          [now, `CHECK_FAILED: ${error}`, JSON.stringify(handoff), claim.target.task_id],
        )
        if (task.rowCount !== 1) throw makeError('CONFLICT', 'ticket task 不在 CHECKING')
        await ticketEvent(c, claim.target.task_id, 'ManagedChecksFailed', {
          targetId: claim.target.id,
          attempt: claim.target.attempts,
          prNumber: claim.target.pr_number,
          headSha: claim.target.head_sha,
          error,
        })
        return targetRow(updated)
      }),
    )
  } catch (cause) {
    return err(resultError(cause))
  }
}

export async function listCheckEvidence(options: {
  readonly taskId?: string
  readonly targetId?: string
}): Promise<readonly ManagedCheckEvidenceView[]> {
  return asRole('keel_control', async (c) => {
    const targets = await c.query<Record<string, unknown>>(
      `SELECT * FROM managed_check_target
       WHERE ($1::uuid IS NULL OR task_id=$1)
         AND ($2::uuid IS NULL OR id=$2)
       ORDER BY created_at DESC`,
      [options.taskId ?? null, options.targetId ?? null],
    )
    const out: ManagedCheckEvidenceView[] = []
    for (const row of targets.rows) {
      const target = targetRow(row)
      const observations = await c.query<Record<string, unknown>>(
        `SELECT * FROM managed_check_observation
         WHERE target_id=$1
         ORDER BY attempt,check_name,source`,
        [target.id],
      )
      out.push({ target, observations: observations.rows.map(observationRow) })
    }
    return out
  })
}
