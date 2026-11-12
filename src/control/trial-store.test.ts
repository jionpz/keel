import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { readTrialStatus, startTrial, stopTrial } from './trial-store.js'

const START = '2026-11-01T00:00:00.000Z'
const SEVEN_DAYS = '2026-11-08T00:00:00.000Z'
const HASH = 'a'.repeat(64)
const PACKAGE = 'b'.repeat(64)

async function clean(): Promise<void> {
  await asOwner((c) =>
    c.query('TRUNCATE repo, managed_package, managed_trial RESTART IDENTITY CASCADE'),
  )
}

beforeEach(clean)
afterAll(closePool)

async function seedRepo(remote: string): Promise<string> {
  const id = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'local',$2,'main')`,
      [id, remote],
    )
    await c.query(
      'INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',
      [PACKAGE, '{}'],
    )
  })
  return id
}

async function seedProjects(): Promise<readonly [string, string]> {
  return [await seedRepo('file:///tmp/trial-a'), await seedRepo('file:///tmp/trial-b')]
}

async function seedDecision(repoId: string, resolvedAt: string): Promise<void> {
  const requestId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO managed_decision_request(
        id,revision,idempotency_key,project_id,repo_id,decision_key,kind,question,options,
        impact,action_category,input_digest,status
      ) VALUES($1,1,$2,$3,$3,'trial.choice','preference','选择？',
               '[{"id":"yes","text":"是"},{"id":"no","text":"否"}]'::jsonb,
               '{}'::jsonb,'read_only',$4,'OPEN')`,
      [requestId, `trial-decision-${requestId}`, repoId, HASH],
    )
    await c.query(
      `INSERT INTO managed_decision_resolution(
        id,request_id,request_revision,input_digest,disposition,answer_option_id,answer,
        rationale,evidence_grade,basis_refs,actor,authority_refs,validity_conditions,
        context_digest,resolved_at
      ) VALUES($1,$2,1,$3,'delegated','yes','是','按项目决定代答','E1','[]'::jsonb,
               '{"type":"tianwen"}'::jsonb,'[]'::jsonb,'[]'::jsonb,$3,$4)`,
      [randomUUID(), requestId, HASH, resolvedAt],
    )
    await c.query(`UPDATE managed_decision_request SET status='RESOLVED' WHERE id=$1`, [requestId])
  })
}

async function seedDoneTask(repoId: string, updatedAt: string, label: string): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO managed_ticket_task(
        id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,worktree_path,
        current_stage,status,updated_at
      ) VALUES($1,$2,$3,$4,$4,$5,'/tmp/trial-worktree','land','DONE',$6)`,
      [randomUUID(), repoId, PACKAGE, label, 'c'.repeat(40), updatedAt],
    ),
  )
}

async function seedTask(
  repoId: string,
  updatedAt: string,
  label: string,
  status: 'DONE' | 'PR_READY' | 'PR_OPENED',
): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO managed_ticket_task(
        id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,worktree_path,
        current_stage,status,completion_target,updated_at
      ) VALUES($1,$2,$3,$4,$4,$5,'/tmp/trial-worktree','land',$6,'pr_ready',$7)`,
      [randomUUID(), repoId, PACKAGE, label, 'c'.repeat(40), status, updatedAt],
    ),
  )
}

async function seedOpenQuestion(repoId: string): Promise<void> {
  const requestId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO managed_decision_request(
        id,revision,idempotency_key,project_id,repo_id,decision_key,kind,question,options,
        impact,action_category,input_digest,status
      ) VALUES($1,1,$2,$3,$3,'trial.open','clarification','仍未回答？',
               '[{"id":"yes","text":"是"},{"id":"no","text":"否"}]'::jsonb,
               '{}'::jsonb,'read_only',$4,'WAITING_HUMAN')`,
      [requestId, `trial-open-${requestId}`, repoId, HASH],
    ),
  )
}

async function seedAction(
  repoId: string,
  status: 'UNCERTAIN' | 'FAILED',
  updatedAt: string,
  label: string,
): Promise<void> {
  const ticketId = randomUUID()
  const intentId = randomUUID()
  const outboxId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO managed_ticket_task(
        id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,worktree_path,
        current_stage,status
      ) VALUES($1,$2,$3,$4,$4,$5,'/tmp/trial-worktree','land','READY')`,
      [ticketId, repoId, PACKAGE, label, 'd'.repeat(40)],
    )
    await c.query(
      `INSERT INTO managed_action_intent(
        id,task_id,project_id,repo_id,action,remote_url,base_branch,head_branch,head_sha,
        diff_digest,environment,reversibility,affected_resources,pr_title,pr_body,idempotency_key
      ) VALUES($1,$2,$3,$3,'push_and_pr','file:///tmp/trial.git','main',$4,$5,$6,
               'local','reversible','["README.md"]'::jsonb,'trial','trial',$7)`,
      [intentId, ticketId, repoId, `ai/trial-${label}`, 'e'.repeat(40), HASH, `intent-${intentId}`],
    )
    await c.query(
      `INSERT INTO managed_action_outbox(id,action_intent_id,status,updated_at)
       VALUES($1,$2,'PENDING',$3)`,
      [outboxId, intentId, updatedAt],
    )
    for (const next of ['LEASED', 'EXECUTING', status] as const) {
      await c.query(`UPDATE managed_action_outbox SET status=$2,updated_at=$3 WHERE id=$1`, [
        outboxId,
        next,
        updatedAt,
      ])
    }
  })
}

describe('JT-07 试运行账本（真实 PostgreSQL）', () => {
  it('Execution 不能读写试运行账本，Control 不能删除试运行记录', async () => {
    const [a, b] = await seedProjects()
    await expect(
      asRole('keel_execution', (c) => c.query('SELECT * FROM managed_trial')),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      asRole('keel_execution', (c) =>
        c.query(`INSERT INTO managed_trial(id,started_at) VALUES($1,$2)`, [randomUUID(), START]),
      ),
    ).rejects.toThrow(/permission denied/i)

    const started = await startTrial({ projectIds: [a, b], now: START })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await expect(
      asRole('keel_control', (c) =>
        c.query('DELETE FROM managed_trial WHERE id=$1', [started.value]),
      ),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      asRole('keel_control', (c) =>
        c.query('DELETE FROM managed_trial_project WHERE trial_id=$1', [started.value]),
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('拒绝少于 2 个、重复、非法与不存在的项目，且不留下试运行记录', async () => {
    const [a, b] = await seedProjects()
    const one = await startTrial({ projectIds: [a], now: START })
    expect(one.ok).toBe(false)
    if (!one.ok) expect(one.error.kind).toBe('SCHEMA_VIOLATION')

    const duplicate = await startTrial({ projectIds: [a, a], now: START })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) expect(duplicate.error.kind).toBe('SCHEMA_VIOLATION')

    const malformed = await startTrial({ projectIds: [a, 'not-a-uuid'], now: START })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.kind).toBe('SCHEMA_VIOLATION')

    const missing = await startTrial({ projectIds: [a, randomUUID()], now: START })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.kind).toBe('NOT_FOUND')

    const status = await readTrialStatus(START)
    expect(status.ok).toBe(true)
    if (status.ok) {
      expect(status.value.state).toBe('NOT_STARTED')
      expect(status.value.eligible_for_owner_review).toBe(false)
    }
    expect(b).toBeTruthy()
  })

  it('只允许单活试运行，PR_READY 计入完成而 PR_OPENED 不计，停止后不能通过', async () => {
    const [a, b] = await seedProjects()
    const started = await startTrial({
      projectIds: [a, b],
      now: START,
      note: '两周真实样本',
    })
    expect(started.ok).toBe(true)

    const second = await startTrial({ projectIds: [a, b], now: START })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe('CONFLICT')

    for (let index = 0; index < 18; index += 1) await seedDecision(a, SEVEN_DAYS)
    for (let index = 0; index < 12; index += 1) await seedDecision(b, SEVEN_DAYS)
    for (let index = 0; index < 2; index += 1) await seedDoneTask(a, SEVEN_DAYS, `a-${index}`)
    await seedTask(a, SEVEN_DAYS, 'a-pr-ready', 'PR_READY')
    await seedTask(b, SEVEN_DAYS, 'b-pr-ready-1', 'PR_READY')
    await seedTask(b, SEVEN_DAYS, 'b-pr-ready-2', 'PR_READY')
    await seedTask(b, SEVEN_DAYS, 'b-pr-opened', 'PR_OPENED')

    const running = await readTrialStatus(SEVEN_DAYS)
    expect(running.ok).toBe(true)
    if (!running.ok) return
    expect(running.value.state).toBe('RUNNING')
    expect(running.value.metrics.delegated_decisions).toBe(30)
    expect(running.value.metrics.completed_tasks).toBe(5)
    expect(running.value.metrics.by_project.map((project) => project.delegated_decisions)).toEqual([
      18, 12,
    ])
    expect(running.value.eligible_for_owner_review).toBe(true)

    const emptyReason = await stopTrial(SEVEN_DAYS, '  ')
    expect(emptyReason.ok).toBe(false)
    if (!emptyReason.ok) expect(emptyReason.error.kind).toBe('SCHEMA_VIOLATION')

    const stopped = await stopTrial(SEVEN_DAYS, 'owner 暂停扩大范围')
    expect(stopped.ok).toBe(true)
    const after = await readTrialStatus('2026-11-09T00:00:00.000Z')
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.state).toBe('STOPPED')
    expect(after.value.eligible_for_owner_review).toBe(false)
    expect(after.value.trial?.stop_reason).toBe('owner 暂停扩大范围')
  })

  it('只统计试运行窗口内、所选项目的真实样本，并暴露风险信号', async () => {
    const [a, b] = await seedProjects()
    const outsider = await seedRepo('file:///tmp/trial-outsider')
    const started = await startTrial({ projectIds: [a, b], now: START })
    expect(started.ok).toBe(true)

    await seedDecision(a, '2026-10-31T23:59:59.000Z')
    await seedDecision(a, '2026-11-08T00:00:01.000Z')
    await seedDecision(outsider, SEVEN_DAYS)
    await seedDoneTask(outsider, SEVEN_DAYS, 'outsider')
    await seedDoneTask(a, '2026-10-31T23:59:59.000Z', 'before')

    await seedOpenQuestion(a)
    await seedAction(a, 'UNCERTAIN', SEVEN_DAYS, 'uncertain')
    await seedAction(b, 'FAILED', SEVEN_DAYS, 'failed')

    const status = await readTrialStatus(SEVEN_DAYS)
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.value.metrics.delegated_decisions).toBe(0)
    expect(status.value.metrics.completed_tasks).toBe(0)
    expect(status.value.metrics.open_questions).toBe(1)
    expect(status.value.metrics.uncertain_actions).toBe(1)
    expect(status.value.metrics.dead_letter_actions).toBe(1)
    expect(status.value.eligible_for_owner_review).toBe(false)
    expect(status.value.notes.join('\n')).toContain('uncertain')
    expect(status.value.notes.join('\n')).toContain('dead-letter')
  })
})
