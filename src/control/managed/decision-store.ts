import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, type KeelError, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedQuestion, ManagedTask } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import type {
  DecisionRequest,
  DecisionResolution,
  DelegationPolicyVersion,
  ProjectDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { acceptDecision, type DecisionAcceptanceControl } from './decision-acceptor.js'
import {
  decisionRequestDigest,
  validateDecisionRequest,
  validateDecisionResolution,
  validateDelegationPolicy,
  validateProjectDecision,
  validateTianwenProposal,
} from './decision-protocol.js'

const TIANWEN_ACTOR_ID = 'tianwen-service'

const REQUEST_JSON = `jsonb_strip_nulls(to_jsonb(r)) AS body
  FROM (
    SELECT id, revision, '1.0'::text AS schema_version, idempotency_key,
      project_id, repo_id, managed_task_id, managed_question_id, task_id,
      node_id, attempt_id, decision_key, kind, question, options,
      suggested_option_id, constraints, missing_information, impact,
      action_category, workflow_digest, observed_memory_epoch, input_digest,
      status, expires_at, created_at
    FROM managed_decision_request
  ) r`

const DECISION_JSON = `jsonb_strip_nulls(to_jsonb(d)) AS body
  FROM (
    SELECT id, '1.0'::text AS schema_version, project_id, decision_key, version,
      statement, selected_option_id, options, scope, source_type, source_ref,
      created_by, valid_from, valid_until, supersedes_id, superseded_by,
      revoked_at, revoked_by, revocation_reason, created_at
    FROM managed_project_decision
  ) d`

const POLICY_JSON = `jsonb_strip_nulls(to_jsonb(p)) AS body, p.policy_id AS policy_key,
  p.version AS policy_version
  FROM (
    SELECT id, '1.0'::text AS schema_version, policy_id, version, project_id,
      approved_by_owner, approved_at, valid_from, valid_until, rules,
      supersedes_id, superseded_by, revoked_at, revoked_by,
      revocation_reason, created_at
    FROM managed_delegation_policy
  ) p`

export interface ManagedDecisionRequestInput {
  readonly decision_key: string
  readonly kind: DecisionRequest['kind']
  readonly action_category: string
  readonly impact: {
    readonly environment: DecisionRequest['impact']['environment']
    readonly reversibility: DecisionRequest['impact']['reversibility']
    readonly affected_resources: readonly string[]
  }
  readonly suggested_option_id?: string
  readonly constraints?: readonly string[]
  readonly missing_information?: readonly string[]
  readonly workflow_digest?: string
  readonly observed_memory_epoch?: number
  readonly attempt_id?: string
  readonly expires_at?: string
}

interface ManagedQuestionRow {
  readonly task_id: string
  readonly repo_id: string
  readonly question: string
  readonly options: unknown
  readonly question_status: string
  readonly task_status: string
  readonly pending_question_id: string | null
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function keelError(error: unknown): KeelError | null {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return null
  return typeof error.kind === 'string' ? (error as KeelError) : null
}

async function requestBody(
  c: PoolClient,
  id: string,
  revision: number,
): Promise<DecisionRequest | null> {
  const row = await c.query<{ body: unknown }>(
    `SELECT ${REQUEST_JSON} WHERE r.id=$1 AND r.revision=$2`,
    [id, revision],
  )
  return (row.rows[0]?.body as DecisionRequest | undefined) ?? null
}

async function decisionsForProject(c: PoolClient, projectId: string): Promise<ProjectDecision[]> {
  const rows = await c.query<{ body: unknown }>(
    `SELECT ${DECISION_JSON} WHERE d.project_id=$1 ORDER BY d.decision_key, d.version`,
    [projectId],
  )
  return rows.rows.map((row) => row.body as ProjectDecision)
}

async function currentPolicies(
  c: PoolClient,
  projectId: string,
): Promise<DelegationPolicyVersion[]> {
  const rows = await c.query<{ body: unknown }>(
    `SELECT DISTINCT ON (policy_key) ${POLICY_JSON}
     WHERE p.project_id=$1 AND p.revoked_at IS NULL AND p.superseded_by IS NULL
     ORDER BY policy_key, policy_version DESC`,
    [projectId],
  )
  return rows.rows.map((row) => row.body as DelegationPolicyVersion)
}

function optionList(options: readonly string[]): DecisionRequest['options'] {
  return options.map((text, index) => ({
    id: `option-${index + 1}`,
    text,
  })) as unknown as DecisionRequest['options']
}

export async function openDecisionRequestFromManagedQuestion(
  questionId: string,
  input: ManagedDecisionRequestInput,
  now: string,
  client?: PoolClient,
): Promise<Result<DecisionRequest>> {
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', 'created_at 不是合法时间'))
  const run = async (c: PoolClient): Promise<Result<DecisionRequest>> => {
    const existing = await c.query<{ body: unknown }>(
      `SELECT ${REQUEST_JSON} WHERE r.managed_question_id=$1
       ORDER BY r.revision DESC LIMIT 1`,
      [questionId],
    )
    if (existing.rows[0] !== undefined) return ok(existing.rows[0].body as DecisionRequest)

    const row = (
      await c.query<ManagedQuestionRow>(
        `SELECT q.task_id, t.repo_id, q.question, q.options,
           q.status AS question_status, t.status AS task_status,
           t.pending_question_id
         FROM managed_question q
         JOIN managed_task t ON t.id=q.task_id
         WHERE q.id=$1`,
        [questionId],
      )
    ).rows[0]
    if (row === undefined) return err(makeError('NOT_FOUND', '找不到 managed question'))
    if (
      row.question_status !== 'OPEN' ||
      row.task_status !== 'WAITING_TIANWEN' ||
      row.pending_question_id !== questionId
    )
      return err(makeError('CONFLICT', '该问题不是当前开放的天问请求'))
    if (!Array.isArray(row.options) || row.options.length < 2)
      return err(makeError('SCHEMA_VIOLATION', 'managed question 选项不足两个'))
    if (!row.options.every((option): option is string => typeof option === 'string'))
      return err(makeError('SCHEMA_VIOLATION', 'managed question 选项必须是字符串'))
    const options = optionList(row.options)
    if (
      input.suggested_option_id !== undefined &&
      !options.some((option) => option.id === input.suggested_option_id)
    )
      return err(makeError('SCHEMA_VIOLATION', '建议选项不在 managed question 选项内'))

    const request: DecisionRequest = {
      schema_version: '1.0',
      id: randomUUID(),
      revision: 1,
      idempotency_key: `managed-question:${questionId}`,
      project_id: row.repo_id,
      repo_id: row.repo_id,
      managed_task_id: row.task_id,
      managed_question_id: questionId,
      node_id: questionId,
      ...(input.attempt_id === undefined ? {} : { attempt_id: input.attempt_id }),
      decision_key: input.decision_key,
      kind: input.kind,
      question: row.question,
      options,
      constraints: [...(input.constraints ?? [])],
      missing_information: [...(input.missing_information ?? [])],
      impact: input.impact as unknown as DecisionRequest['impact'],
      action_category: input.action_category,
      input_digest: '',
      status: 'OPEN',
      created_at: now,
      ...(input.suggested_option_id === undefined
        ? {}
        : { suggested_option_id: input.suggested_option_id }),
      ...(input.workflow_digest === undefined ? {} : { workflow_digest: input.workflow_digest }),
      ...(input.observed_memory_epoch === undefined
        ? {}
        : { observed_memory_epoch: input.observed_memory_epoch }),
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    }
    request.input_digest = decisionRequestDigest(request)
    const checked = validateDecisionRequest(request)
    if (!checked.ok) return checked
    await c.query(
      `INSERT INTO managed_decision_request(
        id, revision, idempotency_key, project_id, repo_id, managed_task_id,
        managed_question_id, node_id, attempt_id, decision_key, kind, question, options,
        suggested_option_id, constraints, missing_information, impact,
        action_category, workflow_digest, observed_memory_epoch, input_digest,
        status, expires_at, created_at, updated_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,
        $16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$24
      ) ON CONFLICT DO NOTHING`,
      [
        request.id,
        request.revision,
        request.idempotency_key,
        request.project_id,
        request.repo_id,
        request.managed_task_id,
        request.managed_question_id,
        request.node_id,
        request.attempt_id ?? null,
        request.decision_key,
        request.kind,
        request.question,
        JSON.stringify(request.options),
        request.suggested_option_id ?? null,
        JSON.stringify(request.constraints),
        JSON.stringify(request.missing_information),
        JSON.stringify(request.impact),
        request.action_category,
        request.workflow_digest ?? null,
        request.observed_memory_epoch ?? null,
        request.input_digest,
        request.status,
        request.expires_at ?? null,
        request.created_at,
      ],
    )
    const persisted = await c.query<{ body: unknown }>(
      `SELECT ${REQUEST_JSON} WHERE r.managed_question_id=$1
       ORDER BY r.revision DESC LIMIT 1`,
      [questionId],
    )
    const body = persisted.rows[0]?.body
    if (body === undefined) throw new Error('decision request insert disappeared')
    return ok(body as DecisionRequest)
  }
  return client === undefined ? asRole('keel_control', run) : run(client)
}

export async function recordProjectDecision(
  decision: ProjectDecision,
): Promise<Result<ProjectDecision>> {
  const checked = validateProjectDecision(decision)
  if (!checked.ok) return checked
  if (!decision.options.some((option) => option.id === decision.selected_option_id))
    return err(makeError('SCHEMA_VIOLATION', 'selected_option_id 不在 options 内'))
  if (
    timestamp(decision.valid_from) === null ||
    (decision.valid_until !== undefined && timestamp(decision.valid_until) === null)
  )
    return err(makeError('SCHEMA_VIOLATION', '项目决定有效期不是合法时间'))
  if (
    decision.superseded_by !== undefined ||
    decision.revoked_at !== undefined ||
    decision.revoked_by !== undefined ||
    decision.revocation_reason !== undefined
  )
    return err(makeError('SCHEMA_VIOLATION', '新项目决定不能预填替代或撤销终态'))
  try {
    await asRole('keel_control', async (c) => {
      if (decision.supersedes_id !== undefined) {
        const old = (
          await c.query<{
            project_id: string
            decision_key: string
            superseded_by: string | null
            revoked_at: string | null
          }>(
            `SELECT project_id, decision_key, superseded_by, revoked_at
             FROM managed_project_decision WHERE id=$1`,
            [decision.supersedes_id],
          )
        ).rows[0]
        if (old === undefined) throw makeError('NOT_FOUND', '找不到被替代的项目决定')
        if (
          old.project_id !== decision.project_id ||
          old.decision_key !== decision.decision_key ||
          old.superseded_by !== null ||
          old.revoked_at !== null
        )
          throw makeError('CONFLICT', '被替代的项目决定不属于同作用域或已失效')
      }
      await c.query(
        `INSERT INTO managed_project_decision(
          id, project_id, decision_key, version, statement, selected_option_id,
          options, scope, source_type, source_ref, created_by, valid_from,
          valid_until, supersedes_id, superseded_by, revoked_at, revoked_by,
          revocation_reason, created_at
        ) VALUES(
          $1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,
          $15,$16,$17,$18,$19
        )`,
        [
          decision.id,
          decision.project_id,
          decision.decision_key,
          decision.version,
          decision.statement,
          decision.selected_option_id,
          JSON.stringify(decision.options),
          JSON.stringify(decision.scope),
          decision.source_type,
          decision.source_ref,
          decision.created_by,
          decision.valid_from,
          decision.valid_until ?? null,
          decision.supersedes_id ?? null,
          decision.superseded_by ?? null,
          decision.revoked_at ?? null,
          decision.revoked_by ?? null,
          decision.revocation_reason ?? null,
          decision.created_at,
        ],
      )
      if (decision.supersedes_id !== undefined) {
        await c.query('SELECT managed_supersede_decision($1,$2)', [
          decision.supersedes_id,
          decision.id,
        ])
      }
    })
    return ok(decision)
  } catch (error) {
    const expected = keelError(error)
    if (expected !== null) return err(expected)
    const code = pgCode(error)
    if (code === '23505' || code === '40001' || code === 'P0001')
      return err(makeError('CONFLICT', '项目决定版本冲突'))
    throw error
  }
}

export async function revokeProjectDecision(
  id: string,
  revokedBy: string,
  reason: string,
  now: string,
): Promise<Result<void>> {
  if (!revokedBy.trim() || !reason.trim() || timestamp(now) === null)
    return err(makeError('SCHEMA_VIOLATION', '撤销来源、理由和时间必须有效'))
  try {
    await asRole('keel_control', async (c) => {
      await c.query('SELECT managed_revoke_decision($1,$2,$3,$4)', [id, revokedBy, reason, now])
    })
    return ok(undefined)
  } catch (error) {
    if (pgCode(error) === 'P0001')
      return err(makeError('CONFLICT', '项目决定已撤销、被替代或不存在'))
    throw error
  }
}

export async function recordDelegationPolicy(
  policy: DelegationPolicyVersion,
): Promise<Result<DelegationPolicyVersion>> {
  const checked = validateDelegationPolicy(policy)
  if (!checked.ok) return checked
  if (
    timestamp(policy.approved_at) === null ||
    timestamp(policy.valid_from) === null ||
    (policy.valid_until !== undefined && timestamp(policy.valid_until) === null)
  )
    return err(makeError('SCHEMA_VIOLATION', '委托策略时间无效'))
  if (
    policy.superseded_by !== undefined ||
    policy.revoked_at !== undefined ||
    policy.revoked_by !== undefined ||
    policy.revocation_reason !== undefined
  )
    return err(makeError('SCHEMA_VIOLATION', '新委托策略不能预填替代或撤销终态'))
  try {
    await asRole('keel_control', async (c) => {
      if (policy.supersedes_id !== undefined) {
        const old = (
          await c.query<{
            project_id: string
            policy_id: string
            superseded_by: string | null
            revoked_at: string | null
          }>(
            `SELECT project_id, policy_id, superseded_by, revoked_at
             FROM managed_delegation_policy WHERE id=$1`,
            [policy.supersedes_id],
          )
        ).rows[0]
        if (old === undefined) throw makeError('NOT_FOUND', '找不到被替代的委托策略')
        if (
          old.project_id !== policy.project_id ||
          old.policy_id !== policy.policy_id ||
          old.superseded_by !== null ||
          old.revoked_at !== null
        )
          throw makeError('CONFLICT', '被替代的委托策略不属于同作用域或已失效')
      }
      await c.query(
        `INSERT INTO managed_delegation_policy(
          id, policy_id, version, project_id, approved_by_owner, approved_at,
          valid_from, valid_until, rules, supersedes_id, superseded_by,
          revoked_at, revoked_by, revocation_reason, created_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
        [
          policy.id,
          policy.policy_id,
          policy.version,
          policy.project_id,
          policy.approved_by_owner,
          policy.approved_at,
          policy.valid_from,
          policy.valid_until ?? null,
          JSON.stringify(policy.rules),
          policy.supersedes_id ?? null,
          policy.superseded_by ?? null,
          policy.revoked_at ?? null,
          policy.revoked_by ?? null,
          policy.revocation_reason ?? null,
          policy.created_at,
        ],
      )
      if (policy.supersedes_id !== undefined) {
        await c.query('SELECT managed_supersede_policy($1,$2)', [policy.supersedes_id, policy.id])
      }
    })
    return ok(policy)
  } catch (error) {
    const expected = keelError(error)
    if (expected !== null) return err(expected)
    const code = pgCode(error)
    if (code === '23505' || code === '40001' || code === 'P0001')
      return err(makeError('CONFLICT', '委托策略版本冲突'))
    throw error
  }
}

export async function revokeDelegationPolicy(
  id: string,
  revokedBy: string,
  reason: string,
  now: string,
): Promise<Result<void>> {
  if (!revokedBy.trim() || !reason.trim() || timestamp(now) === null)
    return err(makeError('SCHEMA_VIOLATION', '撤销来源、理由和时间必须有效'))
  try {
    await asRole('keel_control', async (c) => {
      await c.query('SELECT managed_revoke_policy($1,$2,$3,$4)', [id, revokedBy, reason, now])
    })
    return ok(undefined)
  } catch (error) {
    if (pgCode(error) === 'P0001')
      return err(makeError('CONFLICT', '委托策略已撤销、被替代或不存在'))
    throw error
  }
}

export async function submitTianwenProposal(
  requestId: string,
  revision: number,
  proposal: TianwenProposal,
  now: string,
): Promise<Result<string>> {
  return asRole('keel_control', (c) =>
    submitTianwenProposalInTx(c, requestId, revision, proposal, now),
  )
}

export async function submitTianwenProposalInTx(
  c: PoolClient,
  requestId: string,
  revision: number,
  proposal: TianwenProposal,
  now: string,
): Promise<Result<string>> {
  const checked = validateTianwenProposal(proposal)
  if (!checked.ok) return checked
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '提交时间不是合法时间'))
  const request = await requestBody(c, requestId, revision)
  if (request === null) return err(makeError('NOT_FOUND', '找不到 decision request'))
  if (request.status !== 'OPEN' && request.status !== 'PROCESSING')
    return err(makeError('CONFLICT', 'decision request 已结束'))
  if (proposal.request_id !== requestId || proposal.request_revision !== revision)
    return err(makeError('CONFLICT', '提案 request revision 不匹配'))
  if (
    proposal.input_digest !== request.input_digest ||
    decisionRequestDigest(request) !== request.input_digest
  )
    return err(makeError('CONFLICT', '提案 input digest 不匹配'))
  const nowMs = timestamp(now)
  if (
    request.expires_at !== undefined &&
    nowMs !== null &&
    nowMs >= (timestamp(request.expires_at) ?? Number.NEGATIVE_INFINITY)
  )
    return err(makeError('CONFLICT', 'decision request 已过期'))
  const id = randomUUID()
  await c.query(
    `INSERT INTO managed_tianwen_proposal(
      id, request_id, request_revision, input_digest, payload, actor_type,
      source, created_at
    ) VALUES($1,$2,$3,$4,$5::jsonb,'tianwen','model_proposal',$6)`,
    [id, requestId, revision, proposal.input_digest, JSON.stringify(proposal), now],
  )
  return ok(id)
}

async function controlForRequest(
  c: PoolClient,
  request: DecisionRequest,
): Promise<DecisionAcceptanceControl> {
  if (request.managed_task_id === undefined)
    return { state: 'paused', task_active: false, budget_available: false }
  const task = (
    await c.query<{ status: string; attempts: number; max_attempts: number }>(
      'SELECT status, attempts, max_attempts FROM managed_task WHERE id=$1',
      [request.managed_task_id],
    )
  ).rows[0]
  if (task === undefined) throw new Error('decision request 引用的 managed task 不存在')
  return {
    state: task.status === 'CANCELLED' ? 'cancelled' : 'active',
    task_active: !['DONE', 'FAILED', 'CANCELLED'].includes(task.status),
    budget_available: task.attempts < task.max_attempts,
  }
}

async function proposalBody(
  c: PoolClient,
  proposalId: string,
  requestId: string,
  revision: number,
): Promise<TianwenProposal | null> {
  const row = (
    await c.query<{ payload: unknown; actor_type: string; source: string; input_digest: string }>(
      `SELECT payload, actor_type, source, input_digest
       FROM managed_tianwen_proposal
       WHERE id=$1 AND request_id=$2 AND request_revision=$3`,
      [proposalId, requestId, revision],
    )
  ).rows[0]
  if (row === undefined) return null
  if (row.actor_type !== 'tianwen' || row.source !== 'model_proposal')
    throw makeError('PERMISSION_DENIED', '提案 actor/source 不是可信天问来源')
  return row.payload as TianwenProposal
}

export async function resolveTianwenProposal(
  requestId: string,
  revision: number,
  proposalId: string,
  resolutionId: string,
  now: string,
): Promise<Result<DecisionResolution>> {
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '接纳时间不是合法时间'))
  return asRole('keel_control', (c) =>
    resolveTianwenProposalInTx(c, requestId, revision, proposalId, resolutionId, now),
  )
}

export async function resolveTianwenProposalInTx(
  c: PoolClient,
  requestId: string,
  revision: number,
  proposalId: string,
  resolutionId: string,
  now: string,
): Promise<Result<DecisionResolution>> {
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '接纳时间不是合法时间'))
  const request = await requestBody(c, requestId, revision)
  if (request === null) return err(makeError('NOT_FOUND', '找不到 decision request'))
  if (request.status !== 'OPEN' && request.status !== 'PROCESSING')
    return err(makeError('CONFLICT', 'decision request 已有终态决议'))
  const proposal = await proposalBody(c, proposalId, requestId, revision)
  if (proposal === null) return err(makeError('NOT_FOUND', '找不到天问提案'))
  const checkedProposal = validateTianwenProposal(proposal)
  if (!checkedProposal.ok) return checkedProposal
  const decisions = await decisionsForProject(c, request.project_id)
  const policies = await currentPolicies(c, request.project_id)
  const control = await controlForRequest(c, request)
  const accepted = acceptDecision({
    request,
    proposal,
    resolution_id: resolutionId,
    now,
    authenticated_caller: {
      actor_type: 'tianwen',
      authenticated_id: TIANWEN_ACTOR_ID,
      source: 'model_proposal',
    },
    decisions,
    policies,
    control,
  })
  if (!accepted.ok) return accepted
  const resolution = accepted.value
  const inserted = await c.query<{ id: string }>(
    `INSERT INTO managed_decision_resolution(
      id, request_id, request_revision, input_digest, disposition,
      answer_option_id, answer, rationale, evidence_grade, basis_refs, actor,
      authority_refs, validity_conditions, memory_epoch, delegation_policy_id,
      delegation_policy_version, context_digest, resolved_at
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
      $13::jsonb,$14,$15,$16,$17,$18
    ) ON CONFLICT (request_id, request_revision) DO NOTHING
    RETURNING id`,
    [
      resolution.id,
      resolution.request_id,
      resolution.request_revision,
      resolution.input_digest,
      resolution.disposition,
      resolution.answer_option_id ?? null,
      resolution.answer ?? null,
      resolution.rationale,
      resolution.evidence_grade,
      JSON.stringify(resolution.basis_refs),
      JSON.stringify(resolution.actor),
      JSON.stringify(resolution.authority_refs),
      JSON.stringify(resolution.validity_conditions),
      resolution.memory_epoch ?? null,
      resolution.delegation_policy_id ?? null,
      resolution.delegation_policy_version ?? null,
      resolution.context_digest,
      resolution.resolved_at,
    ],
  )
  if (inserted.rowCount !== 1)
    return err(makeError('CONFLICT', '同一 request revision 已有其他决议'))
  const nextStatus =
    resolution.disposition === 'delegated' || resolution.disposition === 'human_confirmed'
      ? 'RESOLVED'
      : 'WAITING_HUMAN'
  const updated = await c.query(
    `UPDATE managed_decision_request SET status=$3, updated_at=$4
     WHERE id=$1 AND revision=$2 AND status IN ('OPEN','PROCESSING')`,
    [requestId, revision, nextStatus, now],
  )
  if (updated.rowCount !== 1) throw new Error('decision request CAS update failed')
  return ok(resolution)
}

export async function readDecisionResolution(
  requestId: string,
  revision: number,
): Promise<DecisionResolution | null> {
  const row = await asRole('keel_control', async (c) =>
    c.query<{ body: unknown }>(
      `SELECT jsonb_strip_nulls(to_jsonb(r)) AS body
       FROM (
         SELECT id, '1.0'::text AS schema_version, request_id, request_revision,
           input_digest, disposition, answer_option_id, answer, rationale,
           evidence_grade, basis_refs, actor, authority_refs, validity_conditions,
           memory_epoch, delegation_policy_id, delegation_policy_version,
           context_digest, resolved_at
         FROM managed_decision_resolution
         WHERE request_id=$1 AND request_revision=$2
       ) r`,
      [requestId, revision],
    ),
  )
  const body = row.rows[0]?.body
  if (body === undefined) return null
  const checked = validateDecisionResolution(body)
  if (!checked.ok) throw new Error(checked.error.detail)
  return checked.value
}

async function currentRequestForQuestion(
  c: PoolClient,
  questionId: string,
): Promise<DecisionRequest | null> {
  const row = await c.query<{ body: unknown }>(
    `SELECT ${REQUEST_JSON}
     WHERE r.managed_question_id=$1
     ORDER BY r.revision DESC LIMIT 1`,
    [questionId],
  )
  return (row.rows[0]?.body as DecisionRequest | undefined) ?? null
}

async function resolutionDisposition(
  c: PoolClient,
  requestId: string,
  revision: number,
): Promise<DecisionResolution['disposition'] | null> {
  const row = await c.query<{ disposition: DecisionResolution['disposition'] }>(
    `SELECT disposition FROM managed_decision_resolution
     WHERE request_id=$1 AND request_revision=$2`,
    [requestId, revision],
  )
  return row.rows[0]?.disposition ?? null
}

async function insertHumanResolution(
  c: PoolClient,
  request: DecisionRequest,
  option: DecisionRequest['options'][number],
  answer: string,
  now: string,
): Promise<DecisionResolution> {
  const resolution: DecisionResolution = {
    schema_version: '1.0',
    id: randomUUID(),
    request_id: request.id,
    request_revision: request.revision,
    input_digest: request.input_digest,
    disposition: 'human_confirmed',
    answer_option_id: option.id,
    answer,
    rationale: '本机操作员以精确选项答复并覆盖自动决定',
    evidence_grade: 'E3',
    basis_refs: [],
    actor: { type: 'human', authenticated_id: 'local-operator' },
    authority_refs: [],
    validity_conditions: ['human answer recorded through the local operator entrypoint'],
    ...(request.observed_memory_epoch === undefined
      ? {}
      : { memory_epoch: request.observed_memory_epoch }),
    context_digest: sha256CanonicalJson({
      request_id: request.id,
      request_revision: request.revision,
      input_digest: request.input_digest,
      answer_option_id: option.id,
      answer,
      actor: 'human:local-operator',
      now,
    }),
    resolved_at: now,
  }
  const checked = validateDecisionResolution(resolution)
  if (!checked.ok) throw checked.error
  await c.query(
    `INSERT INTO managed_decision_resolution(
      id, request_id, request_revision, input_digest, disposition,
      answer_option_id, answer, rationale, evidence_grade, basis_refs, actor,
      authority_refs, validity_conditions, memory_epoch, delegation_policy_id,
      delegation_policy_version, context_digest, resolved_at
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
      $13::jsonb,$14,$15,$16,$17,$18
    )`,
    [
      resolution.id,
      resolution.request_id,
      resolution.request_revision,
      resolution.input_digest,
      resolution.disposition,
      resolution.answer_option_id ?? null,
      resolution.answer ?? null,
      resolution.rationale,
      resolution.evidence_grade,
      JSON.stringify(resolution.basis_refs),
      JSON.stringify(resolution.actor),
      JSON.stringify(resolution.authority_refs),
      JSON.stringify(resolution.validity_conditions),
      resolution.memory_epoch ?? null,
      null,
      null,
      resolution.context_digest,
      resolution.resolved_at,
    ],
  )
  const updated = await c.query(
    `UPDATE managed_decision_request SET status='RESOLVED',updated_at=$3
     WHERE id=$1 AND revision=$2 AND status IN ('OPEN','PROCESSING','WAITING_HUMAN')`,
    [request.id, request.revision, now],
  )
  if (updated.rowCount !== 1) throw makeError('CONFLICT', 'decision request 已不是可答复状态')
  return resolution
}

async function supersedeRequest(
  c: PoolClient,
  current: DecisionRequest,
  now: string,
): Promise<DecisionRequest> {
  const revision = current.revision + 1
  const next: DecisionRequest = {
    ...current,
    revision,
    idempotency_key: `managed-question:${current.managed_question_id ?? current.id}:r${revision}`,
    status: 'OPEN',
    created_at: now,
  }
  await c.query(
    `UPDATE managed_decision_request SET status='SUPERSEDED',updated_at=$3
     WHERE id=$1 AND revision=$2 AND status IN ('OPEN','PROCESSING','WAITING_HUMAN','RESOLVED')`,
    [current.id, current.revision, now],
  )
  await c.query(
    `INSERT INTO managed_decision_request(
      id, revision, idempotency_key, project_id, repo_id, managed_task_id,
      managed_question_id, node_id, decision_key, kind, question, options,
      suggested_option_id, constraints, missing_information, impact,
      action_category, workflow_digest, observed_memory_epoch, input_digest,
      status, expires_at, created_at, updated_at
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,
      $16::jsonb,$17,$18,$19,$20,$21,$22,$23,$23
    )`,
    [
      next.id,
      next.revision,
      next.idempotency_key,
      next.project_id,
      next.repo_id,
      next.managed_task_id ?? null,
      next.managed_question_id ?? null,
      next.node_id ?? null,
      next.decision_key,
      next.kind,
      next.question,
      JSON.stringify(next.options),
      next.suggested_option_id ?? null,
      JSON.stringify(next.constraints),
      JSON.stringify(next.missing_information),
      JSON.stringify(next.impact),
      next.action_category,
      next.workflow_digest ?? null,
      next.observed_memory_epoch ?? null,
      next.input_digest,
      next.status,
      next.expires_at ?? null,
      next.created_at,
    ],
  )
  return next
}

async function insertManagedEvent(
  c: PoolClient,
  taskId: string,
  type: string,
  payload: unknown,
): Promise<void> {
  await c.query('INSERT INTO managed_event(task_id,type,payload) VALUES($1,$2,$3::jsonb)', [
    taskId,
    type,
    JSON.stringify(payload),
  ])
}

export async function answerManagedQuestionWithDecision(
  id: string,
  text: string,
): Promise<Result<string>> {
  const answer = text.trim()
  if (!answer || answer.length > 16000)
    return err(makeError('SCHEMA_VIOLATION', '答复必须为 1..16000 字符'))
  const now = new Date().toISOString()
  try {
    return await asRole('keel_control', async (c) => {
      const lookup = await c.query<{ task_id: string }>(
        'SELECT task_id FROM managed_question WHERE id=$1',
        [id],
      )
      const taskId = lookup.rows[0]?.task_id
      if (taskId === undefined) return err(makeError('NOT_FOUND', '找不到 managed question'))
      const task = (
        await c.query<ManagedTask>('SELECT * FROM managed_task WHERE id=$1 FOR UPDATE', [taskId])
      ).rows[0]
      const question = (
        await c.query<ManagedQuestion>('SELECT * FROM managed_question WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0]
      if (task === undefined || question === undefined)
        return err(makeError('NOT_FOUND', '找不到 managed task 或 question'))
      if (question.status === 'RESOLVED' && question.answer === answer) return ok(taskId)

      const current = await currentRequestForQuestion(c, id)
      if (current === null) {
        if (
          question.status !== 'WAITING_HUMAN' ||
          task.status !== 'WAITING_HUMAN' ||
          task.pending_question_id !== id
        )
          return err(makeError('CONFLICT', '问题尚未经天问处理，或当前任务已不等待该问题'))
        await c.query(
          `UPDATE managed_question SET status='RESOLVED',answer=$2,answered_by='local-operator',answered_at=now() WHERE id=$1`,
          [id, answer],
        )
        await c.query(
          `UPDATE managed_task SET status='READY',phase='investigate',pending_question_id=NULL,lease_token=NULL,lease_until=NULL,answers=answers || $2::jsonb,updated_at=now() WHERE id=$1`,
          [taskId, JSON.stringify([{ question: question.question, answer, actor: 'human' }])],
        )
        await insertManagedEvent(c, taskId, 'ManagedHumanAnswered', {
          questionId: id,
          answer,
          actor: 'local-operator',
        })
        await insertManagedEvent(c, taskId, 'ManagedTaskReady', {
          source: 'human-answer',
          questionId: id,
        })
        return ok(taskId)
      }

      const option = current.options.find((candidate) => candidate.text === answer)
      if (option === undefined)
        return err(makeError('SCHEMA_VIOLATION', '人工答复必须精确匹配请求选项'))
      const existing = await resolutionDisposition(c, current.id, current.revision)
      if (question.status === 'RESOLVED') {
        if (task.status !== 'READY')
          return err(makeError('CONFLICT', '任务已继续执行，需先暂停或取消后才能纠正决定'))
        if (existing !== 'delegated')
          return err(makeError('CONFLICT', '该问题没有可纠正的自动决定'))
      } else if (question.status === 'WAITING_HUMAN') {
        if (task.status !== 'WAITING_HUMAN' || task.pending_question_id !== id)
          return err(makeError('CONFLICT', '当前任务已不等待该问题'))
      } else {
        return err(makeError('CONFLICT', '问题尚未经天问处理，或已有不同答复'))
      }

      const target = existing === null ? current : await supersedeRequest(c, current, now)
      await insertHumanResolution(c, target, option, answer, now)
      if (question.status === 'RESOLVED') {
        await c.query(
          `INSERT INTO managed_question_correction(
          id,question_id,request_id,request_revision,answer,actor,created_at
        ) VALUES($1,$2,$3,$4,$5,'local-operator',$6)`,
          [randomUUID(), id, target.id, target.revision, answer, now],
        )
      } else {
        await c.query(
          `UPDATE managed_question SET status='RESOLVED',answer=$2,answered_by='local-operator',answered_at=now() WHERE id=$1`,
          [id, answer],
        )
      }
      await c.query(
        `UPDATE managed_task SET status='READY',phase='investigate',pending_question_id=NULL,
         lease_token=NULL,lease_until=NULL,
         answers=COALESCE((
           SELECT jsonb_agg(entry) FROM jsonb_array_elements(answers) entry
           WHERE entry->>'question' <> $2
         ),'[]'::jsonb) || $3::jsonb,
         updated_at=now()
       WHERE id=$1`,
        [
          taskId,
          question.question,
          JSON.stringify([
            {
              question: question.question,
              answer,
              actor: 'human',
              decisionRequestId: target.id,
              decisionRevision: target.revision,
            },
          ]),
        ],
      )
      await insertManagedEvent(c, taskId, 'ManagedHumanAnswered', {
        questionId: id,
        answer,
        actor: 'local-operator',
        requestId: target.id,
        requestRevision: target.revision,
        replacedDelegatedDecision: existing === 'delegated',
        correction: question.status === 'RESOLVED',
      })
      await insertManagedEvent(c, taskId, 'ManagedTaskReady', {
        source: 'human-answer',
        questionId: id,
        requestId: target.id,
        requestRevision: target.revision,
      })
      return ok(taskId)
    })
  } catch (error) {
    const known = keelError(error)
    if (known !== null) return err(known)
    throw error
  }
}

export async function escalateDecisionRequest(
  requestId: string,
  revision: number,
  reason: string,
  now: string,
): Promise<Result<DecisionResolution>> {
  return asRole('keel_control', (c) =>
    escalateDecisionRequestInTx(c, requestId, revision, reason, now),
  )
}

export async function escalateDecisionRequestInTx(
  c: PoolClient,
  requestId: string,
  revision: number,
  reason: string,
  now: string,
): Promise<Result<DecisionResolution>> {
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '接纳时间不是合法时间'))
  const request = await requestBody(c, requestId, revision)
  if (request === null) return err(makeError('NOT_FOUND', '找不到 decision request'))
  const existing = await c.query<{ body: unknown }>(
    `SELECT jsonb_strip_nulls(to_jsonb(r)) AS body
     FROM (
       SELECT id, '1.0'::text AS schema_version, request_id, request_revision,
         input_digest, disposition, answer_option_id, answer, rationale,
         evidence_grade, basis_refs, actor, authority_refs, validity_conditions,
         memory_epoch, delegation_policy_id, delegation_policy_version,
         context_digest, resolved_at
       FROM managed_decision_resolution
       WHERE request_id=$1 AND request_revision=$2
     ) r`,
    [requestId, revision],
  )
  const prior = existing.rows[0]?.body
  if (prior !== undefined) return ok(prior as DecisionResolution)
  const resolution: DecisionResolution = {
    schema_version: '1.0',
    id: randomUUID(),
    request_id: request.id,
    request_revision: request.revision,
    input_digest: request.input_digest,
    disposition: 'owner_required',
    rationale: reason,
    evidence_grade: 'E0',
    basis_refs: [],
    actor: { type: 'policy', authenticated_id: 'keel.decision-acceptor' },
    authority_refs: [],
    validity_conditions: ['a human decision is required for the current request revision'],
    ...(request.observed_memory_epoch === undefined
      ? {}
      : { memory_epoch: request.observed_memory_epoch }),
    context_digest: sha256CanonicalJson({
      request_id: request.id,
      request_revision: request.revision,
      input_digest: request.input_digest,
      reason,
      now,
    }),
    resolved_at: now,
  }
  const checked = validateDecisionResolution(resolution)
  if (!checked.ok) return checked
  await c.query(
    `INSERT INTO managed_decision_resolution(
        id, request_id, request_revision, input_digest, disposition,
        answer_option_id, answer, rationale, evidence_grade, basis_refs, actor,
        authority_refs, validity_conditions, memory_epoch, delegation_policy_id,
        delegation_policy_version, context_digest, resolved_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
        $13::jsonb,$14,$15,$16,$17,$18
      )`,
    [
      resolution.id,
      resolution.request_id,
      resolution.request_revision,
      resolution.input_digest,
      resolution.disposition,
      null,
      null,
      resolution.rationale,
      resolution.evidence_grade,
      JSON.stringify(resolution.basis_refs),
      JSON.stringify(resolution.actor),
      JSON.stringify(resolution.authority_refs),
      JSON.stringify(resolution.validity_conditions),
      resolution.memory_epoch ?? null,
      null,
      null,
      resolution.context_digest,
      resolution.resolved_at,
    ],
  )
  const updated = await c.query(
    `UPDATE managed_decision_request SET status='WAITING_HUMAN',updated_at=$3
       WHERE id=$1 AND revision=$2 AND status IN ('OPEN','PROCESSING')`,
    [requestId, revision, now],
  )
  if (updated.rowCount !== 1) throw makeError('CONFLICT', 'decision request 已结束')
  return ok(resolution)
}

export async function loadDecisionRequestForQuestion(
  questionId: string,
): Promise<DecisionRequest | null> {
  return asRole('keel_control', (c) => currentRequestForQuestion(c, questionId))
}

export async function loadDecisionRequestForQuestionInTx(
  c: PoolClient,
  questionId: string,
): Promise<DecisionRequest | null> {
  return currentRequestForQuestion(c, questionId)
}
