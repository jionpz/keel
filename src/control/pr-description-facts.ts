/**
 * legacy Task/Run 的 PR 事实读取：只读取已提交的 Fact Plane 产物。
 *
 * 开 PR 时不再从模型生成问题/根因/改动/验证；RFC、develop、QA、Review、State
 * 都按最新未取代版本读取，并把 `artifact:<kind>@<version>` 写进正文章节。
 */

import type { PoolClient } from 'pg'
import { materialize } from '../fact/blob.js'
import type { CommitMessageFields } from '../shared/commit-policy.js'
import {
  type PullRequestArtifactFact,
  type PullRequestSection,
  pullRequestSections,
} from './pr-description.js'

interface ArtifactRow {
  readonly kind: string
  readonly key: string
  readonly version: number
  readonly body: unknown
}

function refFor(kind: string, key: string, version: number): string {
  return kind === 'stage_outcome'
    ? `artifact:stage_outcome/${key}@${version}`
    : `artifact:${kind}@${version}`
}

function fact(row: ArtifactRow | undefined): PullRequestArtifactFact | undefined {
  if (row === undefined) return undefined
  if (row.body === null || typeof row.body !== 'object' || Array.isArray(row.body)) return undefined
  return {
    ref: refFor(row.kind, row.key, row.version),
    body: row.body as Record<string, unknown>,
  }
}

export interface LegacyPullRequestFacts {
  readonly sections: readonly PullRequestSection[]
  readonly developCommitMessage?: CommitMessageFields | undefined
}

function commitMessageFromBody(body: unknown): CommitMessageFields | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const fields = (body as { commit_message?: unknown }).commit_message
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return undefined
  const { type, scope, summary } = fields as Record<string, unknown>
  return typeof type === 'string' && typeof scope === 'string' && typeof summary === 'string'
    ? { type, scope, summary }
    : undefined
}

/** 读取最新未取代的 RFC / State / develop / QA / Review 产物。 */
export async function loadLegacyPullRequestFacts(
  client: PoolClient,
  input: {
    readonly taskId: string
    readonly issueTitle: string
    readonly fallbackChanges: string
  },
): Promise<LegacyPullRequestFacts> {
  const rows = await client.query<ArtifactRow>(
    `SELECT DISTINCT ON (kind,key) kind,key,version,body
     FROM artifact
     WHERE task_id=$1 AND superseded_by IS NULL
       AND ((kind IN ('rfc','state') AND key='')
         OR (kind='stage_outcome' AND key IN ('develop','qa','review')))
     ORDER BY kind,key,version DESC`,
    [input.taskId],
  )
  const latest = new Map<string, ArtifactRow>()
  for (const row of rows.rows) {
    const key = row.kind === 'stage_outcome' ? `${row.kind}/${row.key}` : row.kind
    latest.set(key, { ...row, body: await materialize(row.body) })
  }
  const developCommitMessage = commitMessageFromBody(latest.get('stage_outcome/develop')?.body)
  return {
    sections: pullRequestSections({
      issueTitle: input.issueTitle,
      issueSource: `ticket:${input.taskId}`,
      facts: {
        rfc: fact(latest.get('rfc')),
        state: fact(latest.get('state')),
        develop: fact(latest.get('stage_outcome/develop')),
        qa: fact(latest.get('stage_outcome/qa')),
        review: fact(latest.get('stage_outcome/review')),
      },
      fallbackChanges: input.fallbackChanges,
      fallbackChangesSource: `git:${input.taskId}`,
    }),
    ...(developCommitMessage === undefined ? {} : { developCommitMessage }),
  }
}
