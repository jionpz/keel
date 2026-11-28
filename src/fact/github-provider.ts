/**
 * GitHub REST 实现 —— PullRequestGateway + CiGateway。
 *
 * 设计来源:design.md §4.2(v0.1 推荐 REST,因为 CI 环境不一定有 gh CLI)。
 *
 * 凭据纪律(docs/08-cross-cutting.md §1.3):
 *   - token 来源优先级:`KEEL_GITHUB_TOKEN` / `GITHUB_TOKEN` / `gh auth login` 的登录态;
 *   - 不进 URL、不进 argv、不进事件 payload、不进错误信息;
 *   - Authorization header 只存在于本进程内存。
 *
 * **诚实边界**:此实现按 GitHub REST API 文档编写,
 * 在拿到真实远程仓库与凭据前属于「未真实验证」——
 * 行为由 stub HTTP server 单测约束(见 github-provider.test.ts),
 * 真实路径由 test:acceptance 验证。不得在验收前标成「已验证」。
 */

import { createHash } from 'node:crypto'
import {
  type CiGateway,
  type CiObservation,
  type CiRerunTarget,
  type CiWaitInput,
  isTransientCiObservation,
} from '../contracts/ci-gateway.js'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  PullRequestGateway,
  PullRequestInfo,
  PullRequestInput,
} from '../contracts/git-provider.js'
import type { IssueComment, IssueCommentPage, IssueGateway } from '../contracts/issue-gateway.js'
import type {
  PullRequestState,
  PullRequestStateGateway,
  PullRequestStateInput,
} from '../contracts/pull-request-state.js'
import type {
  RequiredCheckFact,
  RequiredCheckGateway,
  RequiredCheckObservationInput,
  RequiredCheckSnapshot,
} from '../contracts/required-checks.js'
import type { CiFailureEvidence } from '../shared/ci.js'
import {
  gitAuthSecrets,
  redactSecrets,
  resolveGitHubToken,
  type TokenResolver,
} from './github-auth.js'
import { isGitHubHost, type ParsedRemote, parseRemoteUrl } from './github-remote.js'

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
const EMPTY_SETTLE_MS = 90_000
const CI_PAGE_SIZE = 100
const CI_MAX_PAGES = 10

export interface GitHubProviderOptions {
  /** 覆盖 API 根地址 —— 测试用 stub server 注入 */
  readonly apiRoot?: string
  /** 显式 token。未传时按 host 解析(env → gh);传 `null` 强制无 token(测试缺凭据路径) */
  readonly token?: string | null
  /**
   * token 解析器注入点。缺省 `resolveGitHubToken`(env → `gh auth token`)。
   * 显式 `token` 拥有最高优先级:给了(token 或 null)就**绝不**调用 resolver。
   */
  readonly tokenResolver?: TokenResolver
  /** 覆盖轮询间隔/上限 —— 测试用毫秒级 */
  readonly pollIntervalMs?: number
  readonly pollTimeoutMs?: number
  /** 覆盖「无人上报」静默期 —— 测试用毫秒级 */
  readonly emptySettleMs?: number
  readonly fetchFn?: typeof fetch
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
  /** GitHub 返回的关闭时间；open 时为 null。对账把它写进取消证据，不本地推断 */
  readonly closedAt: string | null
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

interface RawPullRequest {
  readonly number: number
  readonly html_url?: string
  readonly state?: string
  readonly merged?: boolean
  readonly merged_at?: string | null
  readonly merge_commit_sha?: string | null
  readonly closed_at?: string | null
  readonly head?: { readonly ref?: string; readonly sha?: string }
  readonly base?: { readonly ref?: string }
}

interface RawCheckRun {
  readonly id: number
  readonly name: string
  readonly head_sha?: string
  readonly status: string
  readonly conclusion: string | null
  readonly details_url?: string
  readonly started_at?: string
  readonly completed_at?: string
  readonly check_suite?: { readonly id?: number }
  readonly app?: { readonly id?: number; readonly slug?: string }
  readonly output?: { readonly title?: string | null }
}

interface RawActionsRun {
  readonly id: number
  readonly head_sha: string
  readonly check_suite_id: number
  readonly run_attempt: number
  readonly status: string
  readonly conclusion: string | null
}

interface RawActionsJob {
  readonly check_run_url?: string
  readonly head_sha?: string
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
}

function actionsRunMatches(run: RawActionsRun, sha: string): boolean {
  return (
    run.head_sha === sha &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    run.status === 'completed' &&
    run.conclusion === 'failure'
  )
}

interface RawCommitStatus {
  readonly id: number
  readonly context: string
  readonly state: string
  readonly target_url?: string
}

interface CommitCheckSnapshot {
  readonly checks: readonly RawCheckRun[]
  readonly statuses: readonly RawCommitStatus[]
  readonly workflows: ReadonlyMap<number, RawActionsRun>
}

interface PullRequestObservation {
  readonly number: number
  readonly url: string
  readonly state: 'open' | 'closed'
  readonly headBranch: string
  readonly baseBranch: string
  readonly headSha: string
}

function isOpenState(value: string | undefined): 'open' | 'closed' | null {
  return value === 'open' || value === 'closed' ? value : null
}

function validHeadSha(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
}

function checkConclusion(run: RawCheckRun): string {
  return run.status === 'completed' ? (run.conclusion ?? 'unknown') : 'pending'
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

const CHECK_STATUSES = ['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']
const CHECK_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]

function verdict(conclusion: string): 'pending' | 'passed' | 'failed' {
  if (conclusion === 'pending') return 'pending'
  return ['success', 'skipped', 'neutral'].includes(conclusion) ? 'passed' : 'failed'
}

export class GitHubProvider
  implements
    PullRequestGateway,
    PullRequestStateGateway,
    CiGateway,
    RequiredCheckGateway,
    IssueGateway
{
  private readonly apiRootOverride: string | undefined
  private readonly apiRootEnv: string | undefined
  /**
   * 显式 token 的「给了」标记与值。
   *
   * 用包装对象而不是 `string | null | undefined`：`null`(强制无凭据)与
   * 「未传」(走 resolver)必须可区分 —— 测试靠 `token: null` 断言零请求。
   */
  private readonly explicitToken: { readonly value: string | undefined } | undefined
  private readonly tokenResolver: TokenResolver
  private readonly fetchFn: typeof fetch
  /** 按 host 缓存解析结果 —— 一次进程生命周期内不重复调 `gh` */
  private readonly tokenCache = new Map<string, string>()

  constructor(opts: GitHubProviderOptions = {}) {
    this.apiRootOverride = opts.apiRoot
    // 环境变量在构造时读一次，与 token 一致：进程生命周期内不变
    this.apiRootEnv = process.env.KEEL_GITHUB_API_ROOT
    this.explicitToken = opts.token === undefined ? undefined : { value: opts.token ?? undefined }
    this.tokenResolver = opts.tokenResolver ?? resolveGitHubToken
    this.fetchFn = opts.fetchFn ?? fetch
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

  /**
   * 取某 host 的 token。
   *
   * 显式 `opts.token`(含 `null`)优先级最高且不走 resolver —— 测试用它强制
   * 「无凭据」路径。否则按 host 解析并缓存；resolver 抛错按无 token 处理，
   * 不把异常内容(可能含凭据)带出去。
   */
  private async tokenFor(host: string): Promise<string | undefined> {
    if (this.explicitToken !== undefined) return this.explicitToken.value

    const cached = this.tokenCache.get(host)
    if (cached !== undefined) return cached

    let resolved: string | undefined
    try {
      resolved = await this.tokenResolver(host)
    } catch {
      resolved = undefined
    }
    if (resolved === undefined) return undefined
    const token = resolved.trim()
    if (token === '') return undefined
    this.tokenCache.set(host, token)
    return token
  }

  /** GitHub API 公共头。Authorization 只在此处出现,不进 URL/argv/日志 */
  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
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
  ): Promise<Result<{ status: number; json: unknown; hasNextPage: boolean }>> {
    const token = await this.tokenFor(host)
    if (token === undefined) {
      return err(
        makeError(
          'AUTH_FAILED',
          `缺少 GitHub 凭据（${host}）：设置 KEEL_GITHUB_TOKEN / GITHUB_TOKEN，` +
            `或先执行 \`gh auth login --hostname ${host}\``,
        ),
      )
    }
    const root = this.rootFor(host)
    if (!root.ok) return root
    let res: Response
    try {
      res = await this.fetchFn(
        `${root.value}${path}`,
        init.body === undefined
          ? {
              method: init.method ?? 'GET',
              headers: this.headers(token),
              signal: AbortSignal.timeout(30_000),
            }
          : {
              method: init.method ?? 'GET',
              headers: { ...this.headers(token), 'Content-Type': 'application/json' },
              body: JSON.stringify(init.body),
              signal: AbortSignal.timeout(30_000),
            },
      )
    } catch {
      // 刻意不透传错误对象:其信息可能包含完整 URL(含 query),虽无 token 也避免噪音
      return err(makeError('HARNESS_UNAVAILABLE', `GitHub API 请求失败:${path}`))
    }

    const limited =
      res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))
    if ((res.status === 401 || res.status === 403) && !limited) {
      return err(makeError('AUTH_FAILED', `GitHub 认证失败(HTTP ${res.status})`))
    }
    if (res.status === 404) {
      return err(makeError('NOT_FOUND', `GitHub 资源不存在:${path}`))
    }
    if (limited || res.status >= 500 || res.status === 429) {
      return err(makeError('HARNESS_UNAVAILABLE', `GitHub API 暂不可用(HTTP ${res.status})`))
    }

    let text: string
    try {
      text = await res.text()
    } catch {
      return err(makeError('HARNESS_UNAVAILABLE', 'GitHub API 响应读取失败'))
    }
    try {
      const json: unknown = text === '' ? null : JSON.parse(text)
      return ok({
        status: res.status,
        json,
        hasNextPage: /;\s*rel="next"/.test(res.headers.get('link') ?? ''),
      })
    } catch {
      return err(makeError('PROTOCOL_ERROR', 'GitHub API 响应不是 JSON'))
    }
  }

  async readJson(host: string, path: string): Promise<Result<{ status: number; json: unknown }>> {
    const response = await this.request(host, path)
    return response.ok ? ok({ status: response.value.status, json: response.value.json }) : response
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
   * 读取 PR 当前状态 —— 只读外部事实，不推断合并结果。
   *
   * GitHub 的 `merged` 是布尔事实；`merged_at` / `merge_commit_sha`
   * 原样返回，缺失时给 null，不在本地补时间或 SHA。
   */
  async getPullRequest(input: PullRequestStateInput): Promise<Result<PullRequestState>> {
    if (!Number.isSafeInteger(input.number) || input.number <= 0) {
      return err(makeError('SCHEMA_VIOLATION', `PR 编号无效：${input.number}`))
    }
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`

    const r = await this.request(host, `/repos/${slug}/pulls/${input.number}`)
    if (!r.ok) return r
    if (r.value.status !== 200) {
      return err(
        makeError(
          'WORKSPACE_ERROR',
          `读取 PR #${input.number} 返回非预期状态 HTTP ${r.value.status}`,
        ),
      )
    }

    const pr = r.value.json as RawPullRequest | null
    if (pr === null || typeof pr !== 'object' || pr.number !== input.number) {
      return err(makeError('PROTOCOL_ERROR', `GitHub 返回的 PR 响应缺少准确编号 #${input.number}`))
    }
    const state = isOpenState(pr.state)
    if (state === null) {
      return err(
        makeError('PROTOCOL_ERROR', `PR #${input.number} 的 state 非法：${String(pr.state)}`),
      )
    }
    if (pr.merged === true && state !== 'closed') {
      return err(
        makeError('PROTOCOL_ERROR', `PR #${input.number} 声称已合并但 state=${String(pr.state)}`),
      )
    }
    if (typeof pr.merged !== 'boolean') {
      return err(makeError('PROTOCOL_ERROR', `PR #${input.number} 缺少 merged 事实`))
    }

    return ok({
      number: pr.number,
      url: pr.html_url ?? `https://${host}/${slug}/pull/${input.number}`,
      state,
      merged: pr.merged === true,
      mergedAt: pr.merged_at ?? null,
      mergeSha: pr.merge_commit_sha ?? null,
      closedAt: pr.closed_at ?? null,
      headSha: pr.head?.sha ?? null,
    })
  }

  async waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>> {
    const deadline = Date.now() + this.pollTimeoutMs
    let unreportedSince: number | undefined
    let interval = this.pollIntervalMs
    for (;;) {
      const observation = await this.observeCi(input)
      const now = Date.now()
      if (observation.ok) {
        const { state } = observation.value
        if (state === 'passed' || state === 'failed') return ok(state)
        unreportedSince = state === 'unreported' ? (unreportedSince ?? now) : undefined
        if (
          input.allowUnreported === true &&
          unreportedSince !== undefined &&
          now - unreportedSince >= this.emptySettleMs
        )
          return ok('passed')
      } else {
        if (!isTransientCiObservation(observation.error)) return observation
        unreportedSince = undefined
      }
      if (now >= deadline)
        return err(
          makeError(
            'RUN_TIMEOUT',
            'CI 观测截止时尚无可信终态',
            observation.ok ? undefined : observation.error,
          ),
        )
      await sleep(Math.min(interval, deadline - now))
      interval = Math.min(interval * 2, this.pollIntervalMs * 4)
    }
  }

  async observeCi(input: CiWaitInput): Promise<Result<CiObservation>> {
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`
    if (!validHeadSha(input.headSha)) return err(makeError('PROTOCOL_ERROR', 'CI head SHA 无效'))

    if (input.prNumber !== undefined) {
      const before = await this.boundCiPullRequest(input, input.prNumber)
      if (!before.ok) return before
    }
    const snapshot = await this.commitCheckSnapshot(host, slug, input.headSha)
    if (!snapshot.ok) return snapshot
    if (input.prNumber !== undefined) {
      const after = await this.boundCiPullRequest(input, input.prNumber)
      if (!after.ok) return after
    }
    const { checks, statuses, workflows } = snapshot.value
    if (
      checks.some((run) => checkConclusion(run) === 'pending') ||
      statuses.some(({ state }) => state === 'pending')
    )
      return ok({ state: 'pending' })

    const failedChecks = checks.filter(
      (check) => !['success', 'skipped', 'neutral'].includes(checkConclusion(check)),
    )
    const failedStatuses = statuses.filter(({ state }) => state === 'failure' || state === 'error')
    if (failedChecks.length === 0 && failedStatuses.length === 0) {
      const reported = checks.length > 0 || statuses.length > 0
      return ok({ state: reported ? 'passed' : 'unreported' })
    }

    // 仅当所有失败检查都落在同一个 Actions suite 时，才对该轮次请求重跑。
    const suiteId = failedChecks[0]?.check_suite?.id
    const workflow =
      failedStatuses.length === 0 &&
      suiteId !== undefined &&
      failedChecks.every((check) => check.check_suite?.id === suiteId)
        ? workflows.get(suiteId)
        : undefined
    const safe = (value: string) =>
      redactSecrets(value, gitAuthSecrets(this.tokenCache.get(host) ?? this.explicitToken?.value))
        .replaceAll(String.fromCharCode(0), '')
        .replace(/\s+/g, ' ')
        .slice(0, 160)
    const jobs =
      workflow === undefined ? [] : await this.failedActionsJobs(host, slug, workflow, safe)
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          checks: failedChecks.map(({ id, conclusion }) => `${id}:${conclusion}`).sort(),
          statuses: failedStatuses
            .map(({ id, context, state }) => `${id}:${context}:${state}`)
            .sort(),
          ...(workflow === undefined ? {} : { run: workflow.id, attempt: workflow.run_attempt }),
        }),
      )
      .digest('hex')
    return ok({
      state: 'failed',
      evidence: {
        key,
        checks: [
          ...failedChecks.map(({ name, conclusion, output }) => ({
            name: safe(name),
            conclusion: safe(conclusion ?? ''),
            ...(typeof output?.title === 'string' ? { summary: safe(output.title) } : {}),
          })),
          ...failedStatuses.map(({ context, state }) => ({
            name: safe(context),
            conclusion: state ?? '',
          })),
        ].slice(0, 12),
        jobs,
        url: `https://${host}/${slug}/${
          workflow === undefined
            ? `commit/${input.headSha}/checks`
            : `actions/runs/${workflow.id}/attempts/${workflow.run_attempt}`
        }`,
      },
      ...(workflow?.run_attempt === 1 ? { rerun: { runId: workflow.id, attempt: 1 } } : {}),
    })
  }

  private async boundCiPullRequest(input: CiWaitInput, number: number): Promise<Result<void>> {
    const pr = await this.getPullRequest({
      repoId: input.repoId,
      remoteUrl: input.remoteUrl,
      number,
    })
    if (!pr.ok) return pr
    if (pr.value.number !== number) return err(makeError('PROTOCOL_ERROR', 'PR 编号与 CI 目标不符'))
    if (pr.value.state !== 'open' || pr.value.merged || pr.value.headSha !== input.headSha)
      return err(makeError('CONFLICT', 'PR 状态或 head SHA 已变化'))
    return ok(undefined)
  }

  private async failedActionsJobs(
    host: string,
    slug: string,
    run: RawActionsRun,
    safe: (value: string) => string,
  ): Promise<CiFailureEvidence['jobs']> {
    const response = await this.request(
      host,
      `/repos/${slug}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    )
    if (!response.ok || response.value.status !== 200) return []
    const raw = response.value.json as {
      jobs?: {
        name: string
        conclusion: string
        steps?: { name: string; conclusion: string }[]
      }[]
    } | null
    if (!Array.isArray(raw?.jobs)) return []
    return raw.jobs
      .filter((job) => job?.conclusion === 'failure' && typeof job.name === 'string')
      .slice(0, 8)
      .map((job) => ({
        name: safe(job.name),
        failedSteps: Array.isArray(job.steps)
          ? job.steps
              .filter((step) => step?.conclusion === 'failure' && typeof step.name === 'string')
              .slice(0, 5)
              .map((step) => safe(step.name))
          : [],
      }))
  }

  async rerunFailedCi(input: CiWaitInput, target: CiRerunTarget): Promise<Result<boolean>> {
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    if (!Number.isSafeInteger(target.runId) || target.runId <= 0 || target.attempt !== 1)
      return ok(false)
    const { host, owner, repo } = parsed.value
    const path = `/repos/${owner}/${repo}/actions/runs/${target.runId}`
    const latest = await this.request(host, path)
    if (!latest.ok) return latest
    const run = latest.value.json as RawActionsRun | null
    if (latest.value.status !== 200 || run === null || run.id !== target.runId) return ok(false)
    if (Number.isSafeInteger(run.run_attempt) && run.run_attempt > target.attempt)
      return err(makeError('STALE_EVIDENCE', 'Actions 检查已进入新轮次'))
    if (run.run_attempt !== target.attempt || !actionsRunMatches(run, input.headSha))
      return ok(false)
    if (input.prNumber === undefined) return ok(false)
    const pr = await this.getPullRequest({
      repoId: input.repoId,
      remoteUrl: input.remoteUrl,
      number: input.prNumber,
    })
    if (!pr.ok) return pr
    if (pr.value.state !== 'open' || pr.value.merged || pr.value.headSha !== input.headSha)
      return err(makeError('CONFLICT', 'PR 状态或 head SHA 已变化'))
    const result = await this.request(host, `${path}/rerun-failed-jobs`, { method: 'POST' })
    return result.ok ? ok(result.value.status === 201) : result
  }

  private async pullRequestObservation(
    host: string,
    slug: string,
    prNumber: number,
  ): Promise<Result<PullRequestObservation>> {
    const response = await this.request(host, `/repos/${slug}/pulls/${prNumber}`)
    if (!response.ok) return response
    if (response.value.status !== 200)
      return err(
        makeError('WORKSPACE_ERROR', `读取 PR 返回非预期状态 HTTP ${response.value.status}`),
      )
    const raw = response.value.json as RawPullRequest | null
    if (raw === null || typeof raw !== 'object' || raw.number !== prNumber)
      return err(makeError('PROTOCOL_ERROR', `PR ${prNumber} 响应缺少准确编号`))
    const state = isOpenState(raw.state)
    if (state === null) return err(makeError('PROTOCOL_ERROR', `PR ${prNumber} 状态无效`))
    if (typeof raw.head?.ref !== 'string' || raw.head.ref.trim() === '')
      return err(makeError('PROTOCOL_ERROR', `PR ${prNumber} 缺少 head branch`))
    if (typeof raw.base?.ref !== 'string' || raw.base.ref.trim() === '')
      return err(makeError('PROTOCOL_ERROR', `PR ${prNumber} 缺少 base branch`))
    if (!validHeadSha(raw.head.sha))
      return err(makeError('PROTOCOL_ERROR', `PR ${prNumber} 缺少完整 head SHA`))
    const url =
      typeof raw.html_url === 'string' && raw.html_url.trim() !== ''
        ? raw.html_url
        : `https://${host}/${slug}/pull/${prNumber}`
    return ok({
      number: raw.number,
      url,
      state,
      headBranch: raw.head.ref,
      baseBranch: raw.base.ref,
      headSha: raw.head.sha,
    })
  }

  private async ciPages(
    host: string,
    path: string,
    field: 'check_runs' | 'statuses' | 'workflow_runs' | 'jobs',
    expectedSha?: string,
  ): Promise<Result<readonly unknown[]>> {
    const entries: unknown[] = []
    let total: number | undefined
    const separator = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= CI_MAX_PAGES; page++) {
      const response = await this.request(
        host,
        `${path}${separator}per_page=${CI_PAGE_SIZE}&page=${page}`,
      )
      if (!response.ok) return response
      if (response.value.status !== 200)
        return err(makeError('PROTOCOL_ERROR', `${field} 返回 HTTP ${response.value.status}`))
      const raw = response.value.json as Record<string, unknown> | null
      const batch = raw?.[field]
      const count = raw?.total_count
      if (!Array.isArray(batch) || (count !== 0 && !positiveId(count)))
        return err(makeError('PROTOCOL_ERROR', `${field} 响应缺少列表或有效总数`))
      if (batch.length > CI_PAGE_SIZE)
        return err(makeError('PROTOCOL_ERROR', `${field} 超过单页大小`))
      if (count >= CI_PAGE_SIZE * CI_MAX_PAGES)
        return err(makeError('CONFLICT', `${field} 触及分页上限`))
      if (expectedSha !== undefined) {
        if (typeof raw?.sha !== 'string' || !validHeadSha(raw.sha))
          return err(makeError('PROTOCOL_ERROR', `${field} 响应缺少有效 SHA`))
        if (raw.sha !== expectedSha) return err(makeError('CONFLICT', `${field} 响应属于其他 SHA`))
      }
      total ??= count
      entries.push(...batch)
      if (count === total && entries.length === total && !response.value.hasNextPage)
        return ok(entries)
      if (
        count !== total ||
        batch.length === 0 ||
        entries.length >= total ||
        (!response.value.hasNextPage && batch.length < CI_PAGE_SIZE)
      )
        break
    }
    return err(makeError('CONFLICT', `${field} 分页截断或观测期间发生变化`))
  }

  private async actionsForChecks(
    host: string,
    slug: string,
    sha: string,
    checks: readonly RawCheckRun[],
  ): Promise<Result<ReadonlyMap<number, RawActionsRun>>> {
    const suites = new Map<number, RawCheckRun[]>()
    for (const check of checks) {
      if (check.app?.slug !== 'github-actions') continue
      const suite = check.check_suite?.id
      if (!positiveId(suite))
        return err(makeError('PROTOCOL_ERROR', 'Actions 检查缺少有效 check suite'))
      const existing = suites.get(suite) ?? []
      existing.push(check)
      suites.set(suite, existing)
    }
    const current = new Map<number, RawActionsRun>()
    if (suites.size === 0) return ok(current)
    const runsBase = `/repos/${slug}/actions/runs`
    const runs = await this.ciPages(host, `${runsBase}?head_sha=${sha}`, 'workflow_runs')
    if (!runs.ok) return runs
    const workflows = runs.value as RawActionsRun[]
    for (const [suite, suiteChecks] of suites) {
      const candidates = workflows.filter((workflow) => workflow?.check_suite_id === suite)
      if (candidates.length !== 1)
        return err(makeError('CONFLICT', 'Actions check suite 未能绑定唯一工作流'))
      const workflow = candidates[0]
      if (
        !workflow ||
        !positiveId(workflow.id) ||
        !positiveId(workflow.run_attempt) ||
        !validHeadSha(workflow.head_sha)
      )
        return err(makeError('PROTOCOL_ERROR', 'Actions 响应缺少有效工作流轮次'))
      if (workflow.head_sha !== sha) return err(makeError('CONFLICT', 'Actions 工作流属于其他 SHA'))
      if (suiteChecks.every((check) => check.status !== 'completed')) continue
      const jobs = await this.ciPages(host, `${runsBase}/${workflow.id}/jobs?filter=latest`, 'jobs')
      if (!jobs.ok) return jobs
      const latest = jobs.value as RawActionsJob[]
      for (const check of suiteChecks) {
        const matches = latest.filter((job) => job?.name === check.name)
        const job = matches[0]
        if (job !== undefined && !validHeadSha(job.head_sha))
          return err(makeError('PROTOCOL_ERROR', 'Actions job 缺少有效 SHA'))
        if (
          matches.length !== 1 ||
          typeof job?.check_run_url !== 'string' ||
          !job.check_run_url.endsWith(`/check-runs/${check.id}`) ||
          job.head_sha !== sha ||
          job.status !== check.status ||
          job.conclusion !== check.conclusion
        )
          return err(makeError('CONFLICT', 'Actions 检查与当前轮次的 job 不一致'))
      }
      const reread = await this.request(host, `${runsBase}/${workflow.id}`)
      if (!reread.ok) return reread
      const verified = reread.value.json as RawActionsRun | null
      if (
        reread.value.status !== 200 ||
        verified?.id !== workflow.id ||
        verified.check_suite_id !== suite ||
        verified.head_sha !== sha ||
        verified.run_attempt !== workflow.run_attempt ||
        verified.status !== workflow.status ||
        verified.conclusion !== workflow.conclusion ||
        verified.status !== 'completed'
      )
        return err(makeError('CONFLICT', 'Actions 轮次尚未完成或在观测期间发生变化'))
      if (actionsRunMatches(verified, sha)) current.set(suite, verified)
    }
    return ok(current)
  }

  private async commitCheckSnapshot(
    host: string,
    slug: string,
    sha: string,
    required?: ReadonlySet<string>,
  ): Promise<Result<CommitCheckSnapshot>> {
    const commit = `/repos/${slug}/commits/${sha}`
    const [checks, statuses] = await Promise.all([
      this.ciPages(host, `${commit}/check-runs?filter=all`, 'check_runs'),
      this.ciPages(host, `${commit}/status`, 'statuses', sha),
    ])
    if (!checks.ok && !isTransientCiObservation(checks.error)) return checks
    if (!statuses.ok && !isTransientCiObservation(statuses.error)) return statuses
    if (!checks.ok) return checks
    if (!statuses.ok) return statuses

    const latestChecks = new Map<string, RawCheckRun>()
    const checkIds = new Set<number>()
    for (const check of checks.value as RawCheckRun[]) {
      if (
        !check ||
        !positiveId(check.id) ||
        typeof check.name !== 'string' ||
        check.name.trim() === '' ||
        !validHeadSha(check.head_sha) ||
        !CHECK_STATUSES.includes(check.status) ||
        (check.status === 'completed' &&
          (check.conclusion === null || !CHECK_CONCLUSIONS.includes(check.conclusion)))
      )
        return err(makeError('PROTOCOL_ERROR', 'check-run 缺少有效身份、SHA 或结论'))
      if (check.head_sha !== sha) return err(makeError('CONFLICT', 'check-run 属于其他 SHA'))
      if (checkIds.has(check.id)) return err(makeError('CONFLICT', 'check-run 分页返回重复标识'))
      checkIds.add(check.id)
      if (required !== undefined && !required.has(check.name)) continue
      const previous = latestChecks.get(check.name)
      if (
        previous !== undefined &&
        (!positiveId(check.check_suite?.id) ||
          !positiveId(check.app?.id) ||
          previous.check_suite?.id !== check.check_suite?.id ||
          previous.app?.id !== check.app?.id)
      )
        return err(makeError('CONFLICT', '同名 check-run 来自不同或未知来源'))
      if (previous === undefined || previous.id < check.id) latestChecks.set(check.name, check)
    }

    const currentStatuses = new Map<string, RawCommitStatus>()
    const statusIds = new Set<number>()
    for (const status of statuses.value as RawCommitStatus[]) {
      if (
        !status ||
        !positiveId(status.id) ||
        typeof status.context !== 'string' ||
        status.context.trim() === '' ||
        !['success', 'error', 'failure', 'pending'].includes(status.state)
      )
        return err(makeError('PROTOCOL_ERROR', 'commit status 缺少有效身份或状态'))
      if (statusIds.has(status.id) || currentStatuses.has(status.context))
        return err(makeError('CONFLICT', 'combined status 分页返回重复标识或上下文'))
      statusIds.add(status.id)
      currentStatuses.set(status.context, status)
      if (required !== undefined && !required.has(status.context)) continue
      const check = latestChecks.get(status.context)
      if (check !== undefined && verdict(checkConclusion(check)) !== verdict(status.state))
        return err(makeError('CONFLICT', '同名 check-run 和 commit status 的结论不一致'))
    }
    const currentChecks = [...latestChecks.values()]
    if (currentChecks.some(({ conclusion }) => conclusion === 'stale'))
      return err(makeError('CONFLICT', 'check-run 已过期'))
    const workflows = await this.actionsForChecks(host, slug, sha, currentChecks)
    if (!workflows.ok) return workflows
    return ok({
      checks: currentChecks,
      statuses: [...currentStatuses.values()].filter(
        ({ context }) => required?.has(context) ?? true,
      ),
      workflows: workflows.value,
    })
  }

  async observeRequiredChecks(
    input: RequiredCheckObservationInput,
  ): Promise<Result<RequiredCheckSnapshot>> {
    const parsed = parseRemoteUrl(input.remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const slug = `${owner}/${repo}`
    if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0)
      return err(makeError('SCHEMA_VIOLATION', `PR 编号无效：${input.prNumber}`))

    const before = await this.pullRequestObservation(host, slug, input.prNumber)
    if (!before.ok) return before
    if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== before.value.headSha)
      return err(makeError('CONFLICT', 'PR head 与 required checks 的目标 SHA 不一致'))

    const facts: RequiredCheckFact[] = []
    const required = new Set(input.requiredChecks)
    if (required.size > 0) {
      const snapshot = await this.commitCheckSnapshot(host, slug, before.value.headSha, required)
      if (!snapshot.ok) return snapshot
      for (const check of snapshot.value.checks) {
        facts.push({
          name: check.name,
          source: 'check_run',
          conclusion: checkConclusion(check),
          externalId: String(check.id),
          detailsUrl: check.details_url ?? null,
        })
      }
      for (const status of snapshot.value.statuses) {
        facts.push({
          name: status.context,
          source: 'commit_status',
          conclusion: status.state,
          externalId: String(status.id),
          detailsUrl: status.target_url ?? null,
        })
      }
    }

    const after = await this.pullRequestObservation(host, slug, input.prNumber)
    if (!after.ok) return after
    if (
      after.value.headSha !== before.value.headSha ||
      after.value.headBranch !== before.value.headBranch ||
      after.value.baseBranch !== before.value.baseBranch ||
      after.value.state !== before.value.state
    )
      return err(makeError('CONFLICT', 'PR 在观测期间发生变化；本次 check 证据作废'))

    return ok({
      repoId: input.repoId,
      repo: slug,
      remoteUrl: input.remoteUrl,
      prNumber: before.value.number,
      prUrl: before.value.url,
      prState: before.value.state,
      headBranch: before.value.headBranch,
      baseBranch: before.value.baseBranch,
      headSha: before.value.headSha,
      observedAt: input.observedAt,
      checks: facts,
    })
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

  async issueActor(remoteUrl: string): Promise<Result<string>> {
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const response = await this.request(parsed.value.host, '/user')
    if (!response.ok) return response
    const login = (response.value.json as { login?: unknown } | null)?.login
    return response.value.status === 200 && typeof login === 'string'
      ? ok(login)
      : err(makeError('PROTOCOL_ERROR', 'GitHub 用户响应缺少 login'))
  }

  async listIssueComments(
    remoteUrl: string,
    number: number,
    since?: string,
  ): Promise<Result<IssueCommentPage>> {
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const comments: IssueComment[] = []
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ per_page: '100', page: String(page) })
      if (since !== undefined) query.set('since', since)
      const response = await this.request(
        host,
        `/repos/${owner}/${repo}/issues/${number}/comments?${query}`,
      )
      if (!response.ok) return response
      if (response.value.status !== 200 || !Array.isArray(response.value.json)) {
        return err(makeError('PROTOCOL_ERROR', 'GitHub 评论列表响应无效'))
      }
      for (const raw of response.value.json) {
        const comment = parseIssueComment(raw)
        if (comment === null) return err(makeError('PROTOCOL_ERROR', 'GitHub 评论缺少必需字段'))
        comments.push(comment)
      }
      if (response.value.json.length < 100) return ok({ comments, truncated: false })
    }
    return ok({ comments, truncated: true })
  }

  async createIssueComment(
    remoteUrl: string,
    number: number,
    body: string,
  ): Promise<Result<IssueComment>> {
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const response = await this.request(host, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    })
    if (!response.ok) return response
    const comment = parseIssueComment(response.value.json)
    return response.value.status === 201 && comment !== null
      ? ok(comment)
      : err(makeError('PROTOCOL_ERROR', `创建评论响应无效（HTTP ${response.value.status}）`))
  }

  async closeIssue(
    remoteUrl: string,
    number: number,
    reason: 'completed' | 'not_planned',
  ): Promise<Result<void>> {
    const parsed = parseRemoteUrl(remoteUrl)
    if (!parsed.ok) return parsed
    const { host, owner, repo } = parsed.value
    const response = await this.request(host, `/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: { state: 'closed', state_reason: reason },
    })
    if (!response.ok) return response
    return response.value.status === 200
      ? ok(undefined)
      : err(makeError('PROTOCOL_ERROR', `关闭 Issue 返回 HTTP ${response.value.status}`))
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
      closed_at?: string | null
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
      closedAt: typeof raw.closed_at === 'string' ? raw.closed_at : null,
      isPullRequest: raw.pull_request !== undefined,
    })
  }
}

function parseIssueComment(raw: unknown): IssueComment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as {
    id?: unknown
    body?: unknown
    created_at?: unknown
    user?: { login?: unknown }
  }
  return typeof item.id === 'number' &&
    Number.isSafeInteger(item.id) &&
    typeof item.body === 'string' &&
    typeof item.created_at === 'string' &&
    typeof item.user?.login === 'string'
    ? { id: item.id, body: item.body, author: item.user.login, createdAt: item.created_at }
    : null
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
