import { EMPTY_DEVELOP_DIFF } from '../shared/ci.js'
import { asRole } from './db.js'

// 仅接受 CreatePullRequest 副作用持久化的 PR 绑定。
export const PR_BINDING_FILTER = `type IN ('SideEffectApplied','SideEffectSkipped')
  AND payload->>'kind'='CreatePullRequest' AND payload->>'pr_number' ~ '^[1-9][0-9]*$'`

// 旧版因 CI 自动返工且以零改动耗尽重试的任务，仍能消费同一 PR 的新检查结果。
export const LATEST_CI_REVIEW_SQL = `SELECT
    (review.payload->>'transition'='T-026' AND review.payload->>'source'='github')
    OR (review.payload->>'transition'='T-031' AND
        (SELECT payload->>'transition' IN ('T-025','T-026') AND payload->>'source'='github'
         FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
           AND payload->>'transition' IN ('T-016','T-017','T-021','T-025','T-026','T-045')
           AND seq < review.seq
         ORDER BY seq DESC LIMIT 1)
        AND (SELECT starts_with(error_detail, '${EMPTY_DEVELOP_DIFF}')
             FROM run WHERE task_id=$1 AND stage='develop'
             ORDER BY attempt DESC LIMIT 1)) AS awaiting_ci_review
    FROM event review WHERE task_id=$1 AND type='TaskStatusChanged'
      AND payload->>'to'='S-HUMAN_REVIEW'
      AND NOT EXISTS (SELECT 1 FROM event reset WHERE reset.task_id=$1
        AND reset.type='TaskStatusChanged' AND reset.seq > review.seq
        AND reset.payload->>'transition' IN ('T-016','T-017','T-021','T-045'))
    ORDER BY seq DESC LIMIT 1`

export async function readTaskPullRequestRef(
  taskId: string,
): Promise<{ number: number; url: string } | null> {
  const result = await asRole('keel_control', (c) =>
    c.query<{ number: string; url: string | null }>(
      `SELECT payload->>'pr_number' AS number, payload->>'pr_url' AS url
       FROM event WHERE task_id=$1 AND ${PR_BINDING_FILTER} ORDER BY seq DESC LIMIT 1`,
      [taskId],
    ),
  )
  const row = result.rows[0]
  if (row === undefined || !Number.isSafeInteger(Number(row.number))) return null
  return { number: Number(row.number), url: row.url ?? '' }
}
