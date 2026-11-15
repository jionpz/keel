import type { PoolClient } from 'pg'

/** 两套引擎在同一事务锁下检查并认领，避免相反方向的“先查后写”竞争。 */
export async function lockIssueOwnership(
  c: PoolClient,
  repoId: string,
  issueRef: string,
): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify(['issue-ownership', repoId, issueRef]),
  ])
}
