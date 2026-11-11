/** JT-07 单 owner 试运行账本：只记录开始/停止，并从真实队列与决定台账核算门槛。 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { err, errorFrom, makeError, ok, type Result } from '../contracts/errors.js'
import { asRole } from '../fact/db.js'
import {
  evaluateTrial,
  TRIAL_MAX_PROJECTS,
  TRIAL_MIN_PROJECTS,
  type TrialEvaluation,
  type TrialMetrics,
  type TrialProjectMetrics,
} from './trial.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface TrialRow {
  readonly id: string
  readonly started_at: Date | string
  readonly ended_at: Date | string | null
  readonly stop_reason: string | null
  readonly note: string | null
}

interface ProjectRow {
  readonly id: string
  readonly remote_url: string
}

interface DecisionCountRow {
  readonly project_id: string
  readonly disposition: string
  readonly count: number
}

interface CompletedCountRow {
  readonly project_id: string
  readonly count: number
}

interface ScalarRow {
  readonly count: number
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function parseTime(raw: string, label: string): string {
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${label} 不是合法时间`)
  return new Date(parsed).toISOString()
}

function validateProjectIds(projectIds: readonly string[]): Result<readonly string[]> {
  if (projectIds.length < TRIAL_MIN_PROJECTS || projectIds.length > TRIAL_MAX_PROJECTS) {
    return err(
      makeError(
        'SCHEMA_VIOLATION',
        `试运行必须选择 ${TRIAL_MIN_PROJECTS}–${TRIAL_MAX_PROJECTS} 个不同项目`,
      ),
    )
  }
  const unique = [...new Set(projectIds)]
  if (unique.length !== projectIds.length)
    return err(makeError('SCHEMA_VIOLATION', '试运行项目不能重复'))
  for (const projectId of unique) {
    if (!UUID_RE.test(projectId))
      return err(makeError('SCHEMA_VIOLATION', `非法项目 ID：${projectId}`))
  }
  return ok(unique)
}

async function projectRows(c: PoolClient, projectIds: readonly string[]): Promise<ProjectRow[]> {
  const result = await c.query<ProjectRow>(
    `SELECT id,remote_url FROM repo WHERE id = ANY($1::uuid[]) ORDER BY remote_url,id`,
    [projectIds],
  )
  return result.rows
}

async function assertProjects(c: PoolClient, projectIds: readonly string[]): Promise<ProjectRow[]> {
  const rows = await projectRows(c, projectIds)
  if (rows.length !== projectIds.length) {
    const found = new Set(rows.map((row) => row.id))
    const missing = projectIds.filter((id) => !found.has(id))
    throw makeError('NOT_FOUND', `找不到项目：${missing.join(', ')}`)
  }
  return rows
}

export interface StartTrialInput {
  readonly projectIds: readonly string[]
  readonly now: string
  readonly note?: string
}

export async function startTrial(input: StartTrialInput): Promise<Result<string>> {
  const projects = validateProjectIds(input.projectIds)
  if (!projects.ok) return projects
  let now: string
  try {
    now = parseTime(input.now, 'now')
  } catch (error) {
    return err(
      makeError('SCHEMA_VIOLATION', error instanceof Error ? error.message : String(error)),
    )
  }
  const note = input.note?.trim()
  if (note !== undefined && (note === '' || note.length > 2000))
    return err(makeError('SCHEMA_VIOLATION', '--note 必须为 1..2000 字符'))
  const id = randomUUID()
  try {
    return await asRole('keel_control', async (c) => {
      await assertProjects(c, projects.value)
      const active = await c.query<{ id: string }>(
        'SELECT id FROM managed_trial WHERE ended_at IS NULL FOR UPDATE',
      )
      if (active.rows[0] !== undefined)
        return err(makeError('CONFLICT', `已有进行中的试运行：${active.rows[0].id}`))
      await c.query(
        `INSERT INTO managed_trial(id,started_at,note)
         VALUES($1,$2,$3)`,
        [id, now, note ?? null],
      )
      for (const projectId of projects.value) {
        await c.query('INSERT INTO managed_trial_project(trial_id,project_id) VALUES($1,$2)', [
          id,
          projectId,
        ])
      }
      return ok(id)
    })
  } catch (error) {
    return err(errorFrom(error, 'CONFLICT', '无法开始试运行'))
  }
}

export async function stopTrial(now: string, reason: string): Promise<Result<string>> {
  let at: string
  try {
    at = parseTime(now, 'now')
  } catch (error) {
    return err(
      makeError('SCHEMA_VIOLATION', error instanceof Error ? error.message : String(error)),
    )
  }
  const trimmed = reason.trim()
  if (trimmed === '' || trimmed.length > 2000)
    return err(makeError('SCHEMA_VIOLATION', '--reason 必须为 1..2000 字符'))
  try {
    return await asRole('keel_control', async (c) => {
      const active = await c.query<{ id: string }>(
        'SELECT id FROM managed_trial WHERE ended_at IS NULL FOR UPDATE',
      )
      const trial = active.rows[0]
      if (trial === undefined) return err(makeError('NOT_FOUND', '没有进行中的试运行'))
      await c.query(
        `UPDATE managed_trial
         SET ended_at=$2,stop_reason=$3
         WHERE id=$1 AND ended_at IS NULL`,
        [trial.id, at, trimmed],
      )
      return ok(trial.id)
    })
  } catch (error) {
    return err(errorFrom(error, 'CONFLICT', '无法停止试运行'))
  }
}

async function latestTrial(c: PoolClient): Promise<TrialRow | null> {
  const result = await c.query<TrialRow>(
    `SELECT id,started_at,ended_at,stop_reason,note
     FROM managed_trial
     ORDER BY (ended_at IS NULL) DESC,started_at DESC,id DESC
     LIMIT 1`,
  )
  return result.rows[0] ?? null
}

async function trialProjectIds(c: PoolClient, trialId: string): Promise<string[]> {
  const result = await c.query<{ project_id: string }>(
    `SELECT project_id FROM managed_trial_project
     WHERE trial_id=$1 ORDER BY project_id`,
    [trialId],
  )
  return result.rows.map((row) => row.project_id)
}

function emptyProject(project: ProjectRow): TrialProjectMetrics {
  return {
    project_id: project.id,
    remote_url: project.remote_url,
    delegated_decisions: 0,
    human_confirmed_decisions: 0,
    owner_required_decisions: 0,
    denied_decisions: 0,
    completed_tasks: 0,
  }
}

function addDecision(
  project: TrialProjectMetrics,
  disposition: string,
  count: number,
): TrialProjectMetrics {
  switch (disposition) {
    case 'delegated':
      return { ...project, delegated_decisions: project.delegated_decisions + count }
    case 'human_confirmed':
      return { ...project, human_confirmed_decisions: project.human_confirmed_decisions + count }
    case 'owner_required':
      return { ...project, owner_required_decisions: project.owner_required_decisions + count }
    case 'denied':
      return { ...project, denied_decisions: project.denied_decisions + count }
    default:
      return project
  }
}

async function metricsFor(
  c: PoolClient,
  projects: readonly ProjectRow[],
  startedAt: string,
  endedAt: string,
): Promise<TrialMetrics> {
  const projectIds = projects.map((project) => project.id)
  const decisions = await c.query<DecisionCountRow>(
    `SELECT q.project_id,r.disposition,count(*)::int AS count
     FROM managed_decision_resolution r
     JOIN managed_decision_request q
       ON q.id=r.request_id AND q.revision=r.request_revision
     WHERE q.project_id = ANY($1::uuid[])
       AND r.resolved_at >= $2 AND r.resolved_at <= $3
     GROUP BY q.project_id,r.disposition
     ORDER BY q.project_id,r.disposition`,
    [projectIds, startedAt, endedAt],
  )
  const completed = await c.query<CompletedCountRow>(
    `SELECT repo_id AS project_id,count(*)::int AS count
     FROM managed_ticket_task
     WHERE repo_id = ANY($1::uuid[])
       AND status='DONE'
       AND updated_at >= $2 AND updated_at <= $3
     GROUP BY repo_id
     ORDER BY repo_id`,
    [projectIds, startedAt, endedAt],
  )
  const openQuestions = await c.query<ScalarRow>(
    `SELECT count(*)::int AS count
     FROM managed_decision_request
     WHERE project_id = ANY($1::uuid[])
       AND status IN ('OPEN','PROCESSING','WAITING_HUMAN')`,
    [projectIds],
  )
  const uncertainActions = await c.query<ScalarRow>(
    `SELECT count(*)::int AS count
     FROM managed_action_outbox o
     JOIN managed_action_intent i ON i.id=o.action_intent_id
     WHERE i.project_id = ANY($1::uuid[])
       AND o.status='UNCERTAIN'
       AND o.updated_at >= $2 AND o.updated_at <= $3`,
    [projectIds, startedAt, endedAt],
  )
  const failedActions = await c.query<ScalarRow>(
    `SELECT count(*)::int AS count
     FROM managed_action_outbox o
     JOIN managed_action_intent i ON i.id=o.action_intent_id
     WHERE i.project_id = ANY($1::uuid[])
       AND o.status='FAILED'
       AND o.updated_at >= $2 AND o.updated_at <= $3`,
    [projectIds, startedAt, endedAt],
  )

  const byProject = new Map<string, TrialProjectMetrics>()
  for (const project of projects) byProject.set(project.id, emptyProject(project))
  for (const row of decisions.rows) {
    const project = byProject.get(row.project_id)
    if (project !== undefined)
      byProject.set(row.project_id, addDecision(project, row.disposition, Number(row.count)))
  }
  for (const row of completed.rows) {
    const project = byProject.get(row.project_id)
    if (project !== undefined)
      byProject.set(row.project_id, {
        ...project,
        completed_tasks: project.completed_tasks + Number(row.count),
      })
  }
  const rows = [...byProject.values()].sort((a, b) => a.remote_url.localeCompare(b.remote_url))
  return {
    delegated_decisions: rows.reduce((total, project) => total + project.delegated_decisions, 0),
    human_confirmed_decisions: rows.reduce(
      (total, project) => total + project.human_confirmed_decisions,
      0,
    ),
    owner_required_decisions: rows.reduce(
      (total, project) => total + project.owner_required_decisions,
      0,
    ),
    denied_decisions: rows.reduce((total, project) => total + project.denied_decisions, 0),
    completed_tasks: rows.reduce((total, project) => total + project.completed_tasks, 0),
    open_questions: Number(openQuestions.rows[0]?.count ?? 0),
    uncertain_actions: Number(uncertainActions.rows[0]?.count ?? 0),
    dead_letter_actions: Number(failedActions.rows[0]?.count ?? 0),
    by_project: rows,
  }
}

function emptyMetrics(): TrialMetrics {
  return {
    delegated_decisions: 0,
    human_confirmed_decisions: 0,
    owner_required_decisions: 0,
    denied_decisions: 0,
    completed_tasks: 0,
    open_questions: 0,
    uncertain_actions: 0,
    dead_letter_actions: 0,
    by_project: [],
  }
}

export async function readTrialStatus(now: string): Promise<Result<TrialEvaluation>> {
  let observedAt: string
  try {
    observedAt = parseTime(now, 'now')
  } catch (error) {
    return err(
      makeError('SCHEMA_VIOLATION', error instanceof Error ? error.message : String(error)),
    )
  }
  try {
    return await asRole('keel_control', async (c) => {
      const trial = await latestTrial(c)
      if (trial === null) {
        return ok(
          evaluateTrial({
            observed_at: observedAt,
            trial: null,
            metrics: emptyMetrics(),
          }),
        )
      }
      const projectIds = await trialProjectIds(c, trial.id)
      const projects = await projectRows(c, projectIds)
      const startedAt = iso(trial.started_at)
      const endedAt = trial.ended_at === null ? observedAt : iso(trial.ended_at)
      const metrics = await metricsFor(c, projects, startedAt, endedAt)
      return ok(
        evaluateTrial({
          observed_at: observedAt,
          trial: {
            id: trial.id,
            started_at: startedAt,
            ended_at: trial.ended_at === null ? null : iso(trial.ended_at),
            stop_reason: trial.stop_reason,
            note: trial.note,
            project_ids: projectIds,
          },
          metrics,
        }),
      )
    })
  } catch (error) {
    return err(errorFrom(error, 'NOT_FOUND', '无法读取试运行状态'))
  }
}
