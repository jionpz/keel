/**
 * PR 未合并关闭后的重驱动上下文。
 *
 * 重驱动的门槛只看事实：**最近一次任务已 S-ABANDONED，且它的 PRClosed
 * 事件理由是 `pr_closed_unmerged`**。同一 issue 可以因此拥有多个 Task，
 * 但反馈仍复用原 GitHub Feedback；额外的「上一轮 PR 关闭」说明以
 * 不可变 manual Feedback 写入，供下一轮 PM 读取。
 */

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { asRole } from '../fact/db.js'
import type { TaskStatus } from '../shared/ids.js'

export interface RedriveCandidate {
  readonly previousTaskId: string
  readonly externalRef: string
  /** 上一轮被关闭的 PR；重驱动时作为 PM 上下文的一部分 */
  readonly prUrl: string
  readonly prNumber: number | null
  readonly closedAt: string | null
}

export interface LatestGithubTask {
  readonly taskId: string
  readonly status: TaskStatus
  readonly feedbackId: string
}

/** 重驱动说明使用固定 external_ref，保证同一前序 Task 只建一条说明 */
export function redriveFeedbackRef(previousTaskId: string): string {
  return `redrive:${previousTaskId}`
}

/** 同一 issue 的最新 Task（重驱动后新 Task 会成为「最新」） */
export async function findLatestGithubTask(
  externalRef: string,
): Promise<LatestGithubTask | undefined> {
  const r = await asRole('keel_control', (c) =>
    c.query<{ task_id: string; status: TaskStatus; feedback_id: string }>(
      `SELECT t.id AS task_id, t.status, f.id AS feedback_id
       FROM feedback f
       JOIN task_feedback tf ON tf.feedback_id=f.id
       JOIN task t ON t.id=tf.task_id
       WHERE f.source='github' AND f.external_ref=$1
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1`,
      [externalRef],
    ),
  )
  const row = r.rows[0]
  return row === undefined
    ? undefined
    : { taskId: row.task_id, status: row.status, feedbackId: row.feedback_id }
}

/**
 * 查找可重驱动的前序 Task。
 *
 * 只认「最新 Task 已因 PR 未合并关闭而放弃」这一种形态：
 * 其它终态（S-DONE / S-REJECTED / S-FAILED / 超时放弃）都不能被重驱动，
 * 否则同一 issue 会被错误地反复开工。
 */
export async function findRedriveCandidate(
  externalRef: string,
): Promise<RedriveCandidate | undefined> {
  const r = await asRole('keel_control', (c) =>
    c.query<{
      task_id: string
      status: TaskStatus
      reason: string | null
      closed_at: string | null
      pr_url: string | null
      pr_number: string | null
    }>(
      `WITH latest AS (
         SELECT t.id, t.status
         FROM feedback f
         JOIN task_feedback tf ON tf.feedback_id=f.id
         JOIN task t ON t.id=tf.task_id
         WHERE f.source='github' AND f.external_ref=$1
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 1
       )
       SELECT latest.id AS task_id, latest.status,
              closed.payload->>'reason' AS reason,
              closed.payload->>'closed_at' AS closed_at,
              pr.payload->>'pr_url' AS pr_url,
              pr.payload->>'pr_number' AS pr_number
       FROM latest
       LEFT JOIN LATERAL (
         SELECT payload FROM event
         WHERE task_id=latest.id AND type='TaskStatusChanged'
           AND payload->>'event'='PRClosed'
         ORDER BY seq DESC LIMIT 1
       ) closed ON true
       LEFT JOIN LATERAL (
         SELECT payload FROM event
         WHERE task_id=latest.id
           AND type IN ('SideEffectApplied','SideEffectSkipped')
           AND payload->>'kind'='CreatePullRequest'
         ORDER BY seq DESC LIMIT 1
       ) pr ON true`,
      [externalRef],
    ),
  )
  const row = r.rows[0]
  if (
    row === undefined ||
    row.status !== 'S-ABANDONED' ||
    row.reason !== 'pr_closed_unmerged' ||
    row.pr_url === null ||
    row.pr_url === ''
  ) {
    return undefined
  }
  const number = Number(row.pr_number)
  return {
    previousTaskId: row.task_id,
    externalRef,
    prUrl: row.pr_url,
    prNumber: Number.isSafeInteger(number) && number > 0 ? number : null,
    closedAt: row.closed_at,
  }
}

/**
 * 写入（或复用）重驱动说明 Feedback。
 *
 * Feedback 不可变，所以说明只追加、不修改；同一个前序 Task 的说明由
 * `(source='manual', external_ref='redrive:<task>')` 唯一键去重。
 */
export async function ensureRedriveFeedback(
  candidate: RedriveCandidate,
  now: string,
): Promise<Result<{ readonly feedbackId: string }>> {
  const externalRef = redriveFeedbackRef(candidate.previousTaskId)
  const body = [
    '## 上一轮 PR 未合并关闭',
    '',
    `- 来源 issue：${candidate.externalRef}`,
    `- 上一轮 Task：${candidate.previousTaskId}`,
    `- PR：${candidate.prUrl}`,
    `- 关闭时间：${candidate.closedAt ?? 'GitHub 未返回'}`,
    '- 关闭原因：PR 未合并关闭（方案被否 / 需要重做）',
    '',
    '请在重新评估时带上这一事实；不要假设上一轮方案已经被接受。',
  ].join('\n')

  return asRole('keel_ingress', async (c) => {
    const id = randomUUID()
    const ins = await c.query<{ id: string }>(
      `INSERT INTO feedback (id, source, external_ref, body, received_at)
       VALUES ($1, 'manual', $2, $3, $4)
       ON CONFLICT (source, external_ref) DO NOTHING
       RETURNING id`,
      [id, externalRef, body, now],
    )
    if (ins.rows[0] !== undefined) return ok({ feedbackId: ins.rows[0].id })

    const existing = await c.query<{ id: string }>(
      `SELECT id FROM feedback WHERE source='manual' AND external_ref=$1`,
      [externalRef],
    )
    const row = existing.rows[0]
    if (row === undefined) {
      return err(makeError('CONFLICT', `重驱动说明 ${externalRef} 插入冲突但查不到既有行`))
    }
    return ok({ feedbackId: row.id })
  })
}
