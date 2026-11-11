import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ManagedInference } from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type { JstackInvestigationPackage } from '../../generated/managed.js'
import { recordProjectDecision } from './decision-store.js'
import { packageDigest } from './protocol.js'
import { listManagedQuestions, tickManaged } from './runtime.js'
import { answerManagedQuestion, getManagedTask } from './store.js'

const PAST = '2026-11-01T00:00:00.000Z'

const workflow: JstackInvestigationPackage = {
  protocol_version: '1.0',
  workflow_id: 'jstack',
  mode: 'investigation',
  source_commit: 'fixture',
  stages: ['execute'],
  instructions: {
    route: 'Question -> execute only',
    stages: 'execute',
    execute: '调查并引用实际观察',
  },
}

const decisionMeta = {
  decision_key: 'report.language',
  kind: 'preference' as const,
  action_category: 'write_file',
  impact: {
    environment: 'local' as const,
    reversibility: 'reversible' as const,
    affected_resources: ['README.md'],
  },
}

function fixed(value: unknown): ManagedInference {
  return async () => ({ ok: true as const, value: { value, usage: ZERO_USAGE } })
}

function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recommendation: 'answer',
    answer_option_id: 'option-1',
    rationale: '依据当前请求',
    basis_refs: [],
    assumptions: [],
    alternatives: [],
    unresolved_conflicts: [],
    missing_authority: [],
    ...over,
  }
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})
afterAll(closePool)

async function seed(): Promise<{ repoId: string; taskId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const digest = packageDigest(workflow)
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch) VALUES($1,'local',$2,'main')`,
      [repoId, `file:///tmp/${repoId}`],
    )
    await c.query(
      'INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [digest, JSON.stringify(workflow)],
    )
    await c.query(
      `INSERT INTO managed_task(
        id,repo_id,package_digest,workspace_path,question,file_index,status,phase
      ) VALUES($1,$2,$3,'/tmp',$4,'["README.md"]'::jsonb,'READY','investigate')`,
      [taskId, repoId, digest, '报告使用哪种语言？'],
    )
  })
  return { repoId, taskId }
}

describe('managed decision runtime', () => {
  it('无依据时升级人工，人工答复创建新 revision 并唤醒任务', async () => {
    const { taskId } = await seed()
    await tickManaged(
      fixed({
        outcome: 'waiting_decision',
        question: '报告用哪种语言？',
        options: ['中文', '英文'],
        ...decisionMeta,
      }),
      taskId,
    )
    const current = await asRole('keel_control', (c) =>
      c.query<{ id: string; revision: number; status: string }>(
        'SELECT id,revision,status FROM managed_decision_request WHERE managed_task_id=$1',
        [taskId],
      ),
    )
    expect(current.rows).toHaveLength(1)
    expect(current.rows[0]?.status).toBe('OPEN')

    await tickManaged(fixed(proposal()), taskId)
    expect((await getManagedTask(taskId))?.status).toBe('WAITING_HUMAN')
    const question = (await listManagedQuestions(taskId))[0]
    if (question === undefined) throw new Error('missing question')
    expect(question.status).toBe('WAITING_HUMAN')

    expect((await answerManagedQuestion(question.id, '中文')).ok).toBe(true)
    expect((await getManagedTask(taskId))?.status).toBe('READY')
    const revisions = await asRole('keel_control', (c) =>
      c.query<{ revision: number; status: string; disposition: string }>(
        `SELECT r.revision,r.status,d.disposition
         FROM managed_decision_request r
         JOIN managed_decision_resolution d
           ON d.request_id=r.id AND d.request_revision=r.revision
         WHERE r.managed_question_id=$1 ORDER BY r.revision`,
        [question.id],
      ),
    )
    expect(revisions.rows.map((row) => row.disposition)).toEqual([
      'owner_required',
      'human_confirmed',
    ])
    expect(revisions.rows.map((row) => row.status)).toEqual(['SUPERSEDED', 'RESOLVED'])
  })

  it('E3 明确决定自动唤醒，人工纠正保留 delegated 与 human_confirmed 两版决议', async () => {
    const { repoId, taskId } = await seed()
    const decisionId = randomUUID()
    const recorded = await recordProjectDecision({
      schema_version: '1.0',
      id: decisionId,
      project_id: repoId,
      decision_key: 'report.language',
      version: 1,
      statement: '项目报告固定使用中文。',
      selected_option_id: 'option-1',
      options: [
        { id: 'option-1', text: '中文' },
        { id: 'option-2', text: '英文' },
      ],
      scope: {
        decision_kinds: ['preference'],
        actions: ['write_file'],
        resource_selectors: ['README.md'],
        environments: ['local'],
        reversibilities: ['reversible'],
      },
      source_type: 'owner_confirmed',
      source_ref: 'owner-message:test',
      created_by: 'owner',
      valid_from: PAST,
      created_at: PAST,
    })
    if (!recorded.ok) throw new Error(recorded.error.detail)
    await tickManaged(
      fixed({
        outcome: 'waiting_decision',
        question: '报告用哪种语言？',
        options: ['中文', '英文'],
        ...decisionMeta,
      }),
      taskId,
    )
    await tickManaged(
      fixed(
        proposal({
          basis_refs: [{ kind: 'project_decision', id: decisionId, version: 1 }],
        }),
      ),
      taskId,
    )
    const question = (await listManagedQuestions(taskId))[0]
    if (question === undefined) throw new Error('missing question')
    expect(question.status).toBe('RESOLVED')
    expect(question.answer).toBe('中文')
    expect((await getManagedTask(taskId))?.status).toBe('READY')

    expect((await answerManagedQuestion(question.id, '英文')).ok).toBe(true)
    expect((await listManagedQuestions(taskId))[0]?.answer).toBe('英文')
    const state = await getManagedTask(taskId)
    expect(state?.answers).toHaveLength(1)
    expect(state?.answers[0]?.actor).toBe('human')
    const revisions = await asRole('keel_control', (c) =>
      c.query<{ status: string; disposition: string }>(
        `SELECT r.status,d.disposition
         FROM managed_decision_request r
         JOIN managed_decision_resolution d
           ON d.request_id=r.id AND d.request_revision=r.revision
         WHERE r.managed_question_id=$1 ORDER BY r.revision`,
        [question.id],
      ),
    )
    expect(revisions.rows).toEqual([
      { status: 'SUPERSEDED', disposition: 'delegated' },
      { status: 'RESOLVED', disposition: 'human_confirmed' },
    ])
  })
})
