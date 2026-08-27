/**
 * keel ingest-issue —— GitHub Issue → feedback → T-001 intake。
 */

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asRole } from '../fact/db.js'
import { GitHubProvider, ownerRepo, parseIssueUrl } from '../fact/github-provider.js'
import { normalizeRemoteUrl } from '../fact/remote-url.js'
import { parseArgs } from './argv.js'

export interface IngestIssueOptions {
  readonly issueUrl: string
  readonly label?: string
  readonly repoId?: string
  readonly github?: GitHubProvider
  readonly now?: string
}

export interface IngestIssueResult {
  readonly feedbackId: string
  readonly taskId: string
  readonly created: boolean
}

/**
 * 共享 ingest 逻辑 —— run-issue(child 2)复用。
 *
 * 闸门拒绝、repo 未注册都是**可预期失败**，走 Result；
 * 只有数据不自洽（冲突后查不到既有行）才抛异常。
 *
 * 闸门拒绝统一映射 PERMISSION_DENIED（retryable=false）：label 是授权边界，
 * 关闭 / PR 型条目重试也不会变成可 ingest 的 Issue。
 */
export async function ingestIssue(opts: IngestIssueOptions): Promise<Result<IngestIssueResult>> {
  const parsed = parseIssueUrl(opts.issueUrl)
  if (!parsed.ok) return parsed
  const { remoteUrl, number } = parsed.value
  const label = opts.label ?? 'keel'
  const now = opts.now ?? new Date().toISOString()
  const github = opts.github ?? new GitHubProvider()

  const slug = ownerRepo(remoteUrl)
  if (!slug.ok) return slug
  const externalRef = `${slug.value}#${number}`

  const issue = await github.getIssue(remoteUrl, number)
  if (!issue.ok) return issue
  if (issue.value.isPullRequest) {
    return err(makeError('PERMISSION_DENIED', `#${number} 是 Pull Request 而非 Issue，拒绝 ingest`))
  }
  if (issue.value.state !== 'open') {
    return err(makeError('PERMISSION_DENIED', `Issue #${number} 已关闭，拒绝 ingest`))
  }
  if (!issue.value.labels.includes(label)) {
    return err(
      makeError('PERMISSION_DENIED', `Issue #${number} 缺少 label "${label}"，拒绝 ingest`),
    )
  }

  const repoRow = await resolveRepo(remoteUrl, opts.repoId)
  if (repoRow === undefined) {
    return err(
      makeError('NOT_FOUND', `未找到 remote ${remoteUrl} 对应的 repo，请先运行 keel register-repo`),
    )
  }

  const body = `${issue.value.title}\n\n${issue.value.body}`
  const feedbackId = await asRole('keel_ingress', async (c) => {
    const id = randomUUID()
    const ins = await c.query(
      `INSERT INTO feedback (id, source, external_ref, body)
       VALUES ($1, 'github', $2, $3)
       ON CONFLICT (source, external_ref) DO NOTHING
       RETURNING id`,
      [id, externalRef, body],
    )
    if (ins.rows[0] !== undefined) {
      return ins.rows[0].id as string
    }
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM feedback WHERE source = 'github' AND external_ref = $1`,
      [externalRef],
    )
    const row = existing.rows[0]
    if (row === undefined) {
      throw new Error('feedback 插入冲突但查不到既有行')
    }
    return row.id
  })

  const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
  const intake = await driver.intake(
    {
      feedbackId,
      title: issue.value.title,
      repoId: repoRow.id,
      baseBranch: repoRow.default_branch,
    },
    now,
  )
  if (!intake.ok) return intake

  return ok({
    feedbackId,
    taskId: intake.value.taskId,
    created: intake.value.created,
  })
}

async function resolveRepo(
  remoteUrl: string,
  explicitRepoId: string | undefined,
): Promise<{ id: string; default_branch: string } | undefined> {
  const normalized = normalizeRemoteUrl(remoteUrl)
  return asRole('keel_control', async (c) => {
    if (explicitRepoId !== undefined) {
      const r = await c.query<{ id: string; default_branch: string }>(
        'SELECT id, default_branch FROM repo WHERE id = $1',
        [explicitRepoId],
      )
      return r.rows[0]
    }
    const r = await c.query<{ id: string; default_branch: string }>(
      `SELECT id, default_branch FROM repo
       WHERE regexp_replace(regexp_replace(remote_url, '/+$', ''), '\\.git$', '', 'i') = $1`,
      [normalized],
    )
    return r.rows[0]
  })
}

export async function ingestIssueMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel ingest-issue <issueUrl> [--label <name>] [--repo <uuid>]

从 GitHub Issue 创建 feedback 并 intake 为 S-NEW task。
缺省 label 闸门: keel`)
    return
  }
  const issueUrl = positionals[0]
  if (issueUrl === undefined) {
    console.error('ingest-issue: 缺少 issueUrl')
    process.exitCode = 1
    return
  }
  const label = typeof flags.label === 'string' ? flags.label : undefined
  const repoId = typeof flags.repo === 'string' ? flags.repo : undefined

  const result = await ingestIssue({
    issueUrl,
    ...(label === undefined ? {} : { label }),
    ...(repoId === undefined ? {} : { repoId }),
  })
  if (!result.ok) {
    console.error(`ingest-issue: ${result.error.detail}`)
    process.exitCode = 1
    return
  }
  console.log(`taskId: ${result.value.taskId}`)
  console.log(`feedbackId: ${result.value.feedbackId}`)
  console.log(`created: ${result.value.created}`)
}
