import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../fact/db.js'
import {
  ensureRedriveFeedback,
  findLatestGithubTask,
  findRedriveCandidate,
  redriveFeedbackRef,
} from './redrive.js'

const NOW = '2026-11-12T02:30:00Z'
const REMOTE = 'https://github.com/acme/widget.git'
const EXTERNAL_REF = 'acme/widget#42'

interface Seeded {
  readonly repoId: string
  readonly feedbackId: string
  readonly previousTaskId: string
}

async function seedAbandonedTask(
  options: {
    readonly status?: string
    readonly reason?: string
    readonly prUrl?: string | null
    readonly createdAt?: string
  } = {},
): Promise<Seeded> {
  const repoId = randomUUID()
  const feedbackId = randomUUID()
  const previousTaskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1, 'github', $2, 'main')`,
      [repoId, REMOTE],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body, received_at)
       VALUES ($1, 'github', $2, '原 Issue 正文', $3)`,
      [feedbackId, EXTERNAL_REF, NOW],
    )
    await c.query(
      `INSERT INTO task
         (id, status, title, repo_id, base_branch, work_branch, created_at)
       VALUES ($1, $2, '原任务', $3, 'main', $4, $5)`,
      [
        previousTaskId,
        options.status ?? 'S-ABANDONED',
        repoId,
        `ai/task-${previousTaskId.slice(0, 8)}`,
        options.createdAt ?? NOW,
      ],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1, $2)`, [
      previousTaskId,
      feedbackId,
    ])
    await c.query(
      `INSERT INTO event (task_id, type, payload, occurred_at)
       VALUES ($1, 'TaskStatusChanged', $2::jsonb, $3)`,
      [
        previousTaskId,
        JSON.stringify({
          from: 'S-PR_OPEN',
          to: 'S-ABANDONED',
          transition: 'T-027',
          event: 'PRClosed',
          reason: options.reason ?? 'pr_closed_unmerged',
          closed_at: NOW,
        }),
        NOW,
      ],
    )
    const prUrl =
      options.prUrl === undefined ? 'https://github.com/acme/widget/pull/11' : options.prUrl
    if (prUrl !== null) {
      await c.query(
        `INSERT INTO event (task_id, type, payload, occurred_at)
         VALUES ($1, 'SideEffectApplied', $2::jsonb, $3)`,
        [
          previousTaskId,
          JSON.stringify({
            kind: 'CreatePullRequest',
            dedupe_key: `ai/task-${previousTaskId.slice(0, 8)}`,
            pr_number: 11,
            pr_url: prUrl,
          }),
          NOW,
        ],
      )
    }
  })
  return { repoId, feedbackId, previousTaskId }
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

describe('findRedriveCandidate', () => {
  it('最新 Task 因 PR 未合并关闭而 S-ABANDONED → 返回可重驱动候选', async () => {
    const seeded = await seedAbandonedTask()

    const candidate = await findRedriveCandidate(EXTERNAL_REF)

    expect(candidate).toEqual({
      previousTaskId: seeded.previousTaskId,
      externalRef: EXTERNAL_REF,
      prUrl: 'https://github.com/acme/widget/pull/11',
      prNumber: 11,
      closedAt: NOW,
    })
  })

  it('S-ABANDONED 但关闭理由不是 pr_closed_unmerged → 拒绝', async () => {
    await seedAbandonedTask({ reason: 'issue_closed' })

    expect(await findRedriveCandidate(EXTERNAL_REF)).toBeUndefined()
  })

  it('S-ABANDONED 但没有可引用的 PR → 拒绝', async () => {
    await seedAbandonedTask({ prUrl: null })

    expect(await findRedriveCandidate(EXTERNAL_REF)).toBeUndefined()
  })

  it('同一 issue 已有更新的 Task → 不以旧的 S-ABANDONED 反复重驱动', async () => {
    const seeded = await seedAbandonedTask()
    const newerTaskId = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO task
           (id, status, title, repo_id, base_branch, work_branch, created_at)
         VALUES ($1, 'S-NEW', '重驱动任务', $2, 'main', $3, $4)`,
        [newerTaskId, seeded.repoId, `ai/task-${newerTaskId.slice(0, 8)}`, '2026-11-12T03:00:00Z'],
      ),
    )
    await asOwner((c) =>
      c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1, $2)`, [
        newerTaskId,
        seeded.feedbackId,
      ]),
    )

    expect(await findRedriveCandidate(EXTERNAL_REF)).toBeUndefined()
    expect(await findLatestGithubTask(EXTERNAL_REF)).toMatchObject({
      taskId: newerTaskId,
      status: 'S-NEW',
      feedbackId: seeded.feedbackId,
    })
  })
})

describe('ensureRedriveFeedback', () => {
  it('追加不可变 manual Feedback，重复调用复用同一行', async () => {
    const seeded = await seedAbandonedTask()
    const candidate = await findRedriveCandidate(EXTERNAL_REF)
    expect(candidate).toBeDefined()
    if (candidate === undefined) return

    const first = await ensureRedriveFeedback(candidate, NOW)
    const second = await ensureRedriveFeedback(candidate, '2026-11-12T04:00:00Z')

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.value.feedbackId).toBe(first.value.feedbackId)

    const rows = await asOwner((c) =>
      c.query<{ source: string; external_ref: string; body: string }>(
        `SELECT source, external_ref, body FROM feedback
         WHERE source='manual' AND external_ref=$1`,
        [redriveFeedbackRef(seeded.previousTaskId)],
      ),
    )
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]).toMatchObject({
      source: 'manual',
      external_ref: `redrive:${seeded.previousTaskId}`,
    })
    expect(rows.rows[0]?.body).toContain('上一轮 PR 未合并关闭')
    expect(rows.rows[0]?.body).toContain('https://github.com/acme/widget/pull/11')
    expect(rows.rows[0]?.body).toContain('不要假设上一轮方案已经被接受')
  })
})
