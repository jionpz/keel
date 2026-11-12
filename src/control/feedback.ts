import type { PoolClient } from 'pg'

export async function loadTaskFeedback(
  client: PoolClient,
  taskId: string,
): Promise<readonly { body: string; external_ref: string; total_count: string }[]> {
  const result = await client.query<{
    body: string
    external_ref: string
    total_count: string
  }>(
    `WITH linked AS (
       SELECT f.id,f.body,f.external_ref,f.received_at FROM feedback f
       JOIN task_feedback tf ON tf.feedback_id=f.id WHERE tf.task_id=$1
     )
     SELECT body,external_ref,(SELECT count(*) FROM linked)::text AS total_count FROM (
       (SELECT * FROM linked ORDER BY received_at,id LIMIT 1)
       UNION
       (SELECT * FROM linked ORDER BY received_at DESC,id DESC LIMIT 9)
     ) selected ORDER BY received_at,id`,
    [taskId],
  )
  return result.rows
}
