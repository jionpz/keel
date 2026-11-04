/**
 * GitHub REST 实现 —— PullRequestGateway + CiGateway。
 *
 * 设计来源:design.md §4.2(v0.1 推荐 REST,因为 CI 环境不一定有 gh CLI)。
 *
 * 凭据纪律(docs/08-cross-cutting.md §1.3):
 *   - token 只从进程环境 `KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` 读;
 *   - 不进 URL、不进 argv、不进事件 payload、不进错误信息;
 *   - Authorization header 只存在于本进程内存。
 *
 * **诚实边界**:此实现按 GitHub REST API 文档编写,
 * 在拿到真实远程仓库与凭据前属于「未真实验证」——
 * 行为由 stub HTTP server 单测约束(见 github-provider.test.ts),
 * 真实路径由 test:acceptance 验证。不得在验收前标成「已验证」。
 */

import type { CiGateway, CiWaitInput } from '../contracts/ci-gateway.js'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  PullRequestGateway,
  PullRequestInfo,
  PullRequestInput,
} from '../contracts/git-provider.js'
import { readTokenFromEnv } from './github-auth.js'
import { isGitHubHost, type ParsedRemote, parseRemoteUrl } from './github-remote.js'

/**
 * 兼容 re-export：现有调用点(run-task / ingest-issue / 验收测试)
 * 继续从本模块 import，不因模块拆分而改动。
 */
export type { ParsedRemote } from './github-remote.js'
export { isGitHubHost, parseRemoteUrl, readTokenFromEnv }

/** 公网 GitHub 的 API 根。企业 host 由 apiRootForHost 推导。 */
export const DEFAULT_API_ROOT = 'https://api.github.com'

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const REPO_RE = /^[A-Za-z0-9._-]+$/

/**
 * 公网走 api.github.com；GHES 3.x 的 REST 根在 `/api/v3`。
 * 未设 KEEL_GITHUB_API_ROOT 时的缺省推导。
 */
export function apiRootForHost(host: string): string {
  return host.toLowerCase() === 'github.com'
    ? DEFAULT_API_ROOT
    : `https://${host.toLowerCase()}/api/v3`
}

const POLL_INTERVAL_MS = 10_000
const POLL_TIMEOUT_MS = 30 * 60_000
/**
 * 「无人上报」静默期 —— 见 combinedStatus 关于 `unreported` 的说明。
 * 90s 用来盖住 Actions 从 push/建 PR 到 check-run 出现在 API 上的排队延迟
 * (2026-08-28 实测约 3–10s),取一个宽裕值:多等一会儿不伤正确性,
 * 早下结论会造出假绿。
 */
const EMPTY_SETTLE_MS = 90_000

export interface GitHubProviderOptions {
  /** 覆盖 API 根地址 —— 测试用 stub server 注入 */
  readonly apiRoot?: string
  /** 显式 token。未传时读环境变量;传 `null` 强制无 token(测试缺凭据路径) */
  readonly token?: string | null
  /** 覆盖轮询间隔/上限 —— 测试用毫秒级 */
  readonly pollIntervalMs?: number
  readonly pollTimeoutMs?: number
  /** 覆盖「无人上报」静默期 —— 测试用毫秒级 */
  readonly emptySettleMs?: number
}

/**
 * 从远程 URL 解析 owner/repo（`owner/repo`）。
 *
 * 支持 https://<host>/owner/repo(.git)、http://、git@<host>:owner/repo.git
 * 与 ssh://git@<host>/owner/repo(.git)，host 限 github.com / github.*。
 * 验收测试的 cleanup 也用它 —— 单一事实源,不写第二份正则(#1-11)。
 */
export function ownerRepo(remoteUrl: string): Result<string> {
  const parsed = parseRemoteUrl(remoteUrl)
  if (!parsed.ok) return parsed
  return ok(`${parsed.value.owner}/${parsed.value.repo}`)
}

export interface IssueInfo {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean
}

/**
 * 列表视图 —— 刻意不含 `body`：
 * poller 只需要「去哪儿取」与「是否已处理」，正文由 ingest 侧再读一次。
 */
export interface ListedIssue {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean
  readonly labels: readonly string[]
}

export interface IssueList {
  readonly issues: readonly ListedIssue[]
  /** 触到 maxPages 上限且最后一页仍是满页 —— 可能还有更多，不静默截断 */
  readonly truncated: boolean
}

/**
 * 把 repo 的 remote 归一化为 Issue URL。
 *
 * 纯函数：SSH / https / SCP-like remote 都走同一个 `ParsedRemote`，
 * 避免 poller 直接拿 `repo.remote_url` 拼出 `git@host:...` 这种非 URL。
 */
export function issueUrlFor(parsed: ParsedRemote, number: number): string {
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/issues/${number}`
}

const LIST_PAGE_SIZE = 100
const LIST_MAX_PAGES = 10

export interface ParsedIssueUrl {
  readonly remoteUrl: string
  readonly number: number
}

/** 从 GitHub Issue URL 解析 remoteUrl 与 issue 编号（公网与 GHES 同一套规则） */
export function parseIssueUrl(url: string): Result<ParsedIssueUrl> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return err(makeError('WORKSPACE_ERROR', `无法解析 Issue URL:${url}`))
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return err(makeError('WORKSPACE_ERROR', `不支持的 Issue URL 协议:${parsedUrl.protocol}`))
  }
  if (!isGitHubHost(parsedUrl.hostname)) {
    return err(makeError('WORKSPACE_ERROR', `不是 GitHub host:${parsedUrl.hostname}(${url})`))
  }

  const m = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(parsedUrl.pathname)
  if (m === null) {
    return err(makeError('WORKSPACE_ERROR', `无法解析 Issue URL:${url}`))
  }
  const owner = m[1] as string
  const repo = m[2] as string
  const number = Number(m[3])
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return err(makeError('WORKSPACE_ERROR', `Issue URL 的 owner/repo 非法:${owner}/${repo}`))
  }

  const host = parsedUrl.hostname.toLowerCase()
  return ok({ remoteUrl: `https://${host}/${owner}/${repo}.git`, number })
}

export class GitHubProvider implements PullRequestGateway, CiGateway {
  private readonly apiRootOverride: string | undefined
  private readonly apiRootEnv: string | undefined
  private readonly token: string | undefined

  constructor(opts: GitHubProviderOptions = {}) {
    this.apiRootOverride = opts.apiRoot
    // 环境变量在构造时读一次，与 token 一致：进程生命周期内不变
    this.apiRootEnv = process.env.KEEL_GITHUB_API_ROOT
    this.token = opts.token === undefined ? readTokenFromEnv() : (opts.token ?? undefined)
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS
    this.emptySettleMs = opts.emptySettleMs ?? EMPTY_SETTLE_MS
  }

  /**
   * 按 host 选 API 根：显式注入 > KEEL_GITHUB_API_ROOT > apiRootForHost。
   *
   * 空白或非 http(s) 的配置**不是「未设置」**：返回错误而不是静默回退。
   * 企业部署里把内网 remote 静默打到 api.github.com 是数据外流，不是便利。
   */
  private rootFor(host: string): Result<string> {
    const explicit = this.apiRootOverride
    if (explicit !== undefined) {
      const trimmed = explicit.trim()
      if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) {
        return err(makeError('WORKSPACE_ERROR', 'apiRoot 非法:必须是非空的 http(s) 地址'))
      }
      return ok(trimmed.replace(/\/+$/, ''))
    }
    if (this.apiRootEnv !== undefined) {
      const trimmed = this.apiRootEnv.trim()
      if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) {
        return err(
          makeError('WORKSPACE_ERROR', 'KEEL_GITHUB_API_ROOT 非法:必须是非空的 http(s) 地址'),
        )
      }
      return ok(trimmed.replace(/\/+$/, ''))
    }
    return ok(apiRootForHost(host))
  }

  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number
  private readonly emptySettleMs: number

  /** GitHub API 公共头。Authorization 只在此处出现,不进 URL/argv/日志 */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }
  /**
   * 统一请求入口。
   *
   * 错误映射(design.md §7):
   *   401/403 → AUTH_FAILED(不可重试);404 → NOT_FOUND;
   *   429/5xx → HARNESS_UNAVAILABLE(可重试);网络层失败 → HARNESS_UNAVAILABLE。
   */
  private async request(
    host: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Result<{ status: number; json: unknown }>> {
    if (this.token === undefined) {
      return err(makeError('AUTH_FAILED', '缺少 GitHub token(KEEL_GITHUB_TOKEN / GITHUB_TOKEN)'))
    }
    const root = this.rootFor(host)
    if (!root.ok) return root
    let res: Response
    try {
      res = await fetch(
        `${root.value}${path}`,
        init.body === undefined
          ? {
              method: init.method ?? 'GET',
              headers: this.headers(),
            }
          : {
              method: init.method ?? 'GET',
              headers: { ...this.headers(), 'Content-Type': 'application/json' },
              body: JSON.stringify(init.body),
            },
      )
    } catch {
      // 刻意不透传错误对象:其信息可能包含完整 URL(含 query),虽无 token 也避免噪音
      return err(makeError('HARNESS_UNAVAILABLE', `GitHub API 请求失败:${path}`))
    }

    if (res.status === 401 || res.status === 403) {
      return err(makeError('AUTH_FAILED', `GitHub 认证失败(HTTP ${res.status})`))
    }
    if (res.status === 404) {
      return err(makeError('NOT_FOUND', `GitHub 资源不存在:${path}`))
    }
    if (res.status >= 500 || res.status === 429) {
      return err(makeError('HARNESS_UNAVAILABLE', `GitHub API 暂不可用(HTTP ${res.status})`))
    }

    const text = await res.text()
    const json: unknown = text === '' ? null : JSON.parse(text)
    return ok({ status: res.status, json })
  }

  /**
   * 按 head 分支查已有 PR —— 幂等的前提。
   *
   * head 过滤器必须是 `owner:branch`。实测(2026-08-23 验收):
   * `owner/repo:branch`(无论是否 %2F 编码)GitHub 一律返回空集,
   * 导致幂等查询永远落空、重复调用撞 422。
   */
  private async findExistingPr(
    host: string,
    slug: string,
    headBranch: string,
  ): Promise<Result<PullRequestInfo | null>> {
    const owner = slug.split('/')[0] ?? slug
    const r = await this.request(
      host,
      `/repos/${slug}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(headBranch)}&state=open`,
    )
    if (!r.ok) return r
    const list = r.value.json as { number: number; html_url: string }[] | null
    const existing = Array.isArray(list) ? list[0] : undefined
    if (existing === undefined) return ok(null)
    return ok({ number: existing.number, url: existing.html_url, created: false })
  }

  async createPullRequest(input: PullRequestInput): Promise<Result<PullRequestInfo>> {
    if (!input.headBranch.startsWith('ai/')) {
      return err(
        makeError('PERMISSION_DENIED', `只允许为 ai/* 分支创建 PR,收到:${input.headBranch}`),
      )
    }
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`

    const existing = await this.findExistingPr(host, slug, input.headBranch)
    if (!existing.ok) return existing
    if (existing.value !== null) return ok(existing.value)

    const created = await this.request(host, `/repos/${slug}/pulls`, {
      method: 'POST',
      body: {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      },
    })
    if (!created.ok) return created
    if (created.value.status !== 201) {
      return err(
        makeError('WORKSPACE_ERROR', `创建 PR 返回非预期状态 HTTP ${created.value.status}`),
      )
    }
    const pr = created.value.json as { number: number; html_url: string }
    return ok({ number: pr.number, url: pr.html_url, created: true })
  }

  /**
   * 等 CI 到终态。四个出口:
   *   - 读到 passed / failed → 直接返回;
   *   - 有人上报但没跑完(pending)→ 继续轮询;
   *   - 无人上报(unreported)且已过静默期 → 认定该仓库没配 CI,返回 passed;
   *   - 硬超时 → 按失败返回,由编排器转成 CIFailed(T-025),人可介入。
   */
  async waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>> {
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`

    const start = Date.now()
    const deadline = start + this.pollTimeoutMs
    for (;;) {
      const combined = await this.combinedStatus(host, slug, input.headSha)
      if (!combined.ok) return combined

      if (combined.value === 'passed' || combined.value === 'failed') return ok(combined.value)

      // 无人上报:先把静默期走完,才敢下「这仓库没有 CI」的结论。
      if (combined.value === 'unreported' && Date.now() - start >= this.emptySettleMs) {
        return ok('passed')
      }

      if (Date.now() > deadline) {
        // 硬超时按失败处理 —— 由编排器转成 CIFailed(T-025),人可介入
        return ok('failed')
      }
      await sleep(this.pollIntervalMs)
    }
  }

  /**
   * 合并 Checks 与 Commit Status 为四态:
   *   任一 failed → failed;有人上报但未跑完 → pending;
   *   有人上报且全绿 → passed;**一个都没人上报** → unreported。
   *
   * CI 是外部事实源,这里只读取并归并,**绝不制造结论**。
   *
   * `unreported` 必须与 `passed` 分开(2026-08-28 假绿实测教训):
   * Actions-only 仓库的 `commits/{sha}/status` 恒为 `state=pending` + 空 statuses,
   * 而 check-run 要过几秒才出现在 `commits/{sha}/check-runs` 上。建 PR 后的那几秒里
   * 两个端点都读不到任何东西,与「这仓库压根没配 CI」在数据上完全同形。
   * 旧实现把它当 passed,于是 PR 建好 3.5 秒就流出了 T-024 ——
   * CI 还没开始跑,系统已经宣布它过了(2026-08-28 第六次验收实录:
   * PR 15:45:53 建成,T-024 15:45:56,真实 check-run 15:46:01 才启动)。
   * 判据要的是「通过 CI 的 PR」,这种结论是假绿。等多久算「真的没人上报」
   * 是策略,归 waitForCi 的静默期;本函数只负责如实分辨两者。
   */
  private async combinedStatus(
    host: string,
    slug: string,
    sha: string,
  ): Promise<Result<'passed' | 'failed' | 'pending' | 'unreported'>> {
    const checks = await this.request(host, `/repos/${slug}/commits/${sha}/check-runs`)
    if (!checks.ok) return checks
    const statuses = await this.request(host, `/repos/${slug}/commits/${sha}/status`)
    if (!statuses.ok) return statuses

    const cj = checks.value.json as {
      total_count: number
      check_runs: { status: string; conclusion: string | null }[]
    } | null
    const checkRuns = cj !== null && Array.isArray(cj.check_runs) ? cj.check_runs : []
    for (const run of checkRuns) {
      if (
        run.status === 'completed' &&
        run.conclusion !== 'success' &&
        run.conclusion !== 'skipped'
      ) {
        return ok('failed')
      }
      if (run.status !== 'completed') return ok('pending')
    }

    const sj = statuses.value.json as { state: string | null; statuses: unknown[] } | null
    if (sj !== null && sj.state !== null && sj.state !== 'pending') {
      return ok(sj.state === 'success' ? 'passed' : 'failed')
    }
    // state=pending:有显式 status 上报才是「还在跑」;
    // 无上报时本端点对结论毫无贡献(Actions-only 仓库恒如此),不能当成结论。
    if (sj !== null && Array.isArray(sj.statuses) && sj.statuses.length > 0) return ok('pending')

    // Commit Status 给不出结论,只剩 Checks 可依据:
    // 有 check 且已全绿 → passed(上面的循环已经放过 failed/未完成);一条都没有 → 无人上报。
    return ok(checkRuns.length > 0 ? 'passed' : 'unreported')
  }

  /**
   * 列出某仓库带指定 label 的 open issue（poller 的扫描入口）。
   *
   * 三个刻意的判断：
   *   - **过滤 PR**：issues API 会把 PR 混进结果，`pull_request !== undefined` 一律丢弃；
   *   - **分页**：每页 100 条，读完不足一页即停；触到 `maxPages` 上限时
   *     返回 `truncated: true`，不静默截断（100 条单页上限会漏 issue）；
   *   - **同轮去重**：分页期间 issue 状态变化可能导致跨页重复，按 number 保留首条。
   *
   * label 为空直接拒绝：GitHub 在 `labels=` 为空时会退化成列出全部 open issue，
   * 那等于跨过 label 闸门。
   */
  async listOpenIssues(
    remoteUrl: string,
    label: string,
    opts: { readonly maxPages?: number } = {},
  ): Promise<Result<IssueList>> {
    const trimmedLabel = label.trim()
    if (trimmedLabel === '') {
      return err(
        makeError(
          'WORKSPACE_ERROR',
          'listOpenIssues 需要非空 label：空 label 会列出全部 open issue，跨过 label 闸门',
        ),
      )
    }
    const maxPages = opts.maxPages ?? LIST_MAX_PAGES
    if (!Number.isInteger(maxPages) || maxPages < 1) {
      return err(makeError('WORKSPACE_ERROR', `maxPages 必须是正整数，收到:${maxPages}`))
    }

    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`

    /** 跨页按 number 去重；Map 保留首次出现的顺序 */
    const byNumber = new Map<number, ListedIssue>()
    let truncated = false

    for (let page = 1; page <= maxPages; page++) {
      // URLSearchParams 负责编码 label 里的空格 / 中文 / 斜杠 —— 手拼 query 会在这里出错
      const query = new URLSearchParams({
        state: 'open',
        labels: trimmedLabel,
        per_page: String(LIST_PAGE_SIZE),
        page: String(page),
      })
      const r = await this.request(host, `/repos/${slug}/issues?${query.toString()}`)
      if (!r.ok) return r
      if (r.value.status !== 200) {
        return err(makeError('WORKSPACE_ERROR', `列出 Issue 返回非预期状态 HTTP ${r.value.status}`))
      }
      if (!Array.isArray(r.value.json)) {
        return err(makeError('PROTOCOL_ERROR', `Issue 列表响应不是数组:${slug} page=${page}`))
      }

      for (const raw of r.value.json) {
        const issue = parseListedIssue(raw)
        if (!issue.ok) return issue
        if (issue.value.isPullRequest) continue
        if (!byNumber.has(issue.value.number)) byNumber.set(issue.value.number, issue.value)
      }

      // 不足一页 = 没有下一页。满页且已到上限 = 可能还有，如实标 truncated。
      if (r.value.json.length < LIST_PAGE_SIZE) break
      if (page === maxPages) truncated = true
    }

    return ok({ issues: [...byNumber.values()], truncated })
  }

  async getIssue(remoteUrl: string, issueNumber: number): Promise<Result<IssueInfo>> {
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`

    const r = await this.request(host, `/repos/${slug}/issues/${issueNumber}`)
    if (!r.ok) return r
    if (r.value.status !== 200) {
      return err(makeError('WORKSPACE_ERROR', `读取 Issue 返回非预期状态 HTTP ${r.value.status}`))
    }

    const raw = r.value.json as {
      number?: number
      title?: string
      body?: string | null
      state?: string
      labels?: { name: string }[]
      pull_request?: unknown
    } | null

    // 200 但形状不对 = 契约被破坏,不是「没有这个 Issue」。
    // 不做乐观解构:labels 缺失时 .map 会以 TypeError 冒泡,吞掉真实原因。
    if (raw === null || typeof raw.number !== 'number' || typeof raw.title !== 'string') {
      return err(makeError('PROTOCOL_ERROR', `Issue 响应缺少 number/title:${slug}`))
    }

    return ok({
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      labels: Array.isArray(raw.labels) ? raw.labels.map((l) => l.name) : [],
      state: raw.state === 'closed' ? 'closed' : 'open',
      isPullRequest: raw.pull_request !== undefined,
    })
  }
}

/**
 * 解析列表元素。形状不对 = 契约被破坏（PROTOCOL_ERROR），不是「跳过这一条」——
 * 静默跳过会让漏掉的 issue 永远不被发现。
 */
function parseListedIssue(raw: unknown): Result<ListedIssue> {
  if (typeof raw !== 'object' || raw === null) {
    return err(makeError('PROTOCOL_ERROR', 'Issue 列表包含非对象元素'))
  }
  const item = raw as {
    number?: unknown
    title?: unknown
    state?: unknown
    labels?: unknown
    pull_request?: unknown
  }
  if (typeof item.number !== 'number' || typeof item.title !== 'string') {
    return err(makeError('PROTOCOL_ERROR', 'Issue 列表元素缺少 number/title'))
  }
  return ok({
    number: item.number,
    title: item.title,
    state: item.state === 'closed' ? 'closed' : 'open',
    isPullRequest: item.pull_request !== undefined,
    labels: labelNames(item.labels),
  })
}

function labelNames(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const label of raw) {
    if (typeof label === 'object' && label !== null) {
      const name = (label as { name?: unknown }).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
