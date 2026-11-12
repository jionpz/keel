/**
 * GitHub 只读仓库信号 —— PM 查重 / 查是否已修复的输入。
 *
 * 边界：
 *   - 只发 GET，不评论、不关单、不改仓库；
 *   - 任何失败都返回 `Result`，由 ContextBuilder 降级为空并记诊断；
 *   - token 不进入 URL、argv、错误 detail 或事件 payload。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  RepoSignalCommit,
  RepoSignalItem,
  RepoSignals,
  RepoSignalsQuery,
  RepoSignalsSource,
} from '../contracts/repo-signals.js'
import type { TokenResolver } from './github-auth.js'
import { GitHubProvider, parseRemoteUrl } from './github-provider.js'

const COMMIT_PAGE_SIZE = 100
const COMMIT_MAX_PAGES = 2

export interface GitHubRepoSignalsOptions {
  /** 覆盖 API 根地址 —— 测试用 stub server 注入 */
  readonly apiRoot?: string
  /** 显式 token；`null` 强制无凭据（测试缺凭据路径） */
  readonly token?: string | null
  readonly tokenResolver?: TokenResolver
  readonly fetchFn?: typeof fetch
}

interface RawCommit {
  readonly sha?: unknown
  readonly html_url?: unknown
  readonly commit?: {
    readonly message?: unknown
    readonly author?: { readonly date?: unknown }
    readonly committer?: { readonly date?: unknown }
  }
}

interface RawSearchItem {
  readonly number?: unknown
  readonly title?: unknown
  readonly body?: unknown
  readonly state?: unknown
  readonly html_url?: unknown
  readonly pull_request?: { readonly merged_at?: unknown } | null
}

interface RawSearchPage {
  readonly items?: unknown
}

interface CommitWithMessage extends RepoSignalCommit {
  readonly message: string
}

export class GitHubRepoSignals implements RepoSignalsSource {
  private readonly provider: GitHubProvider

  constructor(opts: GitHubRepoSignalsOptions = {}) {
    this.provider = new GitHubProvider(opts)
  }

  async load(query: RepoSignalsQuery): Promise<Result<RepoSignals>> {
    const parsed = parseRemoteUrl(query.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`
    const nowMs = Date.parse(query.now)
    if (!Number.isFinite(nowMs)) {
      return err(makeError('WORKSPACE_ERROR', `repo_signals 的 now 不是合法时间:${query.now}`))
    }
    const since = new Date(nowMs - query.sinceDays * 86_400_000).toISOString()
    // 标题关键词优先于正文：正文很长时，6 字正文 n-gram 不应把标题里的
    // 「下拉数据源」挤出检索词。本地过滤仍同时使用标题与正文关键词。
    const titleKeywords = extractKeywords(query.issueTitle, 20)
    const bodyKeywords = extractKeywords(query.issueBody, 20)
    const keywords = [...new Set([...titleKeywords, ...bodyKeywords])]
    const searchKeywords = titleKeywords.length > 0 ? titleKeywords : bodyKeywords

    const [recent, issues, pullRequests, references] = await Promise.all([
      this.recentCommits(host, slug, query.defaultBranch, since),
      keywords.length === 0
        ? Promise.resolve(ok<readonly RepoSignalItem[]>([]))
        : this.searchItems(host, slug, 'issue', searchKeywords, query.maxIssues),
      keywords.length === 0
        ? Promise.resolve(ok<readonly RepoSignalItem[]>([]))
        : this.searchItems(host, slug, 'pr', searchKeywords, query.maxPullRequests),
      query.issueNumber === null
        ? Promise.resolve(ok<readonly RepoSignalItem[]>([]))
        : this.searchReferences(host, slug, query.issueNumber, query.maxPullRequests),
    ])
    if (!recent.ok) return recent
    if (!issues.ok) return issues
    if (!pullRequests.ok) return pullRequests
    if (!references.ok) return references

    const commits = recent.value
      .filter((commit) => matchesKeywords(commit.title, keywords))
      .slice(0, query.maxCommits)
      .map(withoutMessage)
    const issueItems = issues.value
      .filter((item) => item.number !== query.issueNumber && matchesKeywords(item.title, keywords))
      .slice(0, query.maxIssues)
    const pullRequestItems = pullRequests.value
      .filter((item) => item.number !== query.issueNumber && matchesKeywords(item.title, keywords))
      .slice(0, query.maxPullRequests)

    const referencedCommits =
      query.issueNumber === null
        ? []
        : recent.value
            .filter((commit) => referencesIssue(commit.message, host, slug, query.issueNumber ?? 0))
            .slice(0, query.maxCommits)
            .map(withoutMessage)
    const referencedPullRequests = references.value
      .filter((item) => item.isPullRequest)
      .slice(0, query.maxPullRequests)

    return ok({
      commits,
      issues: issueItems,
      pullRequests: pullRequestItems,
      referencedCommits,
      referencedPullRequests,
    })
  }

  private async recentCommits(
    host: string,
    slug: string,
    branch: string,
    since: string,
  ): Promise<Result<readonly CommitWithMessage[]>> {
    const commits: CommitWithMessage[] = []
    for (let page = 1; page <= COMMIT_MAX_PAGES; page++) {
      const params = new URLSearchParams({
        sha: branch,
        since,
        per_page: String(COMMIT_PAGE_SIZE),
        page: String(page),
      })
      const response = await this.request(host, `/repos/${slug}/commits?${params.toString()}`)
      if (!response.ok) return response
      if (!Array.isArray(response.value.json)) {
        return err(makeError('PROTOCOL_ERROR', `GitHub commits 响应不是数组:${slug}`))
      }
      for (const raw of response.value.json) {
        const commit = parseCommit(raw)
        if (commit === null) {
          return err(makeError('PROTOCOL_ERROR', `GitHub commit 缺少必需字段:${slug}`))
        }
        commits.push(commit)
      }
      if (response.value.json.length < COMMIT_PAGE_SIZE) break
    }
    return ok(dedupeCommits(commits))
  }

  private async searchItems(
    host: string,
    slug: string,
    kind: 'issue' | 'pr',
    keywords: readonly string[],
    max: number,
  ): Promise<Result<readonly RepoSignalItem[]>> {
    const q = buildTitleSearchQuery(slug, kind, keywords)
    const params = new URLSearchParams({
      q,
      per_page: String(Math.min(100, Math.max(max * 2, 10))),
      sort: 'updated',
      order: 'desc',
    })
    return this.search(host, `/search/issues?${params.toString()}`)
  }

  private async searchReferences(
    host: string,
    slug: string,
    issueNumber: number,
    max: number,
  ): Promise<Result<readonly RepoSignalItem[]>> {
    const q = `repo:${slug} "#${issueNumber}"`
    const params = new URLSearchParams({
      q,
      per_page: String(Math.min(100, Math.max(max, 10))),
      sort: 'updated',
      order: 'desc',
    })
    return this.search(host, `/search/issues?${params.toString()}`, { slug, issueNumber })
  }

  private async search(
    host: string,
    path: string,
    reference?: { slug: string; issueNumber: number },
  ): Promise<Result<readonly RepoSignalItem[]>> {
    const response = await this.request(host, path)
    if (!response.ok) return response
    const page = response.value.json as RawSearchPage | null
    if (!Array.isArray(page?.items)) {
      return err(makeError('PROTOCOL_ERROR', 'GitHub search 响应缺少 items 数组'))
    }
    const items: RepoSignalItem[] = []
    for (const raw of page.items) {
      const item = parseSearchItem(raw)
      if (item === null) {
        return err(makeError('PROTOCOL_ERROR', 'GitHub search item 缺少必需字段'))
      }
      const body = (raw as RawSearchItem).body
      if (
        reference !== undefined &&
        !referencesIssue(
          `${item.title}\n${typeof body === 'string' ? body : ''}`,
          host,
          reference.slug,
          reference.issueNumber,
        )
      )
        continue
      items.push(item)
    }
    return ok(dedupeItems(items))
  }

  private async request(
    host: string,
    path: string,
  ): Promise<Result<{ status: number; json: unknown }>> {
    const result = await this.provider.readJson(host, path)
    if (!result.ok) return result
    return result.value.status === 200
      ? result
      : err(makeError('PROTOCOL_ERROR', `GitHub repo_signals 返回 HTTP ${result.value.status}`))
  }
}

function parseCommit(raw: unknown): CommitWithMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as RawCommit
  const sha = typeof item.sha === 'string' ? item.sha : null
  const title =
    typeof item.commit?.message === 'string' ? item.commit.message.split('\n')[0]?.trim() : null
  const committedAt =
    typeof item.commit?.author?.date === 'string'
      ? item.commit.author.date
      : typeof item.commit?.committer?.date === 'string'
        ? item.commit.committer.date
        : null
  const url = typeof item.html_url === 'string' ? item.html_url : null
  if (sha === null || title === null || title === undefined || committedAt === null || url === null)
    return null
  return { sha, title, committedAt, url, message: String(item.commit?.message) }
}

function withoutMessage({ message: _message, ...commit }: CommitWithMessage): RepoSignalCommit {
  return commit
}

function parseSearchItem(raw: unknown): RepoSignalItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as RawSearchItem
  const number = typeof item.number === 'number' ? item.number : null
  const title = typeof item.title === 'string' ? item.title : null
  const state = item.state === 'open' || item.state === 'closed' ? item.state : null
  const url = typeof item.html_url === 'string' ? item.html_url : null
  if (number === null || title === null || state === null || url === null) return null
  const isPullRequest = item.pull_request !== undefined && item.pull_request !== null
  const merged =
    isPullRequest && typeof item.pull_request?.merged_at === 'string'
      ? item.pull_request.merged_at !== ''
      : false
  return { number, title, state, url, isPullRequest, merged }
}

function dedupeCommits(commits: readonly CommitWithMessage[]): readonly CommitWithMessage[] {
  const seen = new Set<string>()
  return commits.filter((commit) => {
    if (seen.has(commit.sha)) return false
    seen.add(commit.sha)
    return true
  })
}

function dedupeItems(items: readonly RepoSignalItem[]): readonly RepoSignalItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.isPullRequest ? 'pr' : 'issue'}:${item.number}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function matchesKeywords(title: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false
  const haystack = title.toLowerCase()
  return keywords.some((keyword) => haystack.includes(keyword))
}

/**
 * GitHub search 的 q 上限是 256 字符。按完整词累加，绝不从引号中间截断；
 * 标题词先进入查询，保证长正文不会挤掉标题里的关键现象。
 */
function buildTitleSearchQuery(
  slug: string,
  kind: 'issue' | 'pr',
  keywords: readonly string[],
): string {
  const prefix = `repo:${slug} is:${kind} in:title `
  const terms: string[] = []
  for (const keyword of keywords.slice(0, 4)) {
    const clean = keyword.replaceAll('"', '').slice(0, 80)
    const term = `"${clean}"`
    const candidate = terms.length === 0 ? term : `${terms.join(' OR ')} OR ${term}`
    if (prefix.length + candidate.length <= 256) terms.push(term)
    if (terms.length === 4) break
  }
  return `${prefix}${terms.join(' OR ')}`
}

function referencesIssue(text: string, host: string, slug: string, issueNumber: number): boolean {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(?:^|[\\s(])(?:#|${escapedSlug}#|https?://${escapedHost}/${escapedSlug}/(?:issues|pull)/)${issueNumber}(?![0-9])`,
    'i',
  ).test(text)
}

const STOPWORDS = new Set([
  'about',
  'after',
  'before',
  'could',
  'error',
  'from',
  'have',
  'issue',
  'should',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'when',
  'where',
  'which',
  'with',
  'would',
  '一个',
  '不能',
  '为什么',
  '什么',
  '可以',
  '如何',
  '应该',
  '怎么',
  '无法',
  '这个',
  '需要',
  '问题',
])

/**
 * 中文没有空格，不能用英文分词。这里同时取拉丁词与中文 3–6 字 n-gram，
 * 让「下拉数据源错误」能命中提交里的「修复下拉数据源」。
 */
export function extractKeywords(text: string, max = 40): readonly string[] {
  const found = new Set<string>()
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? []) {
    const token = raw.toLowerCase()
    if (!STOPWORDS.has(token)) found.add(token)
  }
  for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    for (let length = Math.min(6, run.length); length >= 3; length--) {
      for (let start = 0; start + length <= run.length; start++) {
        const token = run.slice(start, start + length)
        if (!STOPWORDS.has(token)) found.add(token)
      }
    }
  }
  return [...found]
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, max)
}
