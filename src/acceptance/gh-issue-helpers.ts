/**
 * issue-e2e / five-run 共用的 gh 与 cleanup  helper。
 * 抽出以免五连 batch 复制 100+ 行 —— 改 gh PAT 注入或 AC5-3b 只改一处。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { branchFor } from '../fact/git-workspace.js'
import { readTokenFromEnv } from '../fact/github-provider.js'

export const KEEL_LABEL = 'keel'

export function gh(args: readonly string[]): string {
  const t = readTokenFromEnv()
  const env = t === undefined ? process.env : { ...process.env, GH_TOKEN: t, GITHUB_TOKEN: t }
  return execFileSync('gh', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
}

export function prNumber(url: string): string {
  return url.split('/').at(-1) ?? ''
}

/** 创建带 keel label 的 Issue；body 由调用方提供（五连用 5 变体） */
export function createLabeledIssue(slug: string, title: string, body: string): string {
  try {
    gh(['label', 'create', KEEL_LABEL, '--repo', slug, '--description', 'Keel 自动构建闸门'])
  } catch {
    // label 已存在
  }
  const out = gh([
    'issue',
    'create',
    '--repo',
    slug,
    '--title',
    title,
    '--body',
    body,
    '--label',
    KEEL_LABEL,
  ])
  const url = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('https://'))
    .at(-1)
  if (url === undefined) {
    throw new Error(`gh issue create 未返回 URL:${out}`)
  }
  return url
}

/** AC5-3b：head SHA 上必须有跑完且成功的 check */
export function verifyCiOnPr(slug: string, prUrl: string): void {
  const headSha = gh([
    'pr',
    'view',
    prNumber(prUrl),
    '--repo',
    slug,
    '--json',
    'headRefOid',
    '--jq',
    '.headRefOid',
  ]).trim()
  const checkRuns = JSON.parse(gh(['api', `/repos/${slug}/commits/${headSha}/check-runs`])) as {
    check_runs: { name: string; status: string; conclusion: string | null }[]
  }
  const completed = checkRuns.check_runs.filter((c) => c.status === 'completed')
  if (completed.length === 0) {
    throw new Error(`head SHA ${headSha} 上没有任何跑完的 check —— T-024 无真实 CI 作证(假绿)`)
  }
  const bad = completed.filter((c) => c.conclusion !== 'success' && c.conclusion !== 'skipped')
  if (bad.length > 0) {
    throw new Error(
      `真实 check 未全绿:${completed.map((c) => `${c.name}=${c.conclusion}`).join(', ')}`,
    )
  }
}

export function cleanupAcceptanceRun(opts: {
  readonly remote: string
  readonly slug: string
  readonly taskId: string | undefined
  readonly prUrl: string | null
  readonly issueNumber: string
}): void {
  if (opts.prUrl !== null) {
    try {
      gh(['pr', 'close', prNumber(opts.prUrl), '--repo', opts.slug])
    } catch {
      /* 已关闭 */
    }
  }
  if (opts.taskId !== undefined) {
    try {
      execFileSync('git', ['push', opts.remote, '--delete', branchFor(opts.taskId)], {
        stdio: 'pipe',
      })
    } catch {
      /* 分支可能已清理 */
    }
  }
  try {
    gh(['issue', 'close', opts.issueNumber, '--repo', opts.slug])
  } catch {
    /* 已关闭 */
  }
}

export interface FiveRunRecord {
  readonly run: number
  readonly issue_url: string
  readonly task_id: string
  readonly final_status: string
  readonly transitions: readonly string[]
  readonly pr_url: string | null
  readonly ci_verified: boolean
  readonly duration_s: number
  readonly human_intervention: false
  readonly failure_class: string | null
}

export function appendFiveRunJsonl(path: string, record: FiveRunRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}
