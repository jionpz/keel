import { randomUUID } from 'node:crypto'
import type { IssueGateway } from '../contracts/issue-gateway.js'
import { asRole } from '../fact/db.js'
import { parseRemoteUrl } from '../fact/github-remote.js'
import { WorkflowDriver } from './driver/driver.js'
import { RuleBasedPolicyEngine } from './policy/engine.js'
import { DEFAULT_RULESET } from './policy/ruleset.js'

export async function collectIssueClarifications(
  gateway: IssueGateway,
  now: string,
): Promise<number> {
  const waiting = await asRole('keel_control', (client) =>
    client.query<{
      task_id: string
      current_run_id: string
      remote_url: string
      issue_number: number
      comment_id: string
      created_at: string
      delivery_id: string
    }>(
      `SELECT DISTINCT ON (t.id,d.remote_url,d.issue_number) t.id AS task_id,t.current_run_id,d.remote_url,
         d.issue_number,d.comment_id,d.created_at,d.id AS delivery_id
       FROM task t JOIN issue_delivery d ON d.task_id=t.id JOIN repo r ON r.id=t.repo_id
       WHERE t.status='S-NEED_CLARIFICATION' AND t.control_mode='auto'
         AND r.issue_writeback<>'off' AND d.event_name='clarification_requested'
         AND d.delivered_at IS NOT NULL AND d.comment_id IS NOT NULL
         AND d.id=(SELECT max(latest.id) FROM issue_delivery latest
           WHERE latest.task_id=t.id AND latest.remote_url=d.remote_url
             AND latest.issue_number=d.issue_number AND latest.event_name='clarification_requested')
       ORDER BY t.id,d.remote_url,d.issue_number,d.id DESC`,
    ),
  )
  let resumed = 0
  const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
  for (const task of waiting.rows) {
    const actor = await gateway.issueActor(task.remote_url)
    if (!actor.ok) continue
    const listed = await gateway.listIssueComments(
      task.remote_url,
      task.issue_number,
      new Date(task.created_at).toISOString(),
    )
    if (!listed.ok || listed.value.truncated) continue
    const comments = listed.value.comments.filter(
      (comment) =>
        comment.id > Number(task.comment_id) &&
        comment.author.toLowerCase() !== actor.value.toLowerCase() &&
        !comment.body.includes('<!-- keel:') &&
        comment.body.trim().length > 0,
    )
    if (comments.length === 0) continue
    const parsed = parseRemoteUrl(task.remote_url)
    if (!parsed.ok) continue
    const reference = `${parsed.value.owner}/${parsed.value.repo}#${task.issue_number}`
    const feedbackIds = await asRole('keel_ingress', async (client) => {
      const ids: string[] = []
      for (const comment of comments) {
        const externalRef = `${reference}/comment/${comment.id}`
        await client.query(
          `INSERT INTO feedback (id,source,external_ref,body)
           VALUES ($1,'github',$2,$3) ON CONFLICT (source,external_ref) DO NOTHING`,
          [randomUUID(), externalRef, comment.body],
        )
        const row = await client.query<{ id: string }>(
          `SELECT id FROM feedback WHERE source='github' AND external_ref=$1`,
          [externalRef],
        )
        if (row.rows[0] !== undefined) ids.push(row.rows[0].id)
      }
      return ids
    })
    const linked = await asRole('keel_control', async (client) => {
      const current = await client.query(
        `SELECT id FROM task WHERE id=$1 AND status='S-NEED_CLARIFICATION'
         AND control_mode='auto' AND current_run_id=$2 FOR UPDATE`,
        [task.task_id, task.current_run_id],
      )
      if (current.rows.length === 0) return false
      for (const feedbackId of feedbackIds) {
        await client.query(
          'INSERT INTO task_feedback (task_id,feedback_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [task.task_id, feedbackId],
        )
      }
      return true
    })
    if (!linked) continue
    const advanced = await driver.advance(
      task.task_id,
      {
        type: 'ClarificationReceived',
        ...(feedbackIds[0] === undefined ? {} : { feedbackId: feedbackIds[0] }),
      },
      now,
      { expectedRunId: task.current_run_id },
    )
    if (advanced.ok && advanced.value.advanced) resumed++
  }
  return resumed
}
