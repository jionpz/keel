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

export interface GitHubProviderOptions {
  /** 覆盖 API 根地址 —— 测试用 stub server 注入 */
  readonly apiRoot?: string
  /** 显式 token。未传时读环境变量;传 `null` 强制无 token(测试缺凭据路径) */
  readonly token?: string | null
  /** 覆盖轮询间隔/上限 —— 测试用毫秒级 */
  readonly pollIntervalMs?: number
  readonly pollTimeoutMs?: number
}

export function readTokenFromEnv(): string | undefined {
  return process.env.KEEL_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
}

function ownerRepo(remoteUrl: string): Result<string> {
  // 支持 https://github.com/owner/repo(.git) 与 git@github.com:owner/repo.git
  const m = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m === null || m[1] === undefined || m[2] === undefined) {
    return err(makeError('WORKSPACE_ERROR', `无法从 remote URL 解析 owner/repo:${remoteUrl}`))
  }
  return ok(`${m[1]}/${m[2]}`)
}

export class GitHubProvider implements PullRequestGateway, CiGateway {
  private readonly root: string
  private readonly token: string | undefined

  constructor(opts: GitHubProviderOptions = {}) {
    this.root = opts.apiRoot ?? API_ROOT
    this.token = opts.token === undefined ? readTokenFromEnv() : (opts.token ?? undefined)
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS
  }

  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

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

  async waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>> {
    const slug = ownerRepo(input.remoteUrl)
    if (!slug.ok) return slug

    const deadline = Date.now() + this.pollTimeoutMs
    for (;;) {
      const combined = await this.combinedStatus(slug.value, input.headSha)
      if (!combined.ok) return combined

      if (combined.value !== 'pending') return ok(combined.value)

      if (Date.now() > deadline) {
        // 硬超时按失败处理 —— 由编排器转成 CIFailed(T-025),人可介入
        return ok('failed')
      }
      await sleep(this.pollIntervalMs)
    }
  }

  /**
   * 合并 Checks 与 Commit Status 为三态:
   *   任一 failed → failed;全部 success → passed;否则 pending。
   *
   * CI 是外部事实源,这里只读取并归并,**绝不制造结论**。
   */
  private async combinedStatus(
    slug: string,
    sha: string,
  ): Promise<Result<'passed' | 'failed' | 'pending'>> {
    const checks = await this.request(`/repos/${slug}/commits/${sha}/check-runs`)
    if (!checks.ok) return checks
    const statuses = await this.request(`/repos/${slug}/commits/${sha}/status`)
    if (!statuses.ok) return statuses

    const cj = checks.value.json as {
      total_count: number
      check_runs: { status: string; conclusion: string | null }[]
    } | null
    if (cj !== null && Array.isArray(cj.check_runs)) {
      for (const run of cj.check_runs) {
        if (
          run.status === 'completed' &&
          run.conclusion !== 'success' &&
          run.conclusion !== 'skipped'
        ) {
          return ok('failed')
        }
        if (run.status !== 'completed') return ok('pending')
      }
    }
    const sj = statuses.value.json as {
      state: 'success' | 'failure' | 'error' | 'pending' | null
    } | null
    if (sj !== null && sj.state !== null) {
      if (sj.state === 'failure' || sj.state === 'error') return ok('failed')
      if (sj.state === 'pending') return ok('pending')
    }

    // 无任何 check/status:视为通过 —— 没有配置 CI 的仓库不该永远卡死
    return ok('passed')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
