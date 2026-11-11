import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Result } from '../../contracts/errors.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type {
  DecisionRequest,
  DecisionResolution,
  ProjectDecision,
  ProjectMemoryContent,
  TianwenProposal,
} from '../../generated/managed.js'
import {
  answerManagedQuestionWithDecision,
  openDecisionRequestFromManagedQuestion,
  readDecisionResolution,
  recordProjectDecision,
  resolveTianwenProposal,
  revokeProjectDecision,
  submitTianwenProposal,
} from './decision-store.js'
import {
  buildProjectMemoryContent,
  MEMORY_MODEL_VERSION,
  projectMemoryContentDigest,
} from './memory-protocol.js'
import {
  createProjectMemorySummary,
  getProjectMemoryState,
  promoteHumanAnswerToProjectRule,
  publishProjectMemorySummary,
  rejectProjectMemorySummary,
  retrieveProjectMemory,
  rollbackProjectMemorySummary,
} from './memory-store.js'

const NOW = '2026-11-11T00:00:00.000Z'
const LATER = '2026-11-11T01:00:00.000Z'
const PAST = '2026-01-01T00:00:00.000Z'
const PACKAGE_DIGEST = 'a'.repeat(64)

const LANGUAGE_OPTIONS: ProjectDecision['options'] = [
  { id: 'option-1', text: '中文' },
  { id: 'option-2', text: 'English' },
]

interface SeededQuestion {
  readonly projectId: string
  readonly taskId: string
  readonly questionId: string
}

interface RetrievalLogRow {
  readonly summary_id: string | null
  readonly summary_version: number | null
  readonly summary_stale: boolean
  readonly memory_epoch: string | number
  readonly candidate_count: number
  readonly expanded: boolean
  readonly expansion_reason: string | null
  readonly escalation_reason: string | null
  readonly omitted_count: number
  readonly referenced_decision_ids: string[]
  readonly budget_entries: number
  readonly used_entries: number
  readonly budget_tokens: number
  readonly used_tokens: number
  readonly observed_at: Date
}

interface EventRow {
  readonly kind: string
  readonly summary_id: string | null
  readonly actor: string
  readonly reason: string | null
  readonly details: Record<string, unknown>
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

function mustValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.detail}`)
  return result.value
}

async function seedProject(label: string): Promise<string> {
  const projectId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'local',$2,'main')`,
      [projectId, `file:///tmp/${label}-${projectId}`],
    ),
  )
  return projectId
}

async function seedQuestion(
  projectId: string,
  question = '报告使用哪种语言？',
  options: readonly string[] = ['中文', 'English'],
): Promise<SeededQuestion> {
  const taskId = randomUUID()
  const questionId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO managed_package(digest,body)
       VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING`,
      [PACKAGE_DIGEST],
    )
    await c.query(
      `INSERT INTO managed_task(
        id,repo_id,package_digest,workspace_path,question,file_index,status,phase
      ) VALUES($1,$2,$3,'/tmp',$4,'["README.md"]'::jsonb,'WAITING_TIANWEN','tianwen')`,
      [taskId, projectId, PACKAGE_DIGEST, question],
    )
    await c.query(
      `INSERT INTO managed_question(id,task_id,question,options)
       VALUES($1,$2,$3,$4::jsonb)`,
      [questionId, taskId, question, JSON.stringify(options)],
    )
    await c.query(`UPDATE managed_task SET pending_question_id=$2 WHERE id=$1`, [
      taskId,
      questionId,
    ])
  })
  return { projectId, taskId, questionId }
}

function decision(projectId: string, over: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    schema_version: '1.0',
    id: randomUUID(),
    project_id: projectId,
    decision_key: 'report.language',
    version: 1,
    statement: '项目报告使用中文。',
    selected_option_id: 'option-1',
    options: LANGUAGE_OPTIONS.map((option) => ({ ...option })) as ProjectDecision['options'],
    scope: {
      decision_kinds: ['preference'],
      actions: ['write_file'],
      resource_selectors: ['docs/*'],
      environments: ['local'],
      reversibilities: ['reversible'],
    },
    source_type: 'owner_confirmed',
    source_ref: 'owner-message:test',
    created_by: 'owner',
    valid_from: PAST,
    created_at: PAST,
    ...over,
  }
}

async function recordDecision(value: ProjectDecision): Promise<ProjectDecision> {
  return mustValue(await recordProjectDecision(value))
}

function requestInput(decisionKey = 'report.language') {
  return {
    decision_key: decisionKey,
    kind: 'preference' as const,
    action_category: 'write_file',
    impact: {
      environment: 'local' as const,
      reversibility: 'reversible' as const,
      affected_resources: ['docs/report.md'],
    },
  }
}

async function openRequest(seed: SeededQuestion): Promise<DecisionRequest> {
  return mustValue(
    await openDecisionRequestFromManagedQuestion(seed.questionId, requestInput(), NOW),
  )
}

function proposal(
  request: DecisionRequest,
  basisRefs: TianwenProposal['basis_refs'],
): TianwenProposal {
  return {
    schema_version: '1.0',
    request_id: request.id,
    request_revision: request.revision,
    input_digest: request.input_digest,
    recommendation: 'answer',
    answer_option_id: 'option-1',
    rationale: '采用当前项目明确决定',
    claimed_evidence_grade: 'E3',
    basis_refs: basisRefs,
    observed_fact_refs: [],
    assumptions: [],
    alternatives: [],
    unresolved_conflicts: [],
    missing_authority: [],
  }
}

async function resolveDelegated(
  request: DecisionRequest,
  basisDecision: ProjectDecision,
): Promise<DecisionResolution> {
  const submitted = mustValue(
    await submitTianwenProposal(
      request.id,
      request.revision,
      proposal(request, [
        { kind: 'project_decision', id: basisDecision.id, version: basisDecision.version },
      ]),
      NOW,
    ),
  )
  return mustValue(
    await resolveTianwenProposal(request.id, request.revision, submitted, randomUUID(), NOW),
  )
}

async function makeHumanResolution(
  seed: SeededQuestion,
  answer = '中文',
): Promise<{ readonly request: DecisionRequest; readonly resolution: DecisionResolution }> {
  const request = await openRequest(seed)
  await asOwner(async (c) => {
    await c.query(`UPDATE managed_question SET status='WAITING_HUMAN' WHERE id=$1`, [
      seed.questionId,
    ])
    await c.query(`UPDATE managed_task SET status='WAITING_HUMAN' WHERE id=$1`, [seed.taskId])
  })
  mustValue(await answerManagedQuestionWithDecision(seed.questionId, answer))
  const resolution = await readDecisionResolution(request.id, request.revision)
  if (resolution === null) throw new Error('人工答复没有产生决议')
  return { request, resolution }
}

async function createSummary(projectId: string, generatedBy = 'memory-test') {
  return mustValue(
    await createProjectMemorySummary({
      project_id: projectId,
      generated_by: generatedBy,
      now: NOW,
    }),
  )
}

async function publishSummary(
  projectId: string,
  summaryId: string,
  expectedEpoch: number,
  actor: string,
  now = NOW,
) {
  return mustValue(
    await publishProjectMemorySummary({
      project_id: projectId,
      summary_id: summaryId,
      expected_epoch: expectedEpoch,
      actor,
      now,
    }),
  )
}

async function retrieve(input: Parameters<typeof retrieveProjectMemory>[0]) {
  return mustValue(await retrieveProjectMemory(input))
}

async function memoryContent(
  projectId: string,
  decisions: readonly ProjectDecision[],
): Promise<ProjectMemoryContent> {
  return mustValue(buildProjectMemoryContent(projectId, decisions, NOW))
}

async function insertRawSummary(
  projectId: string,
  content: ProjectMemoryContent,
  version: number,
  previousSummaryId?: string,
): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO managed_project_memory_summary(
        id,project_id,version,status,content,content_digest,covered_decision_count,
        covered_change_seq,memory_epoch,model_version,generated_by,generated_at,
        previous_summary_id,rollback_of_summary_id,validation,reason,created_at
      ) VALUES(
        $1,$2,$3,'DRAFT',$4::jsonb,$5,$6,0,0,$7,'raw-test',$8,$9,NULL,'{}'::jsonb,NULL,$8
      )`,
      [
        randomUUID(),
        projectId,
        version,
        JSON.stringify(content),
        projectMemoryContentDigest(content),
        content.entries.length,
        MEMORY_MODEL_VERSION,
        NOW,
        previousSummaryId ?? null,
      ],
    ),
  )
}

async function eventRows(projectId: string): Promise<EventRow[]> {
  const rows = await asRole('keel_control', (c) =>
    c.query<EventRow>(
      `SELECT kind,summary_id,actor,reason,details
       FROM managed_project_memory_event
       WHERE project_id=$1 ORDER BY seq`,
      [projectId],
    ),
  )
  return rows.rows
}

describe('项目记忆 PostgreSQL store', () => {
  it('项目 A/B 隔离，检索只返回本项目决定，跨项目 request_id 被拒', async () => {
    const projectA = await seedProject('isolation-a')
    const projectB = await seedProject('isolation-b')
    const decisionA = await recordDecision(
      decision(projectA, { statement: '项目 A 报告使用中文。', selected_option_id: 'option-1' }),
    )
    const decisionB = await recordDecision(
      decision(projectB, {
        statement: 'Project B reports use English.',
        selected_option_id: 'option-2',
      }),
    )

    const summaryA = await createSummary(projectA)
    const summaryB = await createSummary(projectB)
    await publishSummary(projectA, summaryA.id, summaryA.memory_epoch, 'publisher-a')
    await publishSummary(projectB, summaryB.id, summaryB.memory_epoch, 'publisher-b')

    const retrievedA = await retrieve({
      project_id: projectA,
      query: '报告语言',
      decision_key: 'report.language',
    })
    const retrievedB = await retrieve({
      project_id: projectB,
      query: '报告语言',
      decision_key: 'report.language',
    })

    expect(retrievedA.referenced_decision_ids).toEqual([decisionA.id])
    expect(retrievedA.entries.map((entry) => entry.project_id)).toEqual([projectA])
    expect(retrievedA.entries.map((entry) => entry.selected_option_id)).toEqual(['option-1'])
    expect(retrievedB.referenced_decision_ids).toEqual([decisionB.id])
    expect(retrievedB.entries.map((entry) => entry.project_id)).toEqual([projectB])
    expect(retrievedB.entries.map((entry) => entry.selected_option_id)).toEqual(['option-2'])

    const logs = await asRole('keel_control', (c) =>
      c.query<{ project_id: string; referenced_decision_ids: string[] }>(
        `SELECT project_id,referenced_decision_ids
         FROM managed_project_memory_retrieval
         WHERE project_id=ANY($1::uuid[]) ORDER BY project_id`,
        [[projectA, projectB]],
      ),
    )
    expect(logs.rowCount).toBe(2)
    expect(logs.rows.find((row) => row.project_id === projectA)?.referenced_decision_ids).toEqual([
      decisionA.id,
    ])
    expect(logs.rows.find((row) => row.project_id === projectB)?.referenced_decision_ids).toEqual([
      decisionB.id,
    ])

    const questionA = await seedQuestion(projectA)
    const requestA = await openRequest(questionA)
    await expect(
      retrieveProjectMemory({
        project_id: projectB,
        query: '报告语言',
        request_id: requestA.id,
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' })
    const afterDenied = await asRole('keel_control', (c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM managed_project_memory_retrieval
         WHERE project_id=ANY($1::uuid[])`,
        [[projectA, projectB]],
      ),
    )
    expect(afterDenied.rows[0]?.count).toBe('2')
  })

  it('摘要落后 epoch 时增量展开，只返回新增/替代后的决定，不返回已替代或撤销决定', async () => {
    const projectId = await seedProject('incremental')
    const oldLanguage = await recordDecision(decision(projectId))
    const oldRelease = await recordDecision(
      decision(projectId, {
        decision_key: 'release.channel',
        statement: '报告发布使用稳定渠道。',
      }),
    )
    const summaryV1 = await createSummary(projectId)
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publisher-v1')

    const replacement = await recordDecision(
      decision(projectId, {
        version: 2,
        statement: '报告改用英文。',
        selected_option_id: 'option-2',
        supersedes_id: oldLanguage.id,
        created_at: LATER,
      }),
    )
    const added = await recordDecision(
      decision(projectId, {
        decision_key: 'release.tests',
        statement: '报告发布前必须运行测试。',
        created_at: LATER,
      }),
    )
    mustValue(await revokeProjectDecision(oldRelease.id, 'owner', '渠道规则撤销', LATER))

    const retrieved = await retrieve({
      project_id: projectId,
      query: '报告',
      budget_entries: 8,
      budget_tokens: 20_000,
    })
    const ids = new Set(retrieved.referenced_decision_ids)

    expect(retrieved.summary_id).toBe(summaryV1.id)
    expect(retrieved.summary_version).toBe(1)
    expect(retrieved.summary_stale).toBe(true)
    expect(retrieved.expanded).toBe(true)
    expect(retrieved.expansion_reason).toContain('epoch_mismatch')
    expect(retrieved.memory_epoch).toBeGreaterThan(summaryV1.memory_epoch)
    expect(ids.has(replacement.id)).toBe(true)
    expect(ids.has(added.id)).toBe(true)
    expect(ids.has(oldLanguage.id)).toBe(false)
    expect(ids.has(oldRelease.id)).toBe(false)
    expect(retrieved.entries.find((entry) => entry.decision_id === oldLanguage.id)).toBeUndefined()
    expect(retrieved.entries.find((entry) => entry.decision_id === oldRelease.id)).toBeUndefined()
  })

  it('撤销决定后，即使回滚到包含该决定的旧摘要也不会复活', async () => {
    const projectId = await seedProject('revoked-rollback')
    const revoked = await recordDecision(decision(projectId))
    const summaryV1 = await createSummary(projectId)
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publisher-v1')

    mustValue(await revokeProjectDecision(revoked.id, 'owner', '不再需要该规则', LATER))
    const summaryV2 = mustValue(
      await createProjectMemorySummary({
        project_id: projectId,
        generated_by: 'memory-test',
        now: LATER,
      }),
    )
    await publishSummary(projectId, summaryV2.id, summaryV2.memory_epoch, 'publisher-v2', LATER)

    const rolled = mustValue(
      await rollbackProjectMemorySummary({
        project_id: projectId,
        summary_id: summaryV1.id,
        expected_epoch: summaryV2.memory_epoch,
        actor: 'owner',
        reason: '回滚摘要版本',
        now: LATER,
      }),
    )
    expect(rolled.active_summary_id).toBe(summaryV1.id)

    const retrieved = await retrieve({
      project_id: projectId,
      query: '报告',
      decision_key: 'report.language',
    })
    expect(retrieved.summary_id).toBe(summaryV1.id)
    expect(retrieved.summary_stale).toBe(true)
    expect(retrieved.referenced_decision_ids).toEqual([])
    expect(retrieved.entries).toEqual([])
  })

  it('回滚只切换摘要指针，不修改或删除权威决定行', async () => {
    const projectId = await seedProject('pointer-only')
    const source = await recordDecision(decision(projectId))
    const summaryV1 = await createSummary(projectId)
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publisher-v1')
    const summaryV2 = await createSummary(projectId)
    await publishSummary(projectId, summaryV2.id, summaryV2.memory_epoch, 'publisher-v2')

    const stateBefore = mustValue(await getProjectMemoryState(projectId))
    expect(stateBefore.active_summary_id).toBe(summaryV2.id)
    expect(stateBefore.active_summary_version).toBe(2)
    const decisionsBefore = await asRole('keel_control', (c) =>
      c.query<{ body: unknown }>(
        `SELECT to_jsonb(d) AS body FROM managed_project_decision d
         WHERE d.project_id=$1 ORDER BY d.id`,
        [projectId],
      ),
    )

    const rolled = mustValue(
      await rollbackProjectMemorySummary({
        project_id: projectId,
        summary_id: summaryV1.id,
        expected_epoch: summaryV2.memory_epoch,
        actor: 'owner',
        reason: '恢复上一摘要',
        now: NOW,
      }),
    )
    const decisionsAfter = await asRole('keel_control', (c) =>
      c.query<{ body: unknown }>(
        `SELECT to_jsonb(d) AS body FROM managed_project_decision d
         WHERE d.project_id=$1 ORDER BY d.id`,
        [projectId],
      ),
    )

    expect(rolled.active_summary_id).toBe(summaryV1.id)
    expect(rolled.active_summary_version).toBe(1)
    expect(decisionsAfter.rows).toEqual(decisionsBefore.rows)
    expect(decisionsAfter.rows).toHaveLength(1)
    const decisions = await asRole('keel_control', (c) =>
      c.query<{ id: string }>('SELECT id FROM managed_project_decision WHERE project_id=$1', [
        projectId,
      ]),
    )
    expect(decisions.rows.map((row) => row.id)).toEqual([source.id])

    const summaries = await asRole('keel_control', (c) =>
      c.query<{ id: string; status: string; rollback_of_summary_id: string | null }>(
        `SELECT id,status,rollback_of_summary_id
         FROM managed_project_memory_summary WHERE project_id=$1 ORDER BY version`,
        [projectId],
      ),
    )
    expect(summaries.rows.find((row) => row.id === summaryV1.id)).toMatchObject({
      status: 'ACTIVE',
      rollback_of_summary_id: summaryV2.id,
    })
    expect(summaries.rows.find((row) => row.id === summaryV2.id)?.status).toBe('ROLLED_BACK')
  })

  it('发布使用 epoch CAS：旧 epoch 返回 CONFLICT 且旧 ACTIVE 指针不变', async () => {
    const projectId = await seedProject('publish-cas')
    await recordDecision(decision(projectId))
    const summaryV1 = await createSummary(projectId)
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publisher-v1')
    const summaryV2 = await createSummary(projectId)
    await recordDecision(
      decision(projectId, {
        decision_key: 'release.tests',
        statement: '发布前运行测试。',
        created_at: LATER,
      }),
    )

    const conflict = await publishProjectMemorySummary({
      project_id: projectId,
      summary_id: summaryV2.id,
      expected_epoch: summaryV2.memory_epoch,
      actor: 'stale-publisher',
      now: LATER,
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.error.kind).toBe('CONFLICT')

    const state = mustValue(await getProjectMemoryState(projectId))
    expect(state.active_summary_id).toBe(summaryV1.id)
    expect(state.active_summary_version).toBe(1)
    const draft = await asRole('keel_control', (c) =>
      c.query<{ status: string }>('SELECT status FROM managed_project_memory_summary WHERE id=$1', [
        summaryV2.id,
      ]),
    )
    expect(draft.rows[0]?.status).toBe('DRAFT')
  })

  it('发布回归失败时保留上一 ACTIVE 摘要与当前 DRAFT', async () => {
    const projectId = await seedProject('publish-regression')
    await recordDecision(decision(projectId))
    const summaryV1 = await createSummary(projectId)
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publisher-v1')
    const summaryV2 = await createSummary(projectId)

    const failed = await publishProjectMemorySummary({
      project_id: projectId,
      summary_id: summaryV2.id,
      expected_epoch: summaryV2.memory_epoch,
      actor: 'publisher-v2',
      now: NOW,
      regression_cases: [
        {
          query: '报告语言',
          decision_key: 'report.language',
          expected_decision_ids: [randomUUID()],
        },
      ],
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.kind).toBe('PROTOCOL_ERROR')

    const state = mustValue(await getProjectMemoryState(projectId))
    expect(state.active_summary_id).toBe(summaryV1.id)
    const draft = await asRole('keel_control', (c) =>
      c.query<{ status: string }>('SELECT status FROM managed_project_memory_summary WHERE id=$1', [
        summaryV2.id,
      ]),
    )
    expect(draft.rows[0]?.status).toBe('DRAFT')
  })

  it('DRAFT 可拒绝且拒绝后不能发布', async () => {
    const projectId = await seedProject('reject-state')
    const summaryV1 = await createSummary(projectId)
    mustValue(
      await rejectProjectMemorySummary({
        project_id: projectId,
        summary_id: summaryV1.id,
        actor: 'owner',
        reason: '候选不合格',
        now: NOW,
      }),
    )
    const rejected = await asRole('keel_control', (c) =>
      c.query<{ status: string; reason: string | null }>(
        'SELECT status,reason FROM managed_project_memory_summary WHERE id=$1',
        [summaryV1.id],
      ),
    )
    expect(rejected.rows[0]).toEqual({ status: 'REJECTED', reason: '候选不合格' })

    const publishRejected = await publishProjectMemorySummary({
      project_id: projectId,
      summary_id: summaryV1.id,
      expected_epoch: summaryV1.memory_epoch,
      actor: 'publisher',
      now: NOW,
    })
    expect(publishRejected.ok).toBe(false)
    if (!publishRejected.ok) expect(publishRejected.error.kind).toBe('CONFLICT')
  })

  it('ACTIVE 等非 DRAFT 摘要不能再次拒绝', async () => {
    const projectId = await seedProject('reject-active')
    const summary = await createSummary(projectId)
    await publishSummary(projectId, summary.id, summary.memory_epoch, 'publisher')
    const rejectActive = await rejectProjectMemorySummary({
      project_id: projectId,
      summary_id: summary.id,
      actor: 'owner',
      reason: '不应允许',
      now: NOW,
    })
    expect(rejectActive.ok).toBe(false)
    if (!rejectActive.ok) expect(rejectActive.error.kind).toBe('CONFLICT')
    const state = mustValue(await getProjectMemoryState(projectId))
    expect(state.active_summary_id).toBe(summary.id)
  })

  it('人工 confirmed 答复提升为 owner_confirmed 规则并可被检索', async () => {
    const projectId = await seedProject('human-promotion')
    const seed = await seedQuestion(projectId)
    const human = await makeHumanResolution(seed)
    expect(human.resolution.disposition).toBe('human_confirmed')
    expect(human.resolution.actor?.type).toBe('human')

    const promoted = mustValue(
      await promoteHumanAnswerToProjectRule({
        request_id: human.request.id,
        revision: human.request.revision,
        decision_key: 'report.language',
        actor: 'owner-promoter',
        now: NOW,
        valid_from: PAST,
      }),
    )
    expect(promoted.source_type).toBe('owner_confirmed')
    expect(promoted.source_ref).toBe(
      `managed-decision-resolution:${human.request.id}:${human.request.revision}`,
    )
    expect(promoted.created_by).toBe('owner-promoter')
    expect(promoted.selected_option_id).toBe('option-1')
    expect(promoted.statement).toBe('中文')

    const retrieved = await retrieve({
      project_id: projectId,
      query: '报告语言',
      decision_key: 'report.language',
    })
    expect(retrieved.referenced_decision_ids).toEqual([promoted.id])
    expect(retrieved.entries[0]?.source_type).toBe('owner_confirmed')

    const events = await eventRows(projectId)
    const promotedEvent = events.find((event) => event.kind === 'rule_promoted')
    expect(promotedEvent).toMatchObject({
      summary_id: null,
      actor: 'owner-promoter',
      reason: `promoted from ${promoted.source_ref}`,
    })
    expect(promotedEvent?.details).toMatchObject({
      decision_id: promoted.id,
      decision_key: 'report.language',
      version: 1,
      request_id: human.request.id,
      request_revision: human.request.revision,
      source_actor: 'local-operator',
    })

    const conflictingPromotion = await promoteHumanAnswerToProjectRule({
      request_id: human.request.id,
      revision: human.request.revision,
      decision_key: 'report.other',
      actor: 'owner-promoter',
      now: NOW,
    })
    expect(conflictingPromotion.ok).toBe(false)
    if (!conflictingPromotion.ok) expect(conflictingPromotion.error.kind).toBe('CONFLICT')
  })

  it('天问 delegated 决议与伪造非 human actor 均不能提升', async () => {
    const projectA = await seedProject('delegated-reject')
    const questionA = await seedQuestion(projectA)
    const requestA = await openRequest(questionA)
    const basis = await recordDecision(decision(projectA))
    const delegated = await resolveDelegated(requestA, basis)
    expect(delegated.disposition).toBe('delegated')
    const delegatedPromotion = await promoteHumanAnswerToProjectRule({
      request_id: requestA.id,
      revision: requestA.revision,
      decision_key: 'report.delegated',
      actor: 'owner',
      now: NOW,
    })
    expect(delegatedPromotion.ok).toBe(false)
    if (!delegatedPromotion.ok) {
      expect(delegatedPromotion.error.kind).toBe('PERMISSION_DENIED')
    }

    const projectB = await seedProject('forged-actor')
    const questionB = await seedQuestion(projectB)
    const human = await makeHumanResolution(questionB)
    await asOwner((c) =>
      c.query(
        `UPDATE managed_decision_resolution
         SET actor=jsonb_build_object('type','tianwen','authenticated_id',actor->>'authenticated_id')
         WHERE request_id=$1 AND request_revision=$2`,
        [human.request.id, human.request.revision],
      ),
    )
    const forgedPromotion = await promoteHumanAnswerToProjectRule({
      request_id: human.request.id,
      revision: human.request.revision,
      decision_key: 'report.forged',
      actor: 'owner',
      now: NOW,
    })
    expect(forgedPromotion.ok).toBe(false)
    if (!forgedPromotion.ok) {
      expect(forgedPromotion.error.kind).toBe('PERMISSION_DENIED')
    }
    const promotedRows = await asRole('keel_control', (c) =>
      c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM managed_project_decision
         WHERE project_id=$1 AND source_ref LIKE 'managed-decision-resolution:%'`,
        [projectB],
      ),
    )
    expect(promotedRows.rows[0]?.count).toBe('0')
  })

  it('摘要与检索保留 imported_candidate 来源，不提升为 owner_confirmed', async () => {
    const projectId = await seedProject('source-type')
    const imported = await recordDecision(
      decision(projectId, {
        source_type: 'imported_candidate',
        source_ref: 'import:legacy-notes',
        created_by: 'importer',
        statement: '报告使用导入候选中的中文。',
      }),
    )
    const summary = await createSummary(projectId)
    expect(summary.content.entries[0]?.source_type).toBe('imported_candidate')
    await publishSummary(projectId, summary.id, summary.memory_epoch, 'publisher')

    const state = mustValue(await getProjectMemoryState(projectId))
    expect(state.active_summary?.content.entries[0]?.source_type).toBe('imported_candidate')
    const retrieved = await retrieve({
      project_id: projectId,
      query: '报告',
      decision_key: 'report.language',
    })
    expect(retrieved.referenced_decision_ids).toEqual([imported.id])
    expect(retrieved.entries[0]?.source_type).toBe('imported_candidate')
  })

  it('预算升级、非关键省略与检索日志字段均由真实查询写入', async () => {
    const projectId = await seedProject('budget-log')
    const critical = await recordDecision(
      decision(projectId, {
        decision_key: 'deploy.approval',
        statement: `部署审批必须保留：${'细致'.repeat(500)}`,
      }),
    )
    await recordDecision(
      decision(projectId, {
        decision_key: 'docs.layout',
        statement: '文档采用单栏布局。',
      }),
    )
    await recordDecision(
      decision(projectId, {
        decision_key: 'test.naming',
        statement: '测试命名保持一致。',
      }),
    )
    const summary = await createSummary(projectId)
    await publishSummary(projectId, summary.id, summary.memory_epoch, 'publisher')

    const escalatedQuery = '部署审批'
    const escalated = await retrieve({
      project_id: projectId,
      query: escalatedQuery,
      decision_key: 'deploy.approval',
      budget_entries: 8,
      budget_tokens: 1,
    })
    expect(escalated.escalation_reason).not.toBeNull()
    expect(escalated.used_entries).toBe(0)
    expect(escalated.entries).toEqual([])
    expect(escalated.referenced_decision_ids).toEqual([])
    expect(escalated.candidate_count).toBe(3)

    const omittedQuery = 'zzzz totally unrelated'
    const omitted = await retrieve({
      project_id: projectId,
      query: omittedQuery,
      budget_entries: 1,
      budget_tokens: 32_000,
    })
    expect(omitted.escalation_reason).toBeNull()
    expect(omitted.omitted_count).toBeGreaterThan(0)
    expect(omitted.expansion_reason).toContain('预算仅纳入')
    expect(omitted.used_entries).toBe(1)
    expect(omitted.candidate_count).toBe(3)
    expect(omitted.referenced_decision_ids).toHaveLength(1)

    const logs = await asRole('keel_control', (c) =>
      c.query<RetrievalLogRow>(
        `SELECT summary_id,summary_version,summary_stale,memory_epoch,candidate_count,
           expanded,expansion_reason,escalation_reason,omitted_count,
           referenced_decision_ids,budget_entries,used_entries,budget_tokens,used_tokens,
           observed_at
         FROM managed_project_memory_retrieval
         WHERE project_id=$1 AND query=ANY($2::text[])`,
        [projectId, [escalatedQuery, omittedQuery]],
      ),
    )
    expect(logs.rowCount).toBe(2)
    const escalationLog = logs.rows.find((row) => row.escalation_reason !== null)
    const omissionLog = logs.rows.find(
      (row) => row.expansion_reason?.includes('预算仅纳入') === true,
    )
    expect(escalationLog).toBeDefined()
    expect(omissionLog).toBeDefined()
    if (escalationLog === undefined || omissionLog === undefined) return

    expect(escalationLog).toMatchObject({
      summary_id: summary.id,
      summary_version: 1,
      summary_stale: false,
      candidate_count: 3,
      expanded: false,
      omitted_count: 3,
      referenced_decision_ids: [],
      budget_entries: 8,
      used_entries: 0,
      budget_tokens: 1,
      used_tokens: 0,
    })
    expect(Number(escalationLog.memory_epoch)).toBe(summary.memory_epoch)
    expect(escalationLog.escalation_reason).toContain('关键记忆超出预算')
    expect(escalationLog.observed_at).toBeInstanceOf(Date)
    expect(Number.isNaN(escalationLog.observed_at.getTime())).toBe(false)

    expect(omissionLog).toMatchObject({
      summary_id: summary.id,
      summary_version: 1,
      summary_stale: false,
      candidate_count: 3,
      expanded: false,
      escalation_reason: null,
      omitted_count: 2,
      referenced_decision_ids: [critical.id],
      budget_entries: 1,
      used_entries: 1,
      budget_tokens: 32_000,
    })
    expect(Number(omissionLog.memory_epoch)).toBe(summary.memory_epoch)
    expect(omissionLog.expansion_reason).toContain('预算仅纳入 1/3 条候选')
    expect(omissionLog.observed_at).toBeInstanceOf(Date)
    expect(Number.isNaN(omissionLog.observed_at.getTime())).toBe(false)
  })

  it('权威决定超过摘要上限时显式升级，不返回旧摘要的部分结果', async () => {
    const projectId = await seedProject('live-rebuild-overflow')
    for (let index = 0; index < 512; index++) {
      await recordDecision(
        decision(projectId, {
          decision_key: `bulk.${index}`,
          statement: `批量规则 ${index}`,
          source_ref: `bulk:${index}`,
        }),
      )
    }
    const summary = await createSummary(projectId)
    await publishSummary(projectId, summary.id, summary.memory_epoch, 'publisher')
    await recordDecision(
      decision(projectId, {
        decision_key: 'new.rule',
        statement: '新增规则需要人工确认',
        source_ref: 'new-rule',
      }),
    )

    const retrieved = await retrieve({
      project_id: projectId,
      query: 'new.rule',
      decision_key: 'new.rule',
      budget_entries: 64,
      budget_tokens: 32_000,
    })
    expect(retrieved.summary_stale).toBe(true)
    expect(retrieved.escalation_reason).toContain('authoritative_decisions_could_not_be_loaded')
    expect(retrieved.entries).toEqual([])
    expect(retrieved.referenced_decision_ids).toEqual([])
  })

  it('权限反例：execution 无读权限，control 不能直改摘要/state，只能经 SECURITY DEFINER', async () => {
    const projectId = await seedProject('permissions')
    await recordDecision(decision(projectId))
    const summary = await createSummary(projectId)
    await publishSummary(projectId, summary.id, summary.memory_epoch, 'publisher')

    for (const table of [
      'managed_project_memory_state',
      'managed_project_memory_summary',
      'managed_project_memory_event',
      'managed_project_memory_retrieval',
    ]) {
      await expect(
        asRole('keel_execution', (c) => c.query(`SELECT 1 AS one FROM ${table} LIMIT 1`)),
      ).rejects.toThrow(/permission denied/i)
    }

    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_project_memory_summary SET content='{}'::jsonb WHERE id=$1`, [
          summary.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_project_memory_summary SET status='REJECTED' WHERE id=$1`, [
          summary.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_project_memory_state SET epoch=epoch+1 WHERE project_id=$1`, [
          projectId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/i)

    const definitions = await asOwner((c) =>
      c.query<{ proname: string; prosecdef: boolean }>(
        `SELECT proname,prosecdef FROM pg_proc
         WHERE proname=ANY($1::text[])`,
        [
          [
            'managed_publish_memory_summary',
            'managed_rollback_memory_summary',
            'managed_reject_memory_summary',
          ],
        ],
      ),
    )
    expect(definitions.rows.map((row) => row.proname).sort()).toEqual([
      'managed_publish_memory_summary',
      'managed_reject_memory_summary',
      'managed_rollback_memory_summary',
    ])
    expect(definitions.rows.every((row) => row.prosecdef)).toBe(true)

    const summaryV2 = await createSummary(projectId)
    await publishSummary(projectId, summaryV2.id, summaryV2.memory_epoch, 'publisher-v2')
    expect(mustValue(await getProjectMemoryState(projectId)).active_summary_id).toBe(summaryV2.id)
  })

  it('schema 约束拒绝同项目重复版本、跨项目 previous_summary_id 与 event.summary_id', async () => {
    const projectA = await seedProject('constraints-a')
    const projectB = await seedProject('constraints-b')
    const sourceA = await recordDecision(decision(projectA))
    const sourceB = await recordDecision(decision(projectB))
    await createSummary(projectA)
    const summaryB = await createSummary(projectB)
    const contentA = await memoryContent(projectA, [sourceA])
    const contentB = await memoryContent(projectB, [sourceB])
    expect(summaryB.project_id).toBe(projectB)

    await expect(insertRawSummary(projectA, contentA, 1)).rejects.toMatchObject({ code: '23505' })
    await expect(insertRawSummary(projectA, contentA, 2, summaryB.id)).rejects.toMatchObject({
      code: '23503',
    })
    await expect(
      asOwner((c) =>
        c.query(
          `INSERT INTO managed_project_memory_event(
            project_id,kind,summary_id,actor,occurred_at,details
          ) VALUES($1,'summary_rejected',$2,'forged',now(),'{}'::jsonb)`,
          [projectA, summaryB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' })

    expect(contentB.entries[0]?.project_id).toBe(projectB)
  })

  it('摘要事件记录 summary_id、actor 与 details，覆盖创建/发布/回滚/epoch', async () => {
    const projectId = await seedProject('events')
    const source = await recordDecision(decision(projectId))
    const summaryV1 = await createSummary(projectId, 'event-generator')
    await publishSummary(projectId, summaryV1.id, summaryV1.memory_epoch, 'publish-actor')
    const summaryV2 = await createSummary(projectId, 'event-generator')
    await publishSummary(projectId, summaryV2.id, summaryV2.memory_epoch, 'publish-actor-v2')
    mustValue(
      await rollbackProjectMemorySummary({
        project_id: projectId,
        summary_id: summaryV1.id,
        expected_epoch: summaryV2.memory_epoch,
        actor: 'rollback-actor',
        reason: '回退到 v1',
        now: NOW,
      }),
    )

    const events = await eventRows(projectId)
    const epochEvent = events.find(
      (event) => event.kind === 'epoch_bumped' && event.details.decision_id === source.id,
    )
    expect(epochEvent).toMatchObject({
      summary_id: null,
      actor: 'owner',
      details: { decision_key: 'report.language', version: 1 },
    })

    expect(
      events.find((event) => event.kind === 'summary_created' && event.summary_id === summaryV1.id),
    ).toMatchObject({
      actor: 'event-generator',
      details: {
        version: 1,
        memory_epoch: summaryV1.memory_epoch,
        covered_decision_count: 1,
      },
    })
    expect(
      events.find(
        (event) => event.kind === 'summary_published' && event.summary_id === summaryV1.id,
      ),
    ).toMatchObject({
      actor: 'publish-actor',
      details: { version: 1, previous_summary_id: null },
    })
    expect(
      events.find((event) => event.kind === 'rollback' && event.summary_id === summaryV1.id),
    ).toMatchObject({
      actor: 'rollback-actor',
      reason: '回退到 v1',
      details: { version: 1, previous_summary_id: summaryV2.id },
    })
  })
})
