import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, type KeelError, makeError, ok, type Result } from '../../contracts/errors.js'
import { asRole } from '../../fact/db.js'
import type {
  DecisionRequest,
  DecisionResolution,
  ProjectDecision,
  ProjectMemoryContent,
} from '../../generated/managed.js'
import { validateProjectDecision } from './decision-protocol.js'
import { getDecisionRequest, recordProjectDecisionInTx } from './decision-store.js'
import {
  buildProjectMemoryContent,
  MEMORY_MODEL_VERSION,
  mergeMemoryCandidates,
  type ProjectMemoryQuery,
  type ProjectMemoryRetrievalEntry,
  type ProjectMemorySelection,
  projectMemoryContentDigest,
  selectProjectMemoryEntries,
  validateProjectMemoryContent,
} from './memory-protocol.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DEFAULT_BUDGET_ENTRIES = 8
const DEFAULT_BUDGET_TOKENS = 4000
const MAX_BUDGET_ENTRIES = 64
const MAX_BUDGET_TOKENS = 32_000
const REQUIRED_CONFIDENCE: ProjectDecision['source_type'] = 'owner_confirmed'

type SummaryStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED'

const DECISION_JSON = `jsonb_strip_nulls(to_jsonb(d)) AS body
  FROM (
    SELECT id, '1.0'::text AS schema_version, project_id, decision_key, version,
      statement, selected_option_id, options, scope, source_type, source_ref,
      created_by, valid_from, valid_until, supersedes_id, superseded_by,
      revoked_at, revoked_by, revocation_reason, created_at
    FROM managed_project_decision
  ) d`

interface StateRow {
  readonly project_id: string
  readonly epoch: string | number
  readonly active_summary_id: string | null
  readonly active_summary_version: number | null
  readonly updated_at: Date
}

interface SummaryRow {
  readonly id: string
  readonly project_id: string
  readonly version: number
  readonly status: SummaryStatus
  readonly content: unknown
  readonly content_digest: string
  readonly covered_decision_count: number
  readonly covered_change_seq: string | number
  readonly memory_epoch: string | number
  readonly model_version: string
  readonly generated_by: string
  readonly generated_at: Date
  readonly previous_summary_id: string | null
  readonly rollback_of_summary_id: string | null
  readonly validation: unknown
  readonly reason: string | null
  readonly created_at: Date
}

export interface ProjectMemoryState {
  readonly project_id: string
  readonly epoch: number
  readonly active_summary_id: string | null
  readonly active_summary_version: number | null
  readonly active_summary: ProjectMemorySummary | null
  readonly stale: boolean
  readonly stale_reason: string | null
  readonly updated_at: string
}

export interface ProjectMemorySummary {
  readonly id: string
  readonly project_id: string
  readonly version: number
  readonly status: SummaryStatus
  readonly content: ProjectMemoryContent
  readonly content_digest: string
  readonly covered_decision_count: number
  readonly covered_change_seq: number
  readonly memory_epoch: number
  readonly model_version: string
  readonly generated_by: string
  readonly generated_at: string
  readonly previous_summary_id: string | null
  readonly rollback_of_summary_id: string | null
  readonly validation: unknown
  readonly reason: string | null
  readonly created_at: string
}

export interface CreateMemorySummaryInput {
  readonly project_id: string
  readonly generated_by: string
  readonly model_version?: string
  readonly now: string
}

export interface MemoryRegressionCase {
  readonly query: string
  readonly decision_key?: string
  readonly expected_decision_ids: readonly string[]
}

export interface PublishMemorySummaryInput {
  readonly project_id: string
  readonly summary_id: string
  readonly expected_epoch: number
  readonly actor: string
  readonly now: string
  readonly regression_cases?: readonly MemoryRegressionCase[]
}

export interface RollbackMemorySummaryInput {
  readonly project_id: string
  readonly summary_id: string
  readonly expected_epoch: number
  readonly actor: string
  readonly reason: string
  readonly now: string
}

export interface RejectMemorySummaryInput {
  readonly project_id: string
  readonly summary_id: string
  readonly actor: string
  readonly reason?: string
  readonly now: string
}

export interface RetrieveProjectMemoryInput {
  readonly project_id: string
  readonly query: string
  readonly request_id?: string
  readonly decision_key?: string
  readonly kind?: DecisionRequest['kind']
  readonly action_category?: string
  readonly impact?: DecisionRequest['impact']
  readonly budget_entries?: number
  readonly budget_tokens?: number
}

export interface ProjectMemoryRetrieval {
  readonly project_id: string
  readonly query: string
  readonly summary_id: string | null
  readonly summary_version: number | null
  readonly summary_stale: boolean
  readonly memory_epoch: number
  readonly candidate_count: number
  readonly expanded: boolean
  readonly expansion_reason: string | null
  readonly escalation_reason: string | null
  readonly entries: readonly ProjectMemoryRetrievalEntry[]
  readonly omitted_count: number
  readonly referenced_decision_ids: readonly string[]
  readonly budget_entries: number
  readonly used_entries: number
  readonly budget_tokens: number
  readonly used_tokens: number
  readonly observed_at: string
}

export interface PromoteHumanAnswerInput {
  readonly request_id: string
  readonly revision: number
  readonly decision_key: string
  readonly actor: string
  readonly now: string
  readonly statement?: string
  readonly valid_from?: string
  readonly valid_until?: string
  readonly supersedes_id?: string
  readonly scope?: ProjectDecision['scope']
}

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function keelError(error: unknown): KeelError | null {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return null
  return typeof error.kind === 'string' ? (error as KeelError) : null
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function epochNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('无效的 memory epoch')
  return parsed
}

function decisionActive(decision: ProjectDecision, now: number): boolean {
  const from = timestamp(decision.valid_from)
  if (from === null || from > now || decision.revoked_at !== undefined) return false
  if (decision.superseded_by !== undefined) return false
  if (decision.valid_until === undefined) return true
  const until = timestamp(decision.valid_until)
  return until !== null && now < until
}

function activeDecisionBodies(
  decisions: readonly ProjectDecision[],
  now: string,
): ProjectDecision[] {
  const at = timestamp(now)
  if (at === null) return []
  return decisions.filter((decision) => decisionActive(decision, at))
}

function summaryFromRow(row: SummaryRow): Result<ProjectMemorySummary> {
  const checked = validateProjectMemoryContent(row.content, row.project_id)
  if (!checked.ok) return checked
  if (projectMemoryContentDigest(checked.value) !== row.content_digest)
    return err(makeError('SCHEMA_VIOLATION', '摘要 content_digest 与内容不匹配'))
  if (row.covered_decision_count !== checked.value.entries.length)
    return err(makeError('SCHEMA_VIOLATION', '摘要 covered_decision_count 与内容不匹配'))
  return ok({
    id: row.id,
    project_id: row.project_id,
    version: row.version,
    status: row.status,
    content: checked.value,
    content_digest: row.content_digest,
    covered_decision_count: row.covered_decision_count,
    covered_change_seq: epochNumber(row.covered_change_seq),
    memory_epoch: epochNumber(row.memory_epoch),
    model_version: row.model_version,
    generated_by: row.generated_by,
    generated_at: iso(row.generated_at),
    previous_summary_id: row.previous_summary_id,
    rollback_of_summary_id: row.rollback_of_summary_id,
    validation: row.validation,
    reason: row.reason,
    created_at: iso(row.created_at),
  })
}

async function loadState(c: PoolClient, projectId: string): Promise<StateRow | null> {
  const row = await c.query<StateRow>(
    `SELECT project_id, epoch, active_summary_id, active_summary_version, updated_at
     FROM managed_project_memory_state WHERE project_id=$1`,
    [projectId],
  )
  return row.rows[0] ?? null
}

async function loadSummary(
  c: PoolClient,
  projectId: string,
  summaryId: string,
): Promise<SummaryRow | null> {
  const row = await c.query<SummaryRow>(
    `SELECT id, project_id, version, status, content, content_digest,
       covered_decision_count, covered_change_seq, memory_epoch, model_version,
       generated_by, generated_at, previous_summary_id, rollback_of_summary_id,
       validation, reason, created_at
     FROM managed_project_memory_summary
     WHERE id=$1 AND project_id=$2`,
    [summaryId, projectId],
  )
  return row.rows[0] ?? null
}

async function maxChangeSeq(c: PoolClient, projectId: string): Promise<number> {
  const row = await c.query<{ seq: string | number }>(
    'SELECT COALESCE(MAX(seq),0) AS seq FROM managed_decision_change WHERE project_id=$1',
    [projectId],
  )
  return epochNumber(row.rows[0]?.seq ?? 0)
}

async function decisionsByIds(
  c: PoolClient,
  projectId: string,
  decisionIds: readonly string[],
): Promise<ProjectDecision[]> {
  if (decisionIds.length === 0) return []
  const rows = await c.query<{ body: unknown }>(
    `SELECT ${DECISION_JSON}
     WHERE d.project_id=$1 AND d.id = ANY($2::uuid[])
     ORDER BY d.decision_key, d.version, d.id`,
    [projectId, decisionIds],
  )
  return rows.rows.map((row) => row.body as ProjectDecision)
}

async function activeDecisionsAt(
  c: PoolClient,
  projectId: string,
  now: string,
): Promise<ProjectDecision[]> {
  const rows = await c.query<{ body: unknown }>(
    `SELECT ${DECISION_JSON}
     WHERE d.project_id=$1
       AND d.revoked_at IS NULL
       AND d.superseded_by IS NULL
       AND d.valid_from <= $2
       AND (d.valid_until IS NULL OR d.valid_until > $2)
     ORDER BY d.decision_key, d.version, d.id`,
    [projectId, now],
  )
  return rows.rows.map((row) => row.body as ProjectDecision)
}

function searchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase('zh-CN')
  const found = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.-]{1,127}/g)) {
    found.add(match[0])
  }
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const run = match[0]
    if (run.length === 1) {
      found.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) found.add(run.slice(i, i + 2))
  }
  if (found.size === 0) found.add(normalized.slice(0, 128))
  return [...found].slice(0, 16)
}

async function activeMatchingDecisions(
  c: PoolClient,
  projectId: string,
  now: string,
  decisionKey: string | undefined,
  terms: readonly string[],
  limit: number,
): Promise<ProjectDecision[]> {
  const rows = await c.query<{ body: unknown }>(
    `SELECT ${DECISION_JSON}
     WHERE d.project_id=$1
       AND d.revoked_at IS NULL
       AND d.superseded_by IS NULL
       AND d.valid_from <= $2
       AND (d.valid_until IS NULL OR d.valid_until > $2)
       AND (
         ($3::text IS NOT NULL AND d.decision_key = $3)
         OR EXISTS (
           SELECT 1 FROM unnest($4::text[]) AS term
           WHERE strpos(lower(d.statement), lower(term)) > 0
             OR strpos(lower(d.decision_key), lower(term)) > 0
             OR strpos(lower(d.options::text), lower(term)) > 0
         )
       )
     ORDER BY d.decision_key, d.version, d.id
     LIMIT $5`,
    [projectId, now, decisionKey ?? null, [...terms], limit],
  )
  return rows.rows.map((row) => row.body as ProjectDecision)
}

function queryInput(input: RetrieveProjectMemoryInput): Result<ProjectMemoryQuery> {
  if (!UUID.test(input.project_id))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 必须是 UUID'))
  const text = input.query.trim()
  if (text.length === 0 || text.length > 16000)
    return err(makeError('SCHEMA_VIOLATION', '检索条件必须为 1..16000 字符'))
  const budgetEntries = input.budget_entries ?? DEFAULT_BUDGET_ENTRIES
  const budgetTokens = input.budget_tokens ?? DEFAULT_BUDGET_TOKENS
  if (
    !Number.isSafeInteger(budgetEntries) ||
    budgetEntries < 1 ||
    budgetEntries > MAX_BUDGET_ENTRIES
  )
    return err(makeError('SCHEMA_VIOLATION', `budget_entries 必须是 1..${MAX_BUDGET_ENTRIES}`))
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1 || budgetTokens > MAX_BUDGET_TOKENS)
    return err(makeError('SCHEMA_VIOLATION', `budget_tokens 必须是 1..${MAX_BUDGET_TOKENS}`))
  if (input.request_id !== undefined && !UUID.test(input.request_id))
    return err(makeError('SCHEMA_VIOLATION', 'request_id 必须是 UUID'))
  if (input.decision_key !== undefined && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.decision_key))
    return err(makeError('SCHEMA_VIOLATION', 'decision_key 非法'))
  return ok({
    project_id: input.project_id,
    text,
    ...(input.decision_key === undefined ? {} : { decision_key: input.decision_key }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.action_category === undefined ? {} : { action_category: input.action_category }),
    ...(input.impact === undefined ? {} : { impact: input.impact }),
    budget_entries: budgetEntries,
    budget_tokens: budgetTokens,
  })
}

async function verifyRequestProject(
  c: PoolClient,
  requestId: string,
  projectId: string,
): Promise<void> {
  const row = await c.query<{ project_id: string }>(
    `SELECT project_id FROM managed_decision_request
     WHERE id=$1 ORDER BY revision DESC LIMIT 1`,
    [requestId],
  )
  const found = row.rows[0]
  if (found === undefined) throw makeError('NOT_FOUND', '找不到检索关联的 decision request')
  if (found.project_id !== projectId)
    throw makeError('PERMISSION_DENIED', 'decision request 不属于当前项目')
}

function mergedExpansionReason(staleReasons: readonly string[], selection: ProjectMemorySelection) {
  const reasons = [...staleReasons]
  if (selection.expansion_reason !== null) reasons.push(selection.expansion_reason)
  return reasons.length === 0 ? null : reasons.join('; ')
}

async function retrieveInTx(
  c: PoolClient,
  raw: RetrieveProjectMemoryInput,
  query: ProjectMemoryQuery,
  now: string,
): Promise<Result<ProjectMemoryRetrieval>> {
  if (raw.request_id !== undefined) await verifyRequestProject(c, raw.request_id, query.project_id)
  const initial = await loadState(c, query.project_id)
  const memoryEpoch = initial === null ? 0 : epochNumber(initial.epoch)
  const initialSeq = await maxChangeSeq(c, query.project_id)
  const staleReasons: string[] = []
  let summary: ProjectMemorySummary | null = null
  let summaryEntries: ProjectMemoryContent['entries'] = []

  if (initial?.active_summary_id == null) {
    staleReasons.push('no_active_summary')
  } else {
    const rawSummary = await loadSummary(c, query.project_id, initial.active_summary_id)
    if (rawSummary === null) {
      staleReasons.push('active_summary_missing')
    } else if (rawSummary.status !== 'ACTIVE') {
      staleReasons.push(`active_summary_status_${rawSummary.status.toLowerCase()}`)
    } else {
      const parsed = summaryFromRow(rawSummary)
      if (!parsed.ok) {
        staleReasons.push(`invalid_summary: ${parsed.error.detail}`)
      } else {
        summary = parsed.value
        summaryEntries = parsed.value.content.entries
      }
    }
  }

  if (summary !== null) {
    if (summary.memory_epoch !== memoryEpoch)
      staleReasons.push(`epoch_mismatch:${summary.memory_epoch}:${memoryEpoch}`)
    if (summary.covered_change_seq < initialSeq)
      staleReasons.push(`watermark_behind:${summary.covered_change_seq}:${initialSeq}`)
  }

  const summaryIds = [...new Set(summaryEntries.map((entry) => entry.decision_id))]
  const referenced = await decisionsByIds(c, query.project_id, summaryIds)
  if (summary !== null) {
    const summaryCheck = validateProjectMemoryContent(
      summary.content,
      query.project_id,
      referenced,
      now,
    )
    if (!summaryCheck.ok) staleReasons.push(`summary_source_mismatch: ${summaryCheck.error.detail}`)
  }
  const liveReferencedResult = buildProjectMemoryContent(query.project_id, referenced, now)
  if (!liveReferencedResult.ok) {
    staleReasons.push(`referenced_rebuild_failed: ${liveReferencedResult.error.detail}`)
  } else if (liveReferencedResult.value.entries.length !== summaryEntries.length) {
    staleReasons.push('referenced_decision_changed')
  }

  const stale = staleReasons.length > 0
  const terms = searchTerms(query.text)
  let delta: ProjectDecision[] = []
  let scanTruncated = false
  if (stale) {
    const scanLimit = Math.max(query.budget_entries * 4 + 1, 33)
    delta = await activeMatchingDecisions(
      c,
      query.project_id,
      now,
      query.decision_key,
      terms,
      scanLimit,
    )
    if (delta.length >= scanLimit) scanTruncated = true
  }

  const allLiveDecisions = new Map<string, ProjectDecision>()
  for (const decision of [...referenced, ...delta]) allLiveDecisions.set(decision.id, decision)
  const liveResult = buildProjectMemoryContent(
    query.project_id,
    [...allLiveDecisions.values()],
    now,
  )
  if (!liveResult.ok) staleReasons.push(`live_rebuild_failed: ${liveResult.error.detail}`)

  const merged = mergeMemoryCandidates(
    summaryEntries,
    liveResult.ok ? liveResult.value.entries : [],
  )
  const selection = selectProjectMemoryEntries(merged.entries, query)
  const escalations: string[] = []
  if (selection.escalation_reason !== null) escalations.push(selection.escalation_reason)
  if (scanTruncated) escalations.push(`candidate_scan_truncated_at_${delta.length}`)
  if (!liveResult.ok)
    escalations.push(`authoritative_decisions_could_not_be_loaded: ${liveResult.error.detail}`)

  const finalState = await loadState(c, query.project_id)
  const finalEpoch = finalState === null ? 0 : epochNumber(finalState.epoch)
  const finalSeq = await maxChangeSeq(c, query.project_id)
  if (finalEpoch !== memoryEpoch || finalSeq !== initialSeq)
    return err(makeError('CONFLICT', '检索期间项目记忆发生了变化，请重试'))

  const observedAt = now
  const referencedDecisionIds = selection.entries.map((entry) => entry.decision_id)
  await c.query(
    `INSERT INTO managed_project_memory_retrieval(
      id, project_id, request_id, query, query_context, summary_id, summary_version,
      summary_stale, memory_epoch, candidate_count, expanded, expansion_reason,
      escalation_reason, omitted_count, referenced_decision_ids, budget_entries,
      used_entries, budget_tokens, used_tokens, observed_at
    ) VALUES(
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid[],
      $16,$17,$18,$19,$20
    )`,
    [
      randomUUID(),
      query.project_id,
      raw.request_id ?? null,
      query.text,
      JSON.stringify({
        ...(query.decision_key === undefined ? {} : { decision_key: query.decision_key }),
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.action_category === undefined ? {} : { action_category: query.action_category }),
        ...(query.impact === undefined ? {} : { impact: query.impact }),
      }),
      summary?.id ?? null,
      summary?.version ?? null,
      stale,
      memoryEpoch,
      selection.candidate_count,
      stale,
      mergedExpansionReason(staleReasons, selection),
      escalations.length === 0 ? null : escalations.join('; '),
      selection.omitted_count,
      referencedDecisionIds,
      query.budget_entries,
      selection.entries.length,
      query.budget_tokens,
      selection.used_tokens,
      observedAt,
    ],
  )

  return ok({
    project_id: query.project_id,
    query: query.text,
    summary_id: summary?.id ?? null,
    summary_version: summary?.version ?? null,
    summary_stale: stale,
    memory_epoch: memoryEpoch,
    candidate_count: selection.candidate_count,
    expanded: stale,
    expansion_reason: mergedExpansionReason(staleReasons, selection),
    escalation_reason: escalations.length === 0 ? null : escalations.join('; '),
    entries: selection.entries,
    omitted_count: selection.omitted_count,
    referenced_decision_ids: referencedDecisionIds,
    budget_entries: query.budget_entries,
    used_entries: selection.entries.length,
    budget_tokens: query.budget_tokens,
    used_tokens: selection.used_tokens,
    observed_at: observedAt,
  })
}

export async function retrieveProjectMemory(
  input: RetrieveProjectMemoryInput,
): Promise<Result<ProjectMemoryRetrieval>> {
  const query = queryInput(input)
  if (!query.ok) return query
  const now = new Date().toISOString()
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await asRole('keel_control', (c) => retrieveInTx(c, input, query.value, now))
    if (result.ok) return result
    if (result.error.kind !== 'CONFLICT' || attempt === 1) return result
  }
  return err(makeError('CONFLICT', '项目记忆检索冲突'))
}

export async function retrieveProjectMemoryInTx(
  c: PoolClient,
  input: RetrieveProjectMemoryInput,
  now = new Date().toISOString(),
): Promise<Result<ProjectMemoryRetrieval>> {
  const query = queryInput(input)
  if (!query.ok) return query
  if (timestamp(now) === null) return err(makeError('SCHEMA_VIOLATION', '检索时间非法'))
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await retrieveInTx(c, input, query.value, now)
    if (result.ok || result.error.kind !== 'CONFLICT' || attempt === 1) return result
  }
  return err(makeError('CONFLICT', '项目记忆检索冲突'))
}

export async function createProjectMemorySummary(
  input: CreateMemorySummaryInput,
): Promise<Result<ProjectMemorySummary>> {
  if (!UUID.test(input.project_id))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 必须是 UUID'))
  if (input.generated_by.trim().length === 0 || input.generated_by.length > 200)
    return err(makeError('SCHEMA_VIOLATION', 'generated_by 必须为 1..200 字符'))
  if (input.model_version !== undefined && input.model_version.trim().length > 300)
    return err(makeError('SCHEMA_VIOLATION', 'model_version 不能超过 300 字符'))
  if (timestamp(input.now) === null) return err(makeError('SCHEMA_VIOLATION', '生成时间非法'))
  try {
    return await asRole('keel_control', async (c) => {
      const lockedEpoch = await c.query<{ epoch: string | number }>(
        'SELECT managed_project_memory_lock($1,$2) AS epoch',
        [input.project_id, input.now],
      )
      const epoch = epochNumber(lockedEpoch.rows[0]?.epoch ?? 0)
      const state = await loadState(c, input.project_id)
      const decisions = await activeDecisionsAt(c, input.project_id, input.now)
      const built = buildProjectMemoryContent(input.project_id, decisions, input.now)
      if (!built.ok) return built
      const seq = await maxChangeSeq(c, input.project_id)
      const versionRow = await c.query<{ version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS version
         FROM managed_project_memory_summary WHERE project_id=$1`,
        [input.project_id],
      )
      const version = versionRow.rows[0]?.version ?? 1
      const summary: ProjectMemorySummary = {
        id: randomUUID(),
        project_id: input.project_id,
        version,
        status: 'DRAFT',
        content: built.value,
        content_digest: projectMemoryContentDigest(built.value),
        covered_decision_count: built.value.entries.length,
        covered_change_seq: seq,
        memory_epoch: epoch,
        model_version: input.model_version?.trim() || MEMORY_MODEL_VERSION,
        generated_by: input.generated_by.trim(),
        generated_at: input.now,
        previous_summary_id: state?.active_summary_id ?? null,
        rollback_of_summary_id: null,
        validation: {},
        reason: null,
        created_at: input.now,
      }
      const inserted = await c.query<SummaryRow>(
        `INSERT INTO managed_project_memory_summary(
          id, project_id, version, status, content, content_digest,
          covered_decision_count, covered_change_seq, memory_epoch, model_version,
          generated_by, generated_at, previous_summary_id, rollback_of_summary_id,
          validation, reason, created_at
        ) VALUES(
          $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17
        )
        RETURNING id, project_id, version, status, content, content_digest,
          covered_decision_count, covered_change_seq, memory_epoch, model_version,
          generated_by, generated_at, previous_summary_id, rollback_of_summary_id,
          validation, reason, created_at`,
        [
          summary.id,
          summary.project_id,
          summary.version,
          summary.status,
          JSON.stringify(summary.content),
          summary.content_digest,
          summary.covered_decision_count,
          summary.covered_change_seq,
          summary.memory_epoch,
          summary.model_version,
          summary.generated_by,
          summary.generated_at,
          summary.previous_summary_id,
          summary.rollback_of_summary_id,
          JSON.stringify(summary.validation),
          summary.reason,
          summary.created_at,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) throw new Error('memory summary insert disappeared')
      await c.query(
        `INSERT INTO managed_project_memory_event(
          project_id, kind, summary_id, actor, reason, occurred_at, details
        ) VALUES($1,'summary_created',$2,$3,NULL,$4,$5::jsonb)`,
        [
          input.project_id,
          summary.id,
          summary.generated_by,
          input.now,
          JSON.stringify({
            version: summary.version,
            memory_epoch: summary.memory_epoch,
            covered_decision_count: summary.covered_decision_count,
            covered_change_seq: summary.covered_change_seq,
          }),
        ],
      )
      return summaryFromRow(row)
    })
  } catch (error) {
    const known = keelError(error)
    if (known !== null) return err(known)
    if (pgCode(error) === '23505') return err(makeError('CONFLICT', '摘要版本并发冲突，请重试'))
    throw error
  }
}

function runRegression(
  content: ProjectMemoryContent,
  cases: readonly MemoryRegressionCase[],
): { readonly passed: boolean; readonly failures: readonly string[]; readonly checked: number } {
  const failures: string[] = []
  for (const [index, entry] of cases.entries()) {
    const selection = selectProjectMemoryEntries(content.entries, {
      project_id: content.entries[0]?.project_id ?? '',
      text: entry.query,
      ...(entry.decision_key === undefined ? {} : { decision_key: entry.decision_key }),
      budget_entries: 512,
      budget_tokens: 1_000_000,
    })
    const actual = new Set(selection.entries.map((candidate) => candidate.decision_id))
    for (const expected of entry.expected_decision_ids) {
      if (!actual.has(expected)) failures.push(`case ${index}: 缺少决定 ${expected}`)
    }
  }
  return { passed: failures.length === 0, failures, checked: cases.length }
}

export async function publishProjectMemorySummary(
  input: PublishMemorySummaryInput,
): Promise<Result<ProjectMemorySummary>> {
  if (!UUID.test(input.project_id) || !UUID.test(input.summary_id))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 与 summary_id 必须是 UUID'))
  if (!Number.isSafeInteger(input.expected_epoch) || input.expected_epoch < 0)
    return err(makeError('SCHEMA_VIOLATION', 'expected_epoch 必须是非负整数'))
  if (input.actor.trim().length === 0 || input.actor.length > 200)
    return err(makeError('SCHEMA_VIOLATION', 'actor 必须为 1..200 字符'))
  if (timestamp(input.now) === null) return err(makeError('SCHEMA_VIOLATION', '发布时间非法'))
  try {
    return await asRole('keel_control', async (c) => {
      const locked = await c.query<{ epoch: string | number }>(
        'SELECT managed_project_memory_lock($1,$2) AS epoch',
        [input.project_id, input.now],
      )
      const epoch = epochNumber(locked.rows[0]?.epoch ?? 0)
      if (epoch !== input.expected_epoch)
        return err(
          makeError('CONFLICT', `memory epoch 已变化：期望 ${input.expected_epoch}，当前 ${epoch}`),
        )
      const row = await loadSummary(c, input.project_id, input.summary_id)
      if (row === null) return err(makeError('NOT_FOUND', '找不到摘要'))
      if (row.status !== 'DRAFT')
        return err(makeError('CONFLICT', `摘要当前是 ${row.status}，不能发布`))
      if (epochNumber(row.memory_epoch) !== epoch)
        return err(makeError('CONFLICT', '摘要构建时的 epoch 已过期'))
      const parsed = summaryFromRow(row)
      if (!parsed.ok) return parsed
      if (parsed.value.content_digest !== projectMemoryContentDigest(parsed.value.content))
        return err(makeError('SCHEMA_VIOLATION', '摘要 content_digest 不匹配'))
      const decisions = await activeDecisionsAt(c, input.project_id, input.now)
      const rebuilt = buildProjectMemoryContent(input.project_id, decisions, input.now)
      if (!rebuilt.ok) return rebuilt
      const rebuiltDigest = projectMemoryContentDigest(rebuilt.value)
      if (rebuiltDigest !== parsed.value.content_digest)
        return err(makeError('CONFLICT', '摘要不是当前权威决定的完整投影，请重建'))
      const regression =
        input.regression_cases === undefined
          ? null
          : runRegression(parsed.value.content, input.regression_cases)
      if (regression !== null && !regression.passed)
        return err(makeError('PROTOCOL_ERROR', `摘要回归失败：${regression.failures.join('; ')}`))
      const validation = {
        schema: 'ok',
        source_projection: 'exact',
        content_digest: 'ok',
        checked_at: input.now,
        regression,
      }
      await c.query('SELECT managed_publish_memory_summary($1,$2,$3,$4,$5,$6::jsonb)', [
        input.project_id,
        input.summary_id,
        input.expected_epoch,
        input.actor.trim(),
        input.now,
        JSON.stringify(validation),
      ])
      const published = await loadSummary(c, input.project_id, input.summary_id)
      if (published === null) throw new Error('published memory summary disappeared')
      return summaryFromRow(published)
    })
  } catch (error) {
    const known = keelError(error)
    if (known !== null) return err(known)
    const code = pgCode(error)
    if (code === '40001' || code === 'P0001')
      return err(makeError('CONFLICT', '摘要发布 epoch 或状态冲突'))
    throw error
  }
}

export async function rollbackProjectMemorySummary(
  input: RollbackMemorySummaryInput,
): Promise<Result<ProjectMemoryState>> {
  if (!UUID.test(input.project_id) || !UUID.test(input.summary_id))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 与 summary_id 必须是 UUID'))
  if (!Number.isSafeInteger(input.expected_epoch) || input.expected_epoch < 0)
    return err(makeError('SCHEMA_VIOLATION', 'expected_epoch 必须是非负整数'))
  if (
    !input.actor.trim() ||
    input.actor.length > 200 ||
    !input.reason.trim() ||
    input.reason.trim().length > 2000 ||
    timestamp(input.now) === null
  )
    return err(makeError('SCHEMA_VIOLATION', 'actor、reason 和时间必须有效'))
  try {
    const rolled = await asRole('keel_control', async (c) => {
      const locked = await c.query<{ epoch: string | number }>(
        'SELECT managed_project_memory_lock($1,$2) AS epoch',
        [input.project_id, input.now],
      )
      const epoch = epochNumber(locked.rows[0]?.epoch ?? 0)
      if (epoch !== input.expected_epoch)
        return err(
          makeError('CONFLICT', `memory epoch 已变化：期望 ${input.expected_epoch}，当前 ${epoch}`),
        )
      await c.query('SELECT managed_rollback_memory_summary($1,$2,$3,$4,$5,$6)', [
        input.project_id,
        input.summary_id,
        input.expected_epoch,
        input.actor.trim(),
        input.reason.trim(),
        input.now,
      ])
      return ok(undefined)
    })
    if (!rolled.ok) return rolled
    return getProjectMemoryState(input.project_id)
  } catch (error) {
    const known = keelError(error)
    if (known !== null) return err(known)
    const code = pgCode(error)
    if (code === '40001' || code === 'P0001')
      return err(makeError('CONFLICT', '摘要回滚 epoch 或状态冲突'))
    throw error
  }
}

export async function rejectProjectMemorySummary(
  input: RejectMemorySummaryInput,
): Promise<Result<void>> {
  if (!UUID.test(input.project_id) || !UUID.test(input.summary_id))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 与 summary_id 必须是 UUID'))
  if (!input.actor.trim() || input.actor.length > 200 || timestamp(input.now) === null)
    return err(makeError('SCHEMA_VIOLATION', 'actor 和时间必须有效'))
  if (input.reason !== undefined && input.reason.trim().length > 2000)
    return err(makeError('SCHEMA_VIOLATION', 'reason 不能超过 2000 字符'))
  try {
    await asRole('keel_control', (c) =>
      c.query('SELECT managed_reject_memory_summary($1,$2,$3,$4,$5)', [
        input.project_id,
        input.summary_id,
        input.actor.trim(),
        input.reason?.trim() || null,
        input.now,
      ]),
    )
    return ok(undefined)
  } catch (error) {
    const code = pgCode(error)
    if (code === 'P0001') return err(makeError('CONFLICT', '只有 DRAFT 摘要可以拒绝'))
    throw error
  }
}

export async function getProjectMemoryState(
  projectId: string,
): Promise<Result<ProjectMemoryState>> {
  if (!UUID.test(projectId)) return err(makeError('SCHEMA_VIOLATION', 'project_id 必须是 UUID'))
  const now = new Date().toISOString()
  return asRole('keel_control', async (c) => {
    const state = await loadState(c, projectId)
    if (state === null) {
      return ok({
        project_id: projectId,
        epoch: 0,
        active_summary_id: null,
        active_summary_version: null,
        active_summary: null,
        stale: true,
        stale_reason: 'no_memory_state',
        updated_at: now,
      })
    }
    const epoch = epochNumber(state.epoch)
    const seq = await maxChangeSeq(c, projectId)
    if (state.active_summary_id === null) {
      return ok({
        project_id: projectId,
        epoch,
        active_summary_id: null,
        active_summary_version: null,
        active_summary: null,
        stale: true,
        stale_reason: 'no_active_summary',
        updated_at: iso(state.updated_at),
      })
    }
    const raw = await loadSummary(c, projectId, state.active_summary_id)
    if (raw === null) {
      return ok({
        project_id: projectId,
        epoch,
        active_summary_id: state.active_summary_id,
        active_summary_version: state.active_summary_version,
        active_summary: null,
        stale: true,
        stale_reason: 'active_summary_missing',
        updated_at: iso(state.updated_at),
      })
    }
    const parsed = summaryFromRow(raw)
    if (!parsed.ok) {
      return ok({
        project_id: projectId,
        epoch,
        active_summary_id: state.active_summary_id,
        active_summary_version: state.active_summary_version,
        active_summary: null,
        stale: true,
        stale_reason: `invalid_summary: ${parsed.error.detail}`,
        updated_at: iso(state.updated_at),
      })
    }
    const references = parsed.value.content.entries.map((entry) => entry.decision_id)
    const decisions = await decisionsByIds(c, projectId, references)
    const summaryCheck = validateProjectMemoryContent(
      parsed.value.content,
      projectId,
      decisions,
      now,
    )
    const reasons: string[] = []
    if (!summaryCheck.ok) reasons.push(`summary_source_mismatch: ${summaryCheck.error.detail}`)
    const active = activeDecisionBodies(decisions, now)
    if (raw.status !== 'ACTIVE') reasons.push(`summary_status_${raw.status.toLowerCase()}`)
    if (parsed.value.memory_epoch !== epoch) reasons.push('epoch_mismatch')
    if (parsed.value.covered_change_seq < seq) reasons.push('watermark_behind')
    if (active.length !== references.length) reasons.push('referenced_decision_changed')
    return ok({
      project_id: projectId,
      epoch,
      active_summary_id: state.active_summary_id,
      active_summary_version: state.active_summary_version,
      active_summary: parsed.value,
      stale: reasons.length > 0,
      stale_reason: reasons.length === 0 ? null : reasons.join('; '),
      updated_at: iso(state.updated_at),
    })
  })
}

function humanActor(
  value: unknown,
): { readonly type: string; readonly authenticated_id: string } | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || !('authenticated_id' in value)) return null
  const type = (value as { type?: unknown }).type
  const authenticatedId = (value as { authenticated_id?: unknown }).authenticated_id
  if (
    typeof type !== 'string' ||
    typeof authenticatedId !== 'string' ||
    authenticatedId.trim().length === 0
  )
    return null
  return { type, authenticated_id: authenticatedId }
}

export async function promoteHumanAnswerToProjectRule(
  input: PromoteHumanAnswerInput,
): Promise<Result<ProjectDecision>> {
  if (!UUID.test(input.request_id))
    return err(makeError('SCHEMA_VIOLATION', 'request_id 必须是 UUID'))
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    return err(makeError('SCHEMA_VIOLATION', 'revision 必须是正整数'))
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.decision_key))
    return err(makeError('SCHEMA_VIOLATION', 'decision_key 非法'))
  if (!input.actor.trim() || input.actor.length > 200 || timestamp(input.now) === null)
    return err(makeError('SCHEMA_VIOLATION', 'actor 和时间必须有效'))
  try {
    return await asRole('keel_control', async (c) => {
      const request = await getDecisionRequest(input.request_id, input.revision, c)
      if (request === null) return err(makeError('NOT_FOUND', '找不到 decision request'))
      if (request.status !== 'RESOLVED')
        return err(makeError('CONFLICT', '只有已结束的请求可以提升为项目规则'))
      const row = await c.query<{
        disposition: DecisionResolution['disposition']
        actor: unknown
        answer_option_id: string | null
        answer: string | null
      }>(
        `SELECT disposition, actor, answer_option_id, answer
         FROM managed_decision_resolution
         WHERE request_id=$1 AND request_revision=$2`,
        [input.request_id, input.revision],
      )
      const resolution = row.rows[0]
      if (resolution === undefined) return err(makeError('NOT_FOUND', '找不到该请求的决议'))
      const actor = humanActor(resolution.actor)
      if (
        resolution.disposition !== 'human_confirmed' ||
        actor === null ||
        actor.type !== 'human' ||
        resolution.answer_option_id === null ||
        resolution.answer === null
      )
        return err(makeError('PERMISSION_DENIED', '只有真实人工确认的答案才能提升为项目规则'))
      const sourceRef = `managed-decision-resolution:${input.request_id}:${input.revision}`
      const existing = await c.query<{ body: unknown }>(
        `SELECT ${DECISION_JSON}
         WHERE d.project_id=$1 AND d.source_ref=$2 ORDER BY d.version DESC LIMIT 1`,
        [request.project_id, sourceRef],
      )
      if (existing.rows[0] !== undefined) {
        const existingDecision = existing.rows[0].body as ProjectDecision
        if (existingDecision.decision_key !== input.decision_key)
          return err(makeError('CONFLICT', '该人工答案已提升为另一个 decision_key'))
        return ok(existingDecision)
      }
      const versionRow = await c.query<{ version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS version
         FROM managed_project_decision
         WHERE project_id=$1 AND decision_key=$2`,
        [request.project_id, input.decision_key],
      )
      const version = versionRow.rows[0]?.version ?? 1
      const validFrom = input.valid_from ?? input.now
      if (timestamp(validFrom) === null)
        return err(makeError('SCHEMA_VIOLATION', 'valid_from 非法'))
      if (input.valid_until !== undefined && timestamp(input.valid_until) === null)
        return err(makeError('SCHEMA_VIOLATION', 'valid_until 非法'))
      const statement = input.statement?.trim() || resolution.answer
      if (statement.length > 16000)
        return err(makeError('SCHEMA_VIOLATION', '项目规则 statement 不能超过 16000 字符'))
      const decision: ProjectDecision = {
        schema_version: '1.0',
        id: randomUUID(),
        project_id: request.project_id,
        decision_key: input.decision_key,
        version,
        statement,
        selected_option_id: resolution.answer_option_id,
        options: request.options as unknown as ProjectDecision['options'],
        scope:
          input.scope ??
          ({
            decision_kinds: [request.kind],
            actions: [request.action_category],
            resource_selectors: [...request.impact.affected_resources],
            environments: [request.impact.environment],
            reversibilities: [request.impact.reversibility],
          } as ProjectDecision['scope']),
        source_type: REQUIRED_CONFIDENCE,
        source_ref: sourceRef,
        created_by: input.actor.trim(),
        valid_from: validFrom,
        ...(input.valid_until === undefined ? {} : { valid_until: input.valid_until }),
        ...(input.supersedes_id === undefined ? {} : { supersedes_id: input.supersedes_id }),
        created_at: input.now,
      }
      const checked = validateProjectDecision(decision)
      if (!checked.ok) return checked
      if (!decision.options.some((option) => option.id === decision.selected_option_id))
        return err(makeError('SCHEMA_VIOLATION', '人工答案不在请求选项内'))
      await recordProjectDecisionInTx(c, decision)
      await c.query(
        `INSERT INTO managed_project_memory_event(
          project_id, kind, summary_id, actor, reason, occurred_at, details
        ) VALUES($1,'rule_promoted',NULL,$2,$3,$4,$5::jsonb)`,
        [
          decision.project_id,
          decision.created_by,
          `promoted from ${sourceRef}`,
          input.now,
          JSON.stringify({
            decision_id: decision.id,
            decision_key: decision.decision_key,
            version: decision.version,
            request_id: input.request_id,
            request_revision: input.revision,
            source_actor: actor.authenticated_id,
          }),
        ],
      )
      return ok(decision)
    })
  } catch (error) {
    const known = keelError(error)
    if (known !== null) return err(known)
    const code = pgCode(error)
    if (code === '23505' || code === '40001' || code === 'P0001')
      return err(makeError('CONFLICT', '项目规则提升发生版本冲突'))
    throw error
  }
}

export { MEMORY_MODEL_VERSION, projectMemoryContentDigest }
