import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  ManagedTicketTask,
  ManagedWorkflow,
  ManagedWorkflowEvidence,
  ManagedWorkflowGraph,
  ManagedWorkflowNode,
  ManagedWorkflowNodeStatus,
  ManagedWorkflowStatus,
} from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'

export interface ManagedWorkflowClaim {
  readonly workflow: ManagedWorkflow
  readonly token: string
  readonly attempt: number
}

export async function workflowEvent(
  c: PoolClient,
  workflowId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await c.query(
    'INSERT INTO managed_workflow_event(workflow_id,type,payload) VALUES($1,$2,$3::jsonb)',
    [workflowId, type, JSON.stringify(payload)],
  )
}

export async function getManagedWorkflow(id: string): Promise<ManagedWorkflow | null> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedWorkflow>('SELECT * FROM managed_workflow WHERE id=$1', [id]),
  )
  return result.rows[0] ?? null
}

export async function getManagedWorkflowInTx(
  c: PoolClient,
  id: string,
): Promise<ManagedWorkflow | null> {
  const result = await c.query<ManagedWorkflow>('SELECT * FROM managed_workflow WHERE id=$1', [id])
  return result.rows[0] ?? null
}

export async function listManagedWorkflows(): Promise<readonly ManagedWorkflow[]> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedWorkflow>('SELECT * FROM managed_workflow ORDER BY updated_at DESC'),
  )
  return result.rows
}

export async function listWorkflowNodes(
  workflowId: string,
  graphVersion?: number,
): Promise<readonly ManagedWorkflowNode[]> {
  return asRole('keel_control', (c) => listWorkflowNodesInTx(c, workflowId, graphVersion))
}

export async function listWorkflowNodesInTx(
  c: PoolClient,
  workflowId: string,
  graphVersion?: number,
): Promise<readonly ManagedWorkflowNode[]> {
  const result = await c.query<ManagedWorkflowNode>(
    `SELECT * FROM managed_workflow_node
     WHERE workflow_id=$1 AND ($2::int IS NULL OR graph_version=$2)
     ORDER BY node_key`,
    [workflowId, graphVersion ?? null],
  )
  return result.rows
}

export async function getWorkflowGraph(
  workflowId: string,
  version?: number,
): Promise<ManagedWorkflowGraph | null> {
  const result = await asRole('keel_control', async (c) => {
    const workflow = await getManagedWorkflowInTx(c, workflowId)
    if (workflow === null) return null
    const target = version ?? workflow.current_graph_version
    return (
      (
        await c.query<ManagedWorkflowGraph>(
          'SELECT * FROM managed_workflow_graph WHERE workflow_id=$1 AND version=$2',
          [workflowId, target],
        )
      ).rows[0] ?? null
    )
  })
  return result
}

export async function listWorkflowEvidence(
  workflowId: string,
): Promise<readonly ManagedWorkflowEvidence[]> {
  const result = await asRole('keel_control', (c) =>
    c.query<ManagedWorkflowEvidence>(
      'SELECT * FROM managed_workflow_evidence WHERE workflow_id=$1 ORDER BY created_at DESC',
      [workflowId],
    ),
  )
  return result.rows
}

export async function claimManagedWorkflow(
  now: string,
  workflowId?: string,
): Promise<ManagedWorkflowClaim | null> {
  return asRole('keel_control', async (c) => {
    const candidates = await c.query<ManagedWorkflow>(
      `SELECT w.* FROM managed_workflow w
       JOIN (
         SELECT DISTINCT ON (candidate.repo_id) candidate.id
         FROM managed_workflow candidate
         WHERE ($1::uuid IS NULL OR candidate.id=$1)
           AND (
             candidate.status IN ('ROUTING','READY')
             OR (candidate.status='RUNNING' AND candidate.lease_until <= clock_timestamp())
             OR (candidate.status='WAITING_HUMAN' AND EXISTS (
               SELECT 1 FROM managed_workflow_node n
               JOIN managed_ticket_task t ON t.id=n.ticket_task_id
               WHERE n.workflow_id=candidate.id
                 AND n.graph_version=candidate.current_graph_version
                 AND t.status IN (
                   'READY','RUNNING','PR_READY','DONE','PAUSED','PR_CHECKS_FAILED',
                   'FAILED','CANCELLED'
                 )
             ))
             OR (candidate.status='WAITING_GATEWAY' AND EXISTS (
               SELECT 1 FROM managed_workflow_node n
               JOIN managed_ticket_task t ON t.id=n.ticket_task_id
               WHERE n.workflow_id=candidate.id
                 AND n.graph_version=candidate.current_graph_version
                 AND (
                   t.status IN ('PR_READY','DONE','PAUSED','PR_CHECKS_FAILED','FAILED','CANCELLED')
                   OR (candidate.completion_target='branch_ready' AND t.status='WAITING_GATEWAY')
                 )
             ))
           )
         ORDER BY candidate.repo_id,candidate.updated_at,candidate.id
       ) fair ON fair.id=w.id
       ORDER BY w.updated_at,w.id
       FOR UPDATE OF w SKIP LOCKED
       LIMIT 1`,
      [workflowId ?? null],
    )
    const workflow = candidates.rows[0]
    if (workflow === undefined) return null
    const resumed = workflow.status === 'WAITING_HUMAN' || workflow.status === 'WAITING_GATEWAY'
    if (workflow.status === 'RUNNING') {
      await workflowEvent(c, workflow.id, 'ManagedWorkflowLeaseExpired', {
        token: workflow.lease_token,
      })
    }
    if (!resumed && workflow.attempts >= workflow.max_attempts) {
      await c.query(
        `UPDATE managed_workflow SET status='FAILED',last_error='managed workflow attempt budget exhausted',
           lease_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1`,
        [workflow.id, now],
      )
      await workflowEvent(c, workflow.id, 'ManagedWorkflowBudgetExhausted', {})
      return null
    }
    const token = randomUUID()
    const attempt = resumed ? workflow.attempts : workflow.attempts + 1
    await c.query(
      `UPDATE managed_workflow SET status='RUNNING',lease_token=$2,
         lease_until=clock_timestamp() + interval '300 seconds',
         attempts=$4,last_error=NULL,updated_at=$3 WHERE id=$1`,
      [workflow.id, token, now, attempt],
    )
    await workflowEvent(
      c,
      workflow.id,
      resumed ? 'ManagedWorkflowResumed' : 'ManagedWorkflowAttemptStarted',
      { attempt, token, from: workflow.status },
    )
    return {
      workflow: { ...workflow, status: 'RUNNING', lease_token: token, attempts: attempt },
      token,
      attempt,
    }
  })
}

export async function withManagedWorkflowClaim<T>(
  claim: ManagedWorkflowClaim,
  fn: (c: PoolClient) => Promise<T>,
): Promise<Result<T>> {
  return asRole('keel_control', async (c) => {
    const locked = await c.query(
      `SELECT id FROM managed_workflow
       WHERE id=$1 AND status='RUNNING' AND lease_token=$2 AND lease_until > clock_timestamp()
       FOR UPDATE`,
      [claim.workflow.id, claim.token],
    )
    if (locked.rowCount !== 1)
      return err(makeError('CONFLICT', 'managed workflow lease 已过期或被其他 worker 替代'))
    return ok(await fn(c))
  })
}

export async function unlockWorkflow(
  c: PoolClient,
  workflowId: string,
  status: ManagedWorkflowStatus,
  lastError: string | null,
): Promise<void> {
  await c.query(
    `UPDATE managed_workflow SET status=$2,last_error=$3,
       lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
    [workflowId, status, lastError],
  )
}

export async function setWorkflowStatus(
  workflowId: string,
  status: ManagedWorkflowStatus,
  lastError: string | null = null,
): Promise<void> {
  await asRole('keel_control', (c) => unlockWorkflow(c, workflowId, status, lastError))
}

export async function attachNodeTicket(
  c: PoolClient,
  nodeId: string,
  ticket: {
    readonly task_id: string
    readonly base_commit: string
    readonly worktree_path: string
  },
): Promise<void> {
  await c.query(
    `UPDATE managed_workflow_node
     SET ticket_task_id=$2,base_commit=$3,worktree_path=$4,status='READY',
       last_error=NULL,updated_at=now()
     WHERE id=$1`,
    [nodeId, ticket.task_id, ticket.base_commit, ticket.worktree_path],
  )
}

export async function setNodeStatus(
  c: PoolClient,
  nodeId: string,
  status: ManagedWorkflowNodeStatus,
  extra: {
    readonly outputCommit?: string | null
    readonly lastError?: string | null
  } = {},
): Promise<void> {
  await c.query(
    `UPDATE managed_workflow_node SET status=$2,
       output_commit=COALESCE($3,output_commit),
       last_error=$4,updated_at=now()
     WHERE id=$1`,
    [nodeId, status, extra.outputCommit ?? null, extra.lastError ?? null],
  )
}

export function nodeStatusForTicket(task: ManagedTicketTask): {
  readonly status: ManagedWorkflowNodeStatus
  readonly outputCommit: string | null
  readonly lastError: string | null
} {
  switch (task.status) {
    case 'READY':
    case 'RUNNING':
      return { status: 'READY', outputCommit: null, lastError: task.last_error }
    case 'WAITING_HUMAN':
      return { status: 'WAITING_HUMAN', outputCommit: null, lastError: task.last_error }
    case 'WAITING_GATEWAY':
    case 'PR_OPENED':
    case 'CHECKING':
      return { status: 'WAITING_GATEWAY', outputCommit: null, lastError: task.last_error }
    case 'PR_READY':
      return {
        status: 'PR_READY',
        outputCommit:
          typeof task.handoff === 'object' && task.handoff !== null && 'head_sha' in task.handoff
            ? String((task.handoff as { head_sha?: unknown }).head_sha)
            : null,
        lastError: null,
      }
    case 'DONE':
      return {
        status: 'PR_READY',
        outputCommit:
          typeof task.handoff === 'object' && task.handoff !== null && 'head_sha' in task.handoff
            ? String((task.handoff as { head_sha?: unknown }).head_sha)
            : null,
        lastError: null,
      }
    case 'PAUSED':
    case 'PR_CHECKS_FAILED':
      return { status: 'FAILED', outputCommit: null, lastError: task.last_error }
    case 'FAILED':
    case 'CANCELLED':
      return { status: task.status, outputCommit: null, lastError: task.last_error }
  }
}

export interface EvidenceInput {
  readonly workflow_id: string
  readonly graph_version: number
  readonly node_id: string
  readonly source_node_id?: string
  readonly stage: ManagedWorkflowEvidence['stage']
  readonly input_commit: string
  readonly diff_digest: string
  readonly stage_digest: string
  readonly branch: string
  readonly target_digest: string
  readonly result_digest: string
  readonly evidence_digest: string
  readonly result: unknown
  readonly evidence: unknown
}

export async function insertWorkflowEvidence(
  c: PoolClient,
  input: EvidenceInput,
): Promise<ManagedWorkflowEvidence> {
  const id = randomUUID()
  const row = await c.query<ManagedWorkflowEvidence>(
    `INSERT INTO managed_workflow_evidence(
       id,workflow_id,graph_version,node_id,source_node_id,stage,input_commit,diff_digest,
       stage_digest,branch,target_digest,result_digest,evidence_digest,result,evidence
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
     ON CONFLICT (workflow_id, stage, target_digest) WHERE status='VALID' DO NOTHING
     RETURNING *`,
    [
      id,
      input.workflow_id,
      input.graph_version,
      input.node_id,
      input.source_node_id ?? null,
      input.stage,
      input.input_commit,
      input.diff_digest,
      input.stage_digest,
      input.branch,
      input.target_digest,
      input.result_digest,
      input.evidence_digest,
      JSON.stringify(input.result),
      JSON.stringify(input.evidence),
    ],
  )
  if (row.rows[0] !== undefined) return row.rows[0]
  const existing = await c.query<ManagedWorkflowEvidence>(
    `SELECT * FROM managed_workflow_evidence
     WHERE workflow_id=$1 AND stage=$2 AND target_digest=$3 AND status='VALID'
     LIMIT 1`,
    [input.workflow_id, input.stage, input.target_digest],
  )
  if (existing.rows[0] === undefined)
    throw makeError('CONFLICT', 'workflow evidence 未写入且找不到既有记录')
  return existing.rows[0]
}

export async function findReusableWorkflowEvidence(
  c: PoolClient,
  workflowId: string,
  stage: ManagedWorkflowEvidence['stage'],
  targetDigest: string,
): Promise<ManagedWorkflowEvidence | null> {
  const row = await c.query<ManagedWorkflowEvidence>(
    `SELECT * FROM managed_workflow_evidence
     WHERE workflow_id=$1 AND stage=$2 AND target_digest=$3 AND status='VALID'
     LIMIT 1`,
    [workflowId, stage, targetDigest],
  )
  return row.rows[0] ?? null
}

export async function invalidateNodeEvidence(
  c: PoolClient,
  workflowId: string,
  nodeId: string,
  reason: string,
  stages?: readonly ManagedWorkflowEvidence['stage'][],
): Promise<void> {
  await c.query(
    `UPDATE managed_workflow_evidence
     SET status='INVALIDATED',invalidated_reason=$3,invalidated_at=now()
     WHERE workflow_id=$1 AND node_id=$2 AND status='VALID'
       AND ($4::text[] IS NULL OR stage = ANY($4::text[]))`,
    [workflowId, nodeId, reason, stages === undefined ? null : [...stages]],
  )
}

export async function findLegacyIssueConflict(repoId: string, issueRef: string): Promise<boolean> {
  return asRole('keel_control', async (c) => {
    const row = await c.query(
      `SELECT 1
       FROM task t
       JOIN task_feedback tf ON tf.task_id=t.id
       JOIN feedback f ON f.id=tf.feedback_id
       WHERE t.repo_id=$1 AND f.external_ref=$2
       LIMIT 1`,
      [repoId, issueRef],
    )
    return row.rowCount === 1
  })
}

export async function claimIssue(
  c: PoolClient,
  input: {
    readonly repo_id: string
    readonly issue_ref: string
    readonly owner_kind: 'managed_workflow' | 'managed_node'
    readonly owner_id: string
  },
): Promise<Result<true>> {
  try {
    await c.query(
      `INSERT INTO managed_issue_claim(id,repo_id,issue_ref,owner_kind,owner_id)
       VALUES($1,$2,$3,$4,$5)`,
      [randomUUID(), input.repo_id, input.issue_ref, input.owner_kind, input.owner_id],
    )
    return ok(true)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return err(makeError('CONFLICT', `issue 已被另一个执行引擎占用：${input.issue_ref}`))
    }
    throw error
  }
}

export async function releaseIssueClaims(
  c: PoolClient,
  ownerKind: 'managed_workflow' | 'managed_node',
  ownerId: string,
): Promise<void> {
  await c.query(
    `UPDATE managed_issue_claim SET status='RELEASED',released_at=now()
     WHERE owner_kind=$1 AND owner_id=$2 AND status='ACTIVE'`,
    [ownerKind, ownerId],
  )
}
