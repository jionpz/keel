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

const API_ROOT = 'https://api.github.com'

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

export function readTokenFromEnv(): string | undefined {
  return process.env.KEEL_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
}

/**
 * 从远程 URL 解析 owner/repo（`owner/repo`）。
 *
 * 支持 https://github.com/owner/repo(.git) 与 git@github.com:owner/repo.git。
 * 验收测试的 cleanup 也用它 —— 单一事实源,不写第二份正则(#1-11)。
 */
export function ownerRepo(remoteUrl: string): Result<string> {
  // 支持 https://github.com/owner/repo(.git) 与 git@github.com:owner/repo.git
  const m = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m === null || m[1] === undefined || m[2] === undefined) {
    return err(makeError('WORKSPACE_ERROR', `无法从 remote URL 解析 owner/repo:${remoteUrl}`))
  }
  return ok(`${m[1]}/${m[2]}`)
}

export interface IssueInfo {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly labels: readonly string[]
  readonly state: 'open' | 'closed'
  readonly isPullRequest: boolean
}

export interface ParsedIssueUrl {
  readonly remoteUrl: string
  readonly number: number
}

/** 从 GitHub Issue URL 解析 remoteUrl 与 issue 编号 */
export function parseIssueUrl(url: string): Result<ParsedIssueUrl> {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/)
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    return err(makeError('WORKSPACE_ERROR', `无法解析 Issue URL:${url}`))
  }
  const remoteUrl = `https://github.com/${m[1]}/${m[2]}.git`
  return ok({ remoteUrl, number: Number(m[3]) })
}

export class GitHubProvider implements PullRequestGateway, CiGateway {
  private readonly root: string
  private readonly token: string | undefined

  constructor(opts: GitHubProviderOptions = {}) {
    this.root = opts.apiRoot ?? API_ROOT
    this.token = opts.token === undefined ? readTokenFromEnv() : (opts.token ?? undefined)
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS
    this.emptySettleMs = opts.emptySettleMs ?? EMPTY_SETTLE_MS
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
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Result<{ status: number; json: unknown }>> {
    if (this.token === undefined) {
      return err(makeError('AUTH_FAILED', '缺少 GitHub token(KEEL_GITHUB_TOKEN / GITHUB_TOKEN)'))
    }
    let res: Response
    try {
      res = await fetch(
        `${this.root}${path}`,
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
    slug: string,
    headBranch: string,
  ): Promise<Result<PullRequestInfo | null>> {
    const owner = slug.split('/')[0] ?? slug
    const r = await this.request(
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
    const slug = ownerRepo(input.remoteUrl)
    if (!slug.ok) return slug

    const existing = await this.findExistingPr(slug.value, input.headBranch)
    if (!existing.ok) return existing
    if (existing.value !== null) return ok(existing.value)

    const created = await this.request(`/repos/${slug.value}/pulls`, {
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
    const slug = ownerRepo(input.remoteUrl)
    if (!slug.ok) return slug

    const start = Date.now()
    const deadline = start + this.pollTimeoutMs
    for (;;) {
      const combined = await this.combinedStatus(slug.value, input.headSha)
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
    slug: string,
    sha: string,
  ): Promise<Result<'passed' | 'failed' | 'pending' | 'unreported'>> {
    const checks = await this.request(`/repos/${slug}/commits/${sha}/check-runs`)
    if (!checks.ok) return checks
    const statuses = await this.request(`/repos/${slug}/commits/${sha}/status`)
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

  async getIssue(remoteUrl: string, issueNumber: number): Promise<Result<IssueInfo>> {
    const slug = ownerRepo(remoteUrl)
    if (!slug.ok) return slug

    const r = await this.request(`/repos/${slug.value}/issues/${issueNumber}`)
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
      return err(makeError('PROTOCOL_ERROR', `Issue 响应缺少 number/title:${slug.value}`))
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
