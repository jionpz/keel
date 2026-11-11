import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, type KeelError, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedTicketDecisionRunner, ManagedTicketTask } from '../../contracts/managed.js'
import type { Context, ContextSection, Usage } from '../../contracts/types.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asRole } from '../../fact/db.js'
import type {
  DecisionRequest,
  DecisionResolution,
  JstackTicketPackage,
  ManagedTicketStageResult,
  TianwenDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import {
  decisionContinues,
  escalateDecisionRequestInTx,
  getDecisionRequest,
  type listDelegationPolicies,
  resolveTianwenProposalInTx,
  submitTianwenProposalInTx,
} from './decision-store.js'
import { type ProjectMemoryRetrieval, retrieveProjectMemoryInTx } from './memory-store.js'
import { validateTianwenDecision } from './protocol.js'
import { validateTicketPackage } from './ticket-protocol.js'
import { getManagedTicketTask, listManagedTicketStages, ticketEvent } from './ticket-store.js'

export interface TicketTianwenResult {
  readonly taskId: string
  readonly requestId: string
  readonly revision: number
  readonly status: 'READY' | 'WAITING_HUMAN' | 'CANCELLED'
  readonly disposition: DecisionResolution['disposition'] | null
  readonly rationale: string | null
}

function isKeelError(value: unknown): value is KeelError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'detail' in value &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { detail?: unknown }).detail === 'string'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function section(id: string, content: string, source: string): ContextSection {
  return {
    id,
    content,
    source_ref: source,
    source_kind: 'fixed',
    priority: 'required',
    tokens: Math.ceil(content.length / 4),
  }
}

async function loadTicketPackage(
  c: PoolClient,
  task: ManagedTicketTask,
): Promise<JstackTicketPackage> {
  const row = await c.query<{ body: unknown }>('SELECT body FROM managed_package WHERE digest=$1', [
    task.package_digest,
  ])
  const parsed = validateTicketPackage(row.rows[0]?.body)
  if (!parsed.ok) throw parsed.error
  if (parsed.value.package.content_digest !== task.package_digest)
    throw makeError('PROTOCOL_ERROR', 'ticket 工作流包摘要与绑定不符')
  return parsed.value.package
}

function lastBlockedResult(
  stages: Awaited<ReturnType<typeof listManagedTicketStages>>,
): ManagedTicketStageResult | null {
  const record = [...stages].reverse().find((stage) => stage.status === 'MUST_STOP')
  return record?.result === null || record?.result === undefined
    ? null
    : (record.result as ManagedTicketStageResult)
}

function tianwenInstruction(): string {
  return (
    '你是天问，本项目的用户代表。你只能提交候选提案，不能自签授权、不能自报证据等级、' +
    '不能声称用户已批准。只有项目明确决定或项目委托策略能支撑自动接纳；' +
    '没有可验证依据时把缺口写入 missing_authority，交由真实人工答复。' +
    '不能操作文件或直接询问用户。只输出一个符合给定 JSON Schema 的 TianwenDecision 对象。'
  )
}

async function buildTianwenContext(
  c: PoolClient,
  task: ManagedTicketTask,
  ticketPackage: JstackTicketPackage,
  request: DecisionRequest,
): Promise<{ readonly context: Context; readonly memory: ProjectMemoryRetrieval }> {
  const stages = await listManagedTicketStages(task.id)
  const policies = await listDelegationPoliciesInTx(c, task.repo_id)
  const memory = await retrieveProjectMemoryInTx(c, {
    project_id: task.repo_id,
    request_id: request.id,
    query: [
      request.question,
      request.decision_key,
      request.action_category,
      ...request.constraints,
      ...request.missing_information,
    ].join('\n'),
    decision_key: request.decision_key,
    kind: request.kind,
    action_category: request.action_category,
    impact: request.impact,
    budget_entries: 8,
    budget_tokens: 4000,
  })
  if (!memory.ok) throw memory.error
  const snapshot = JSON.stringify({
    ticket: ticketPackage.ticket,
    package_digest: task.package_digest,
    completion_target: ticketPackage.completion_target,
    stage: task.current_stage,
    worktree: task.worktree_path,
    request,
    project_memory: memory.value,
    delegation_policies: policies,
    stage_history: stages.map((stage) => ({
      stage: stage.stage,
      attempt: stage.attempt,
      status: stage.status,
      summary:
        stage.result !== null && typeof stage.result === 'object' && 'summary' in stage.result
          ? (stage.result as { summary?: unknown }).summary
          : null,
      error: stage.error,
    })),
    blocked_result: lastBlockedResult(stages),
  })
  const sections = [
    section('role', tianwenInstruction(), 'fixed:managed/tianwen-v1'),
    section('workflow', ticketPackage.instructions.route, 'managed-ticket:route'),
    section('stages', ticketPackage.instructions.stages, 'managed-ticket:stages'),
    section('must_stop', ticketPackage.instructions.must_stop, 'managed-ticket:must-stop'),
    {
      ...section('facts', snapshot, `managed-ticket:${task.id}/decision:${request.id}`),
      source_kind: 'artifact' as const,
    },
    section(
      'output',
      `只输出一个符合此 JSON Schema 的 JSON 对象：\n${JSON.stringify(MANAGED_SCHEMAS.tianwen_decision)}`,
      'fixed:managed/tianwen-output-v1',
    ),
  ]
  return {
    context: {
      context_id: randomUUID(),
      recipe_id: 'managed-ticket/tianwen',
      recipe_version: '1',
      sections,
      total_tokens: sections.reduce((total, entry) => total + entry.tokens, 0),
      dropped: [],
    },
    memory: memory.value,
  }
}

async function listDelegationPoliciesInTx(
  c: PoolClient,
  projectId: string,
): Promise<Awaited<ReturnType<typeof listDelegationPolicies>>> {
  const rows = await c.query<{ body: unknown }>(
    `SELECT jsonb_strip_nulls(to_jsonb(p)) AS body
     FROM (
       SELECT id, '1.0'::text AS schema_version, policy_id, version, project_id,
         approved_by_owner, approved_at, valid_from, valid_until, rules,
         supersedes_id, superseded_by, revoked_at, revoked_by,
         revocation_reason, created_at
       FROM managed_delegation_policy WHERE project_id=$1
       ORDER BY policy_id, version
     ) p`,
    [projectId],
  )
  return rows.rows.map((row) => row.body) as Awaited<ReturnType<typeof listDelegationPolicies>>
}

function proposalFrom(request: DecisionRequest, decision: TianwenDecision): TianwenProposal {
  return {
    schema_version: '1.0',
    request_id: request.id,
    request_revision: request.revision,
    input_digest: request.input_digest,
    recommendation: decision.recommendation,
    ...(decision.answer_option_id === undefined
      ? {}
      : { answer_option_id: decision.answer_option_id }),
    rationale: decision.rationale,
    claimed_evidence_grade: 'E0',
    basis_refs: decision.basis_refs,
    observed_fact_refs: [],
    assumptions: decision.assumptions,
    alternatives: decision.alternatives,
    unresolved_conflicts: decision.unresolved_conflicts,
    missing_authority: decision.missing_authority,
  }
}

async function finalizeUnavailable(
  c: PoolClient,
  task: ManagedTicketTask,
  request: DecisionRequest,
  reason: string,
  usage: Usage,
  now: string,
): Promise<Result<TicketTianwenResult>> {
  const escalated = await escalateDecisionRequestInTx(
    c,
    request.id,
    request.revision,
    `天问提案不可用：${reason}`,
    now,
  )
  if (!escalated.ok) return escalated
  await ticketEvent(c, task.id, 'ManagedTicketTianwenUnavailable', {
    requestId: request.id,
    requestRevision: request.revision,
    reason,
    usage,
  })
  return ok({
    taskId: task.id,
    requestId: request.id,
    revision: request.revision,
    status: 'WAITING_HUMAN',
    disposition: escalated.value.disposition,
    rationale: escalated.value.rationale,
  })
}

async function loadTianwenInput(requestId: string, revision: number) {
  return asRole('keel_control', async (c) => {
    const request = await getDecisionRequest(requestId, revision, c)
    if (request === null) throw makeError('NOT_FOUND', '找不到 ticket decision request')
    if (request.managed_ticket_task_id === undefined)
      throw makeError('CONFLICT', '该请求不属于 managed ticket task')
    if (request.status !== 'PROCESSING')
      throw makeError('CONFLICT', `decision request 当前是 ${request.status}，不接受天问提案`)
    const task = await getManagedTicketTask(request.managed_ticket_task_id)
    if (task === null) throw makeError('NOT_FOUND', '找不到 managed ticket task')
    if (task.status !== 'WAITING_HUMAN' || task.pending_decision_id !== request.id)
      throw makeError('CONFLICT', 'ticket task 不在等待该决策')
    const ticketPackage = await loadTicketPackage(c, task)
    const built = await buildTianwenContext(c, task, ticketPackage, request)
    return { task, request, context: built.context, memory: built.memory }
  })
}

export async function runTicketTianwen(
  decide: ManagedTicketDecisionRunner,
  requestId: string,
  revision: number,
): Promise<Result<TicketTianwenResult>> {
  const now = new Date().toISOString()
  let loaded: Awaited<ReturnType<typeof loadTianwenInput>>
  try {
    loaded = await loadTianwenInput(requestId, revision)
  } catch (error) {
    return err(isKeelError(error) ? error : makeError('CONFLICT', errorMessage(error)))
  }
  if (loaded.context.total_tokens > 60000)
    return err(makeError('CONTEXT_BUDGET_EXCEEDED', 'ticket 天问上下文超预算'))
  if (loaded.memory.escalation_reason !== null) {
    return asRole('keel_control', async (c) => {
      const escalated = await finalizeUnavailable(
        c,
        loaded.task,
        loaded.request,
        `项目记忆无法完整重建：${loaded.memory.escalation_reason}`,
        ZERO_USAGE,
        now,
      )
      if (escalated.ok) {
        await ticketEvent(c, loaded.task.id, 'ManagedTicketTianwenMemoryEscalated', {
          requestId,
          requestRevision: revision,
          memoryEpoch: loaded.memory.memory_epoch,
          summaryId: loaded.memory.summary_id,
          summaryVersion: loaded.memory.summary_version,
          escalationReason: loaded.memory.escalation_reason,
          referencedDecisionIds: loaded.memory.referenced_decision_ids,
        })
      }
      return escalated
    })
  }

  const attemptId = randomUUID()
  await asRole('keel_control', (c) =>
    ticketEvent(c, loaded.task.id, 'ManagedTicketTianwenStarted', {
      requestId,
      requestRevision: revision,
      attemptId,
    }),
  )
  let outcome: Awaited<ReturnType<ManagedTicketDecisionRunner>>
  try {
    outcome = await decide({
      attempt_id: attemptId,
      task_id: loaded.task.id,
      repo_id: loaded.task.repo_id,
      workspace_path: loaded.task.worktree_path,
      context: loaded.context,
    })
  } catch (error) {
    outcome = {
      ok: false,
      error: makeError('HARNESS_UNAVAILABLE', errorMessage(error)),
      usage: ZERO_USAGE,
    }
  }
  if (!outcome.ok) {
    return asRole('keel_control', (c) =>
      finalizeUnavailable(
        c,
        loaded.task,
        loaded.request,
        `${outcome.error.kind}: ${outcome.error.detail}`,
        outcome.usage,
        now,
      ),
    )
  }
  const checked = validateTianwenDecision(outcome.value.output)
  if (!checked.ok) {
    return asRole('keel_control', (c) =>
      finalizeUnavailable(
        c,
        loaded.task,
        loaded.request,
        checked.error.detail,
        outcome.value.usage,
        now,
      ),
    )
  }
  return asRole('keel_control', async (c) => {
    const locked = await c.query(
      `SELECT id FROM managed_ticket_task WHERE id=$1 AND status='WAITING_HUMAN'
       AND pending_decision_id=$2 FOR UPDATE`,
      [loaded.task.id, requestId],
    )
    if (locked.rowCount !== 1) return err(makeError('CONFLICT', 'ticket task 已不再等待该决策'))
    const request = await getDecisionRequest(requestId, revision, c)
    if (request === null || request.status !== 'PROCESSING')
      return err(makeError('CONFLICT', 'decision request 已发生变化'))
    const proposal = proposalFrom(request, checked.value)
    const submitted = await submitTianwenProposalInTx(
      c,
      request.id,
      request.revision,
      proposal,
      now,
    )
    if (!submitted.ok)
      return finalizeUnavailable(
        c,
        loaded.task,
        request,
        submitted.error.detail,
        outcome.value.usage,
        now,
      )
    const resolved = await resolveTianwenProposalInTx(
      c,
      request.id,
      request.revision,
      submitted.value,
      randomUUID(),
      now,
    )
    if (!resolved.ok)
      return finalizeUnavailable(
        c,
        loaded.task,
        request,
        resolved.error.detail,
        outcome.value.usage,
        now,
      )
    const resolution = resolved.value
    if (resolution.disposition === 'delegated' || resolution.disposition === 'human_confirmed') {
      const answerOption = request.options.find(
        (option) => option.id === resolution.answer_option_id,
      )
      const mustStop =
        loaded.task.last_error === 'MUST_STOP' || loaded.task.last_error === 'UNAUTHORIZED_ACTION'
      const shouldContinue =
        answerOption !== undefined && decisionContinues(answerOption.text, mustStop)
      const taskStatus = shouldContinue ? 'READY' : 'CANCELLED'
      await c.query(
        `UPDATE managed_ticket_task SET status=$2,pending_decision_id=NULL,
           pending_decision_revision=NULL,control_generation=control_generation+1,
           lease_token=NULL,lease_until=NULL,last_error=$4,updated_at=$3,
           handoff=COALESCE(handoff,'{}'::jsonb) || $5::jsonb WHERE id=$1`,
        [
          loaded.task.id,
          taskStatus,
          now,
          shouldContinue ? null : 'STOPPED_BY_DECISION',
          JSON.stringify({
            last_decision: {
              request_id: resolution.request_id,
              request_revision: resolution.request_revision,
              resolution_id: resolution.id,
              digest: resolution.context_digest,
            },
          }),
        ],
      )
      await ticketEvent(c, loaded.task.id, 'ManagedTicketDecisionDelegated', {
        requestId: request.id,
        requestRevision: request.revision,
        proposal,
        resolution,
        taskStatus,
        usage: outcome.value.usage,
      })
      return ok({
        taskId: loaded.task.id,
        requestId: request.id,
        revision: request.revision,
        status: taskStatus,
        disposition: resolution.disposition,
        rationale: resolution.rationale,
      })
    }
    await ticketEvent(c, loaded.task.id, 'ManagedTicketDecisionEscalated', {
      requestId: request.id,
      requestRevision: request.revision,
      proposal,
      resolution,
      usage: outcome.value.usage,
    })
    return ok({
      taskId: loaded.task.id,
      requestId: request.id,
      revision: request.revision,
      status: 'WAITING_HUMAN',
      disposition: resolution.disposition,
      rationale: resolution.rationale,
    })
  })
}

export async function tickPendingTicketTianwen(
  decide: ManagedTicketDecisionRunner,
  taskId?: string,
): Promise<Result<TicketTianwenResult | null>> {
  const pending = await asRole('keel_control', async (c) => {
    const row = await c.query<{ id: string; revision: number }>(
      `SELECT r.id,r.revision
       FROM managed_decision_request r
       JOIN managed_ticket_task t ON t.id=r.managed_ticket_task_id
       WHERE r.status='PROCESSING' AND t.status='WAITING_HUMAN'
         AND ($1::uuid IS NULL OR t.id=$1)
       ORDER BY r.created_at LIMIT 1`,
      [taskId ?? null],
    )
    return row.rows[0] ?? null
  })
  if (pending === null) return ok(null)
  return runTicketTianwen(decide, pending.id, pending.revision)
}
