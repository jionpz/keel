import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type {
  DecisionRequest,
  DelegationPolicyVersion,
  ProjectDecision,
  TianwenProposal,
} from '../../generated/managed.js'
import { decisionRequestDigest } from './decision-protocol.js'
import {
  openDecisionRequestFromManagedQuestion,
  readDecisionResolution,
  recordDelegationPolicy,
  recordProjectDecision,
  resolveTianwenProposal,
  revokeProjectDecision,
  submitTianwenProposal,
} from './decision-store.js'

const NOW = '2026-11-11T00:00:00.000Z'
const PAST = '2026-11-01T00:00:00.000Z'
const EXPIRED = '2026-11-05T00:00:00.000Z'

interface SeededQuestion {
  readonly repoId: string
  readonly taskId: string
  readonly questionId: string
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

async function seedQuestion(
  question: string,
  options: readonly string[],
  existingRepoId?: string,
): Promise<SeededQuestion> {
  const repoId = existingRepoId ?? randomUUID()
  const taskId = randomUUID()
  const questionId = randomUUID()
  await asOwner(async (c) => {
    if (existingRepoId === undefined) {
      await c.query(
        `INSERT INTO repo(id,provider,remote_url,default_branch) VALUES($1,'local',$2,'main')`,
        [repoId, `file:///tmp/${repoId}`],
      )
    }
    await c.query(
      `INSERT INTO managed_package(digest,body) VALUES($1,'{}'::jsonb) ON CONFLICT DO NOTHING`,
      ['a'.repeat(64)],
    )
    await c.query(
      `INSERT INTO managed_task(
        id,repo_id,package_digest,workspace_path,question,file_index,status,phase
      ) VALUES($1,$2,$3,'/tmp', $4, '["README.md"]'::jsonb,'WAITING_TIANWEN','tianwen')`,
      [taskId, repoId, 'a'.repeat(64), question],
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
  return { repoId, taskId, questionId }
}

function requestInput() {
  return {
    decision_key: 'report.language',
    kind: 'preference' as const,
    action_category: 'write_file',
    impact: {
      environment: 'local' as const,
      reversibility: 'reversible' as const,
      affected_resources: ['docs/report.md'],
    },
  }
}

function decision(projectId: string, over: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    schema_version: '1.0',
    id: randomUUID(),
    project_id: projectId,
    decision_key: 'report.language',
    version: 1,
    statement: '报告使用中文。',
    selected_option_id: 'option-1',
    options: [
      { id: 'option-1', text: '中文' },
      { id: 'option-2', text: '英文' },
    ],
    scope: {
      decision_kinds: ['preference'],
      actions: ['write_file'],
      resource_selectors: ['docs/*'],
      environments: ['local'],
      reversibilities: ['reversible'],
    },
    source_type: 'owner_confirmed',
    source_ref: 'owner-message:1',
    created_by: 'owner',
    valid_from: PAST,
    created_at: PAST,
    ...over,
  }
}

function policy(projectId: string): DelegationPolicyVersion {
  return {
    schema_version: '1.0',
    id: randomUUID(),
    policy_id: 'reversible.defaults',
    version: 1,
    project_id: projectId,
    approved_by_owner: 'owner',
    approved_at: PAST,
    valid_from: PAST,
    rules: [
      {
        id: 'report-language',
        decision_kinds: ['preference'],
        actions: ['write_file'],
        resource_selectors: ['docs/*'],
        environments: ['local'],
        reversibility: 'reversible',
        impact_limits: {
          environments: ['local'],
          reversibilities: ['reversible'],
          max_affected_resources: 8,
        },
        budget_limits: {},
        required_evidence: [],
        required_checks: [],
        mode: 'delegated',
        default_option_id: 'option-1',
      },
    ],
    created_at: PAST,
  }
}

function proposal(
  request: DecisionRequest,
  basisRefs: TianwenProposal['basis_refs'],
  over: Partial<TianwenProposal> = {},
): TianwenProposal {
  return {
    schema_version: '1.0',
    request_id: request.id,
    request_revision: request.revision,
    input_digest: request.input_digest,
    recommendation: 'answer',
    answer_option_id: 'option-1',
    rationale: '采用项目已有明确决定',
    claimed_evidence_grade: 'E3',
    basis_refs: basisRefs,
    observed_fact_refs: [],
    assumptions: [],
    alternatives: [],
    unresolved_conflicts: [],
    missing_authority: [],
    ...over,
  }
}

async function openRequest(seed: SeededQuestion): Promise<DecisionRequest> {
  const opened = await openDecisionRequestFromManagedQuestion(seed.questionId, requestInput(), NOW)
  if (!opened.ok) throw new Error(opened.error.detail)
  return opened.value
}

async function submitAndResolve(
  request: DecisionRequest,
  proposalValue: TianwenProposal,
): Promise<ReturnType<typeof resolveTianwenProposal>> {
  const submitted = await submitTianwenProposal(request.id, request.revision, proposalValue, NOW)
  if (!submitted.ok) return submitted
  return resolveTianwenProposal(request.id, request.revision, submitted.value, randomUUID(), NOW)
}

describe('决策台账 store', () => {
  it('从既有 managed question 建请求并幂等复用', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const first = await openDecisionRequestFromManagedQuestion(seed.questionId, requestInput(), NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.project_id).toBe(seed.repoId)
    expect(first.value.repo_id).toBe(seed.repoId)
    expect(first.value.managed_task_id).toBe(seed.taskId)
    expect(first.value.managed_question_id).toBe(seed.questionId)
    expect(first.value.question).toBe('报告使用哪种语言？')
    expect(first.value.options).toEqual([
      { id: 'option-1', text: '中文' },
      { id: 'option-2', text: '英文' },
    ])
    expect(first.value.input_digest).toBe(decisionRequestDigest(first.value))
    const second = await openDecisionRequestFromManagedQuestion(
      seed.questionId,
      requestInput(),
      NOW,
    )
    expect(second.ok && second.value.id).toBe(first.value.id)
    const count = await asRole('keel_control', async (c) =>
      c.query('SELECT id FROM managed_decision_request WHERE managed_question_id=$1', [
        seed.questionId,
      ]),
    )
    expect(count.rowCount).toBe(1)
  })

  it('E3 明确决定落成 delegated 决议并写入唯一终态', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const req = await openRequest(seed)
    const explicit = decision(seed.repoId)
    expect((await recordProjectDecision(explicit)).ok).toBe(true)
    const resolved = await submitAndResolve(
      req,
      proposal(req, [{ kind: 'project_decision', id: explicit.id, version: 1 }]),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.disposition).toBe('delegated')
    expect(resolved.value.evidence_grade).toBe('E3')
    expect(resolved.value.answer).toBe('中文')
    const persisted = await readDecisionResolution(req.id, req.revision)
    expect(persisted?.disposition).toBe(resolved.value.disposition)
    expect(persisted?.answer).toBe(resolved.value.answer)
    expect(persisted?.evidence_grade).toBe(resolved.value.evidence_grade)
    expect(new Date(persisted?.resolved_at ?? '').toISOString()).toBe(NOW)
    const requestRow = await asRole('keel_control', async (c) =>
      c.query<{ status: string }>(
        'SELECT status FROM managed_decision_request WHERE id=$1 AND revision=$2',
        [req.id, req.revision],
      ),
    )
    expect(requestRow.rows[0]?.status).toBe('RESOLVED')
    const proposalRow = await asRole('keel_control', async (c) =>
      c.query<{ actor_type: string; source: string }>(
        `SELECT actor_type, source FROM managed_tianwen_proposal
         WHERE request_id=$1 AND request_revision=$2`,
        [req.id, req.revision],
      ),
    )
    expect(proposalRow.rows[0]).toEqual({
      actor_type: 'tianwen',
      source: 'model_proposal',
    })
  })

  it('E1 可逆默认只依据当前项目委托策略', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const req = await openRequest(seed)
    const configured = policy(seed.repoId)
    expect((await recordDelegationPolicy(configured)).ok).toBe(true)
    const resolved = await submitAndResolve(
      req,
      proposal(req, [{ kind: 'delegation_policy', id: configured.id, version: 1 }]),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.disposition).toBe('delegated')
    expect(resolved.value.evidence_grade).toBe('E1')
    expect(resolved.value.delegation_policy_id).toBe(configured.id)
  })

  it('跨项目决定不会进入当前项目候选，自动代答失败为 owner_required', async () => {
    const a = await seedQuestion('项目 A 报告语言？', ['中文', '英文'])
    const b = await seedQuestion('项目 B 报告语言？', ['中文', '英文'])
    const req = await openRequest(a)
    const foreign = decision(b.repoId)
    expect((await recordProjectDecision(foreign)).ok).toBe(true)
    const resolved = await submitAndResolve(
      req,
      proposal(req, [{ kind: 'project_decision', id: foreign.id, version: 1 }]),
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.value.disposition).toBe('owner_required')
  })

  it('项目决定过期或被撤销后不再代答', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const req = await openRequest(seed)
    const expired = decision(seed.repoId, { valid_until: EXPIRED })
    expect((await recordProjectDecision(expired)).ok).toBe(true)
    const expiredResult = await submitAndResolve(
      req,
      proposal(req, [{ kind: 'project_decision', id: expired.id, version: 1 }]),
    )
    expect(expiredResult.ok && expiredResult.value.disposition).toBe('owner_required')

    const live = decision(seed.repoId, { version: 2, statement: '报告继续使用中文。' })
    expect((await recordProjectDecision(live)).ok).toBe(true)
    expect((await revokeProjectDecision(live.id, 'owner', '偏好变化', NOW)).ok).toBe(true)
    const revokedRow = await asRole('keel_control', async (c) =>
      c.query<{ revoked_at: Date | null; revocation_reason: string | null }>(
        'SELECT revoked_at, revocation_reason FROM managed_project_decision WHERE id=$1',
        [live.id],
      ),
    )
    expect(revokedRow.rows[0]?.revoked_at).not.toBeNull()
    expect(revokedRow.rows[0]?.revocation_reason).toBe('偏好变化')

    const secondSeed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const revokedRequest = await openRequest(secondSeed)
    const revokedResult = await submitAndResolve(
      revokedRequest,
      proposal(revokedRequest, [{ kind: 'project_decision', id: live.id, version: 2 }]),
    )
    expect(revokedResult.ok && revokedResult.value.disposition).toBe('owner_required')
  })

  it('新版本可原子替代旧项目决定', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const first = decision(seed.repoId)
    expect((await recordProjectDecision(first)).ok).toBe(true)
    const second = decision(seed.repoId, {
      version: 2,
      statement: '报告改用中文短版。',
      supersedes_id: first.id,
    })
    expect((await recordProjectDecision(second)).ok).toBe(true)
    const rows = await asRole('keel_control', async (c) =>
      c.query<{ id: string; superseded_by: string | null }>(
        'SELECT id, superseded_by FROM managed_project_decision WHERE project_id=$1 ORDER BY version',
        [seed.repoId],
      ),
    )
    expect(rows.rows).toEqual([
      { id: first.id, superseded_by: second.id },
      { id: second.id, superseded_by: null },
    ])
  })

  it('提案 revision 或 digest 失配时只记录拒绝，不写提案', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const req = await openRequest(seed)
    const explicit = decision(seed.repoId)
    expect((await recordProjectDecision(explicit)).ok).toBe(true)
    const wrongRevision = await submitTianwenProposal(
      req.id,
      req.revision,
      proposal(req, [{ kind: 'project_decision', id: explicit.id, version: 1 }], {
        request_revision: req.revision + 1,
      }),
      NOW,
    )
    expect(wrongRevision.ok).toBe(false)
    if (!wrongRevision.ok) expect(wrongRevision.error.kind).toBe('CONFLICT')
    const wrongDigest = await submitTianwenProposal(
      req.id,
      req.revision,
      proposal(req, [{ kind: 'project_decision', id: explicit.id, version: 1 }], {
        input_digest: '0'.repeat(64),
      }),
      NOW,
    )
    expect(wrongDigest.ok).toBe(false)
    if (!wrongDigest.ok) expect(wrongDigest.error.kind).toBe('CONFLICT')
    const count = await asRole('keel_control', async (c) =>
      c.query('SELECT id FROM managed_tianwen_proposal WHERE request_id=$1', [req.id]),
    )
    expect(count.rowCount).toBe(0)
  })

  it('同一 request revision 并发接纳只有一个赢家', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const req = await openRequest(seed)
    const explicit = decision(seed.repoId)
    expect((await recordProjectDecision(explicit)).ok).toBe(true)
    const submitted = await submitTianwenProposal(
      req.id,
      req.revision,
      proposal(req, [{ kind: 'project_decision', id: explicit.id, version: 1 }]),
      NOW,
    )
    if (!submitted.ok) throw new Error(submitted.error.detail)
    const results = await Promise.all([
      resolveTianwenProposal(req.id, req.revision, submitted.value, randomUUID(), NOW),
      resolveTianwenProposal(req.id, req.revision, submitted.value, randomUUID(), NOW),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const loser = results.find((result) => !result.ok)
    expect(loser?.ok).toBe(false)
    if (loser !== undefined && !loser.ok) expect(loser.error.kind).toBe('CONFLICT')
    const rows = await asRole('keel_control', async (c) =>
      c.query('SELECT id FROM managed_decision_resolution WHERE request_id=$1', [req.id]),
    )
    expect(rows.rowCount).toBe(1)
  })

  it('Execution 对新台账无任何读写；Control 不能改台账核心列', async () => {
    const seed = await seedQuestion('报告使用哪种语言？', ['中文', '英文'])
    const explicit = decision(seed.repoId)
    expect((await recordProjectDecision(explicit)).ok).toBe(true)
    for (const table of [
      'managed_project_decision',
      'managed_delegation_policy',
      'managed_decision_request',
      'managed_tianwen_proposal',
      'managed_decision_resolution',
    ]) {
      await expect(
        asRole('keel_execution', (c) => c.query(`SELECT * FROM ${table}`)),
      ).rejects.toThrow(/permission denied/i)
    }
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_project_decision SET statement='伪造' WHERE id=$1`, [explicit.id]),
      ),
    ).rejects.toThrow(/permission denied/i)
    for (const column of ['revoked_at', 'revoked_by', 'revocation_reason', 'superseded_by']) {
      await expect(
        asRole('keel_control', (c) =>
          c.query(`UPDATE managed_project_decision SET ${column}=NULL WHERE id=$1`, [explicit.id]),
        ),
      ).rejects.toThrow(/permission denied/i)
    }
    await expect(
      asRole('keel_control', (c) =>
        c.query(
          `INSERT INTO managed_decision_change(
            entity_type,entity_id,entity_version,change_type,actor,changed_at,previous_state,new_state
          ) VALUES('project_decision',$1,1,'revoked','forged',now(),'{}','{}')`,
          [explicit.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/i)
    const seed2 = await seedQuestion('是否需要人工决定？', ['是', '否'])
    const request = await openDecisionRequestFromManagedQuestion(
      seed2.questionId,
      {
        decision_key: 'manual.choice',
        kind: 'clarification',
        action_category: 'read_file',
        impact: {
          environment: 'local',
          reversibility: 'reversible',
          affected_resources: ['README.md'],
        },
      },
      NOW,
    )
    if (!request.ok) throw new Error(request.error.detail)
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_decision_request SET status='RESOLVED' WHERE id=$1`, [
          request.value.id,
        ]),
      ),
    ).rejects.toThrow(/cannot resolve without a resolution/i)
    const visible = await asRole('keel_control', (c) =>
      c.query('SELECT id FROM managed_project_decision WHERE id=$1', [explicit.id]),
    )
    expect(visible.rowCount).toBe(1)
  })
})
