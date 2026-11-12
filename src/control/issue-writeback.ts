import type { PoolClient } from 'pg'
import { err, makeError, type Result } from '../contracts/errors.js'
import type { IssueGateway } from '../contracts/issue-gateway.js'
import { materialize } from '../fact/blob.js'
import { asRole } from '../fact/db.js'
import { parseRemoteUrl } from '../fact/github-remote.js'
import { ensureTraceId } from '../fact/trace.js'

export type IssueWritebackEvent =
  | 'accepted'
  | 'clarification_requested'
  | 'rejected'
  | 'human_review'
  | 'pr_opened'
  | 'ci_passed'
  | 'abandoned'
  | 'merged'

interface WritebackInput {
  readonly taskId: string
  readonly state: string
  readonly transition: string
  readonly seq: number
  readonly now: string
}

export async function enqueueIssueWriteback(
  client: PoolClient,
  input: WritebackInput,
): Promise<void> {
  const event = writebackEvent(input.transition)
  if (event === null) return
  const rows = await client.query<{
    repo_id: string
    remote_url: string
    issue_writeback: string
    external_ref: string
  }>(
    `SELECT r.id AS repo_id, r.remote_url, r.issue_writeback, f.external_ref
     FROM task t JOIN repo r ON r.id=t.repo_id
     JOIN task_feedback tf ON tf.task_id=t.id JOIN feedback f ON f.id=tf.feedback_id
     WHERE t.id=$1 AND f.source='github' AND r.issue_writeback<>'off'
     ORDER BY f.external_ref`,
    [input.taskId],
  )
  if (rows.rows.length === 0) return
  const outcome = await client.query<{ body: unknown }>(
    `SELECT body FROM artifact WHERE task_id=$1 AND kind='stage_outcome' AND key='pm'
     ORDER BY version DESC LIMIT 1`,
    [input.taskId],
  )
  const raw = outcome.rows[0]
  const pm = raw === undefined ? {} : ((await materialize(raw.body)) as Record<string, unknown>)
  const pr = await client.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM event WHERE task_id=$1 AND type IN ('SideEffectApplied','SideEffectSkipped')
       AND payload->>'kind'='CreatePullRequest' ORDER BY seq DESC LIMIT 1`,
    [input.taskId],
  )
  if (event === 'pr_opened' && typeof pr.rows[0]?.payload.pr_url !== 'string') return
  const message = writebackMessage(event, input, pm, pr.rows[0]?.payload)
  for (const row of rows.rows) {
    const parsed = parseRemoteUrl(row.remote_url)
    const reference = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9]\d*)$/.exec(row.external_ref)
    if (!parsed.ok || reference === null) continue
    const remoteUrl = `https://${parsed.value.host}/${reference[1]}/${reference[2]}.git`
    if (!parseRemoteUrl(remoteUrl).ok) continue
    const dedupeKey = `issue-comment:${input.taskId}:${event}:${input.seq}:${row.external_ref}`
    const body =
      `${message}\n\n<!-- keel:delivery=${dedupeKey} -->\n` +
      `<!-- keel:v1 event=${event} task=${input.taskId} state=${input.state} -->`
    await client.query(
      `INSERT INTO issue_delivery
       (task_id,repo_id,remote_url,issue_number,event_name,dedupe_key,body,close_reason,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.taskId,
        row.repo_id,
        remoteUrl,
        Number(reference[3]),
        event,
        dedupeKey,
        body,
        row.issue_writeback === 'comment_and_close' && event === 'rejected' ? 'not_planned' : null,
        input.now,
      ],
    )
  }
}

function writebackEvent(transition: string): IssueWritebackEvent | null {
  if (transition === 'T-003' || transition === 'T-004') return 'accepted'
  if (transition === 'T-005') return 'clarification_requested'
  if (transition === 'T-006') return 'rejected'
  if (['T-013', 'T-020', 'T-023', 'T-026', 'T-031'].includes(transition)) return 'human_review'
  if (transition === 'T-021') return 'pr_opened'
  if (transition === 'T-042') return 'ci_passed'
  if (transition === 'T-024') return 'merged'
  if (transition === 'T-008' || transition === 'T-028' || transition === 'T-027') return 'abandoned'
  return null
}

function writebackMessage(
  event: IssueWritebackEvent,
  input: WritebackInput,
  pm: Record<string, unknown>,
  pr: Record<string, unknown> | undefined,
): string {
  if (event === 'accepted') return `Keel 已接手此问题，Task ${input.taskId}。`
  if (event === 'clarification_requested') {
    const questions = Array.isArray(pm.questions) ? pm.questions : []
    return [
      'Keel 需要补充信息后才能继续。',
      ...questions.map((question, index) => `${index + 1}. ${String(question)}`),
      questions.length === 0 ? String(pm.reason ?? '请补充需求背景与验收标准。') : '',
      '请直接在本 issue 下回复。',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  if (event === 'rejected') {
    return [
      `Keel 拒收：${String(pm.reject_kind ?? 'not_actionable')}。${String(pm.reason ?? '')}`,
      ...(Array.isArray(pm.evidence) ? pm.evidence.map(String) : []),
      '如仍复现，请附截图后重开。',
    ].join('\n\n')
  }
  if (event === 'human_review') {
    const reasons: Record<string, string> = {
      'T-013': '策略要求人工批准',
      'T-020': 'QA 重试已用尽',
      'T-023': '代码评审重试已用尽',
      'T-026': 'CI 重试已用尽',
      'T-031': '阶段执行重试已用尽',
    }
    return `Keel 等待人工评审：${reasons[input.transition] ?? input.transition}。`
  }
  if (event === 'pr_opened') return `Keel 已开 PR：${String(pr?.url ?? pr?.pr_url ?? '')}。`
  if (event === 'ci_passed') return 'Keel 的 CI 已通过，等待合并。'
  if (event === 'merged') return 'Keel 观察到 PR 已合并。'
  return `Keel 已停止本轮任务：${input.transition === 'T-008' ? '澄清超时' : input.transition === 'T-027' ? 'PR 未合并关闭' : '人工评审超时'}。`
}

export async function drainIssueWriteback(
  gateway: IssueGateway,
  now: string,
  options: { readonly limit?: number; readonly maxAttempts?: number } = {},
): Promise<number> {
  let delivered = 0
  const limit = options.limit ?? 20
  const maxAttempts = options.maxAttempts ?? 5
  for (let index = 0; index < limit; index++) {
    const worked = await asRole('keel_control', async (client) => {
      const pending = await client.query<{
        id: string
        task_id: string
        remote_url: string
        issue_number: number
        dedupe_key: string
        body: string
        close_reason: 'completed' | 'not_planned' | null
        issue_writeback: string
        comment_id: string | null
      }>(
        `SELECT d.*,r.issue_writeback FROM issue_delivery d JOIN repo r ON r.id=d.repo_id
         WHERE d.delivered_at IS NULL AND d.attempts<$1 AND r.issue_writeback<>'off'
         ORDER BY d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [maxAttempts],
      )
      const row = pending.rows[0]
      if (row === undefined) return false
      await client.query('UPDATE issue_delivery SET attempts=attempts+1 WHERE id=$1', [row.id])
      let commentId = row.comment_id === null ? null : Number(row.comment_id)
      let result: Result<unknown>
      try {
        const listed = await gateway.listIssueComments(row.remote_url, row.issue_number)
        if (!listed.ok) result = listed
        else if (listed.value.truncated)
          result = err(makeError('CONFLICT', '评论分页截断，无法安全判重；未发送评论'))
        else {
          const actor = await gateway.issueActor(row.remote_url)
          if (!actor.ok) result = actor
          else {
            commentId ??=
              listed.value.comments.find(
                (comment) =>
                  comment.author.toLowerCase() === actor.value.toLowerCase() &&
                  comment.body.includes(`<!-- keel:delivery=${row.dedupe_key} -->`),
              )?.id ?? null
            if (commentId === null) {
              const created = await gateway.createIssueComment(
                row.remote_url,
                row.issue_number,
                row.body,
              )
              result = created
              if (created.ok) commentId = created.value.id
            } else result = { ok: true, value: undefined }
            if (
              result.ok &&
              row.close_reason !== null &&
              row.issue_writeback === 'comment_and_close'
            )
              result = await gateway.closeIssue(row.remote_url, row.issue_number, row.close_reason)
          }
        }
      } catch {
        result = err(makeError('HARNESS_UNAVAILABLE', 'Issue 网关调用异常'))
      }
      await client.query(
        `UPDATE issue_delivery SET comment_id=$2,
         delivered_at=CASE WHEN $3 THEN $4::timestamptz ELSE NULL END WHERE id=$1`,
        [row.id, commentId, result.ok, now],
      )
      const traceId = await ensureTraceId(client, row.task_id, now)
      await client.query(
        `INSERT INTO event (task_id,type,payload,trace_id,occurred_at) VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [
          row.task_id,
          result.ok ? 'SideEffectApplied' : 'SideEffectFailed',
          JSON.stringify({
            kind: 'IssueWriteback',
            dedupe_key: row.dedupe_key,
            comment_id: commentId,
            ...(result.ok
              ? {}
              : {
                  error_kind: result.error.kind,
                  http_status: /HTTP (\d{3})/.exec(result.error.detail)?.[1] ?? null,
                }),
          }),
          traceId,
          now,
        ],
      )
      if (result.ok) delivered++
      return result.ok
    })
    if (!worked) break
  }
  return delivered
}
