/**
 * GitHubProvider 单测 —— stub HTTP server 模拟 GitHub API。
 *
 * 不打真实 api.github.com:单测必须确定、离线、快。
 * 真实路径由 test:acceptance 在提供远程仓库与凭据后验证(诚实边界,见实现文件头)。
 *
 * 覆盖 design.md §6 的单元层:
 *   - PR 幂等(先查后建 / 复用已有)
 *   - 非 ai/* 分支拒绝
 *   - 错误映射 401/403/404/429/5xx
 *   - CI 四态归并、无人上报静默期与硬超时
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiRootForHost,
  GitHubProvider,
  isGitHubHost,
  issueUrlFor,
  ownerRepo,
  parseIssueUrl,
  parseRemoteUrl,
} from './github-provider.js'

let server: Server
let baseUrl: string

/** 每个用例自己注册路由;未命中路由返回 500 以暴露测试缺口 */
type Handler = (
  req: { method: string; url: string; headers: IncomingHttpHeaders },
  body: unknown,
) => {
  status: number
  json: unknown
}

const routes = new Map<string, Handler>()

function routeKey(method: string, urlPrefix: string): string {
  return `${method} ${urlPrefix}`
}

beforeEach(async () => {
  routes.clear()
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: unknown = raw === '' ? undefined : JSON.parse(raw)
      const handler =
        [...routes.entries()].find(([key]) => {
          const [method, prefix] = key.split(' ', 2)
          return req.method === method && (req.url ?? '').startsWith(prefix ?? '\u0000')
        })?.[1] ?? null
      const out = handler?.(
        {
          method: req.method ?? 'GET',
          url: req.url ?? '',
          headers: req.headers,
        },
        body,
      ) ?? {
        status: 500,
        json: { message: `no route for ${req.method} ${req.url}` },
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const REMOTE = 'https://github.com/acme/widget.git'

function provider(opts: ConstructorParameters<typeof GitHubProvider>[0] = {}): GitHubProvider {
  return new GitHubProvider({ apiRoot: baseUrl, token: 'test-token', ...opts })
}

describe('createPullRequest 幂等', () => {
  it('无已有 PR → 创建,created=true,payload 只含标题与分支', async () => {
    let createBody: unknown
    routes.set(routeKey('GET', '/repos/acme/widget/pulls'), () => ({ status: 200, json: [] }))
    routes.set(routeKey('POST', '/repos/acme/widget/pulls'), (_req, body) => {
      createBody = body
      return { status: 201, json: { number: 7, html_url: `${REMOTE}/pull/7` } }
    })

    const r = await provider().createPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      baseBranch: 'main',
      headBranch: 'ai/task-abc',
      title: 't',
      body: 'b',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ number: 7, url: `${REMOTE}/pull/7`, created: true })
    expect(createBody).toEqual({ title: 't', body: 'b', head: 'ai/task-abc', base: 'main' })
  })

  it('已有 open PR → 复用,不发起创建,created=false', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/pulls'), () => ({
      status: 200,
      json: [{ number: 3, html_url: `${REMOTE}/pull/3` }],
    }))
    const post = vi.fn()
    routes.set(routeKey('POST', '/repos/acme/widget/pulls'), () => {
      post()
      return { status: 201, json: {} }
    })

    const r = await provider().createPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      baseBranch: 'main',
      headBranch: 'ai/task-abc',
      title: 't',
      body: 'b',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.created).toBe(false)
    expect(r.value.number).toBe(3)
    expect(post).not.toHaveBeenCalled()
  })

  it('非 ai/* 分支直接拒绝 —— PERMISSION_DENIED,不发任何请求', async () => {
    const r = await provider().createPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      baseBranch: 'main',
      headBranch: 'main',
      title: 't',
      body: 'b',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('PERMISSION_DENIED')
  })

  it('无法解析的 remote URL 报 WORKSPACE_ERROR', async () => {
    const r = await provider().createPullRequest({
      repoId: 'r1',
      remoteUrl: 'https://gitlab.com/x/y.git',
      baseBranch: 'main',
      headBranch: 'ai/task-abc',
      title: 't',
      body: 'b',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })
})

describe('错误映射(design.md §7)', () => {
  for (const [status, kind] of [
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [429, 'HARNESS_UNAVAILABLE'],
    [502, 'HARNESS_UNAVAILABLE'],
  ] as const) {
    it(`HTTP ${status} → ${kind}`, async () => {
      routes.set(routeKey('GET', '/repos/acme/widget/pulls'), () => ({ status, json: {} }))
      const r = await provider().createPullRequest({
        repoId: 'r1',
        remoteUrl: REMOTE,
        baseBranch: 'main',
        headBranch: 'ai/task-abc',
        title: 't',
        body: 'b',
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error.kind).toBe(kind)
      // retryable 来自注册表:AUTH/NOT_FOUND 不可重试,HARNESS_UNAVAILABLE 可重试
      expect(r.error.retryable).toBe(kind === 'HARNESS_UNAVAILABLE')
    })
  }
  it('缺 token 时 AUTH_FAILED,不发请求 —— 凭据纪律', async () => {
    const p = new GitHubProvider({ apiRoot: baseUrl, token: null })
    const r = await p.createPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      baseBranch: 'main',
      headBranch: 'ai/task-abc',
      title: 't',
      body: 'b',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    // 文案给出三来源与修复命令，且不含任何 token 形态
    expect(r.error.detail).toContain('KEEL_GITHUB_TOKEN')
    expect(r.error.detail).toContain('GITHUB_TOKEN')
    expect(r.error.detail).toContain('gh auth login')
    expect(r.error.detail).not.toContain('Bearer')
  })
})

// ───────────────────── token 来源优先级（issue #73 第 3 项）─────────────────────

describe('token 解析（按 host）', () => {
  function issueJson(n: number): unknown {
    return { number: n, title: `issue ${n}`, body: '', labels: [], state: 'open' }
  }

  it('未显式给 token → 按 host 调 resolver；同一 host 只解析一次（缓存）', async () => {
    const hosts: string[] = []
    const authHeaders: (string | undefined)[] = []
    routes.set(routeKey('GET', '/repos/acme/widget/issues/5'), (req) => {
      authHeaders.push(req.headers.authorization)
      return { status: 200, json: issueJson(5) }
    })
    routes.set(routeKey('GET', '/repos/acme/widget/issues/6'), (req) => {
      authHeaders.push(req.headers.authorization)
      return { status: 200, json: issueJson(6) }
    })

    const p = new GitHubProvider({
      apiRoot: baseUrl,
      tokenResolver: async (host) => {
        hosts.push(host)
        return 'resolved-token'
      },
    })

    expect((await p.getIssue(REMOTE, 5)).ok).toBe(true)
    expect((await p.getIssue(REMOTE, 6)).ok).toBe(true)
    expect(hosts).toEqual(['github.com'])
    expect(authHeaders).toEqual(['Bearer resolved-token', 'Bearer resolved-token'])
  })

  it('不同 host 各自解析（GHES 不共用公网 token）', async () => {
    const hosts: string[] = []
    routes.set(routeKey('GET', '/repos/acme/widget/issues/1'), () => ({
      status: 200,
      json: issueJson(1),
    }))

    const p = new GitHubProvider({
      apiRoot: baseUrl,
      tokenResolver: async (host) => {
        hosts.push(host)
        return `token-for-${host}`
      },
    })

    expect((await p.getIssue('https://github.com/acme/widget.git', 1)).ok).toBe(true)
    expect((await p.getIssue('https://github.example.com/acme/widget.git', 1)).ok).toBe(true)
    expect(hosts).toEqual(['github.com', 'github.example.com'])
  })

  it('显式 token 拥有最高优先级 —— 给了就绝不调用 resolver', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues/7'), () => ({
      status: 200,
      json: issueJson(7),
    }))
    const resolver = vi.fn(async () => {
      throw new Error('resolver 不该被调用')
    })

    const p = new GitHubProvider({
      apiRoot: baseUrl,
      token: 'explicit-token',
      tokenResolver: resolver,
    })
    const r = await p.getIssue(REMOTE, 7)
    expect(r.ok).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('resolver 抛错 → AUTH_FAILED，不炸也不泄漏错误内容', async () => {
    const p = new GitHubProvider({
      apiRoot: baseUrl,
      tokenResolver: async () => {
        throw new Error('gh exploded: token=sekret')
      },
    })
    const r = await p.getIssue(REMOTE, 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.detail).not.toContain('sekret')
  })

  it('resolver 返回空白 → 视为无凭据', async () => {
    const p = new GitHubProvider({ apiRoot: baseUrl, tokenResolver: async () => '   ' })
    const r = await p.getIssue(REMOTE, 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
  })
})

describe('waitForCi 四态归并', () => {
  function ciRoutes(checks: unknown, status: unknown): void {
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/check-runs'), () => ({
      status: 200,
      json: checks,
    }))
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/status'), () => ({
      status: 200,
      json: status,
    }))
  }

  it('任一 check failed → failed', async () => {
    ciRoutes(
      {
        total_count: 2,
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'failure' },
        ],
      },
      { state: 'success' },
    )
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('failed')
  })

  it('全部 success → passed', async () => {
    ciRoutes(
      { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
      { state: null },
    )
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('passed')
  })

  it('skipped conclusion 不算失败', async () => {
    ciRoutes(
      { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'skipped' }] },
      { state: 'success' },
    )
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('passed')
  })

  it('进行中 → pending → 轮询后 passed(用毫秒级间隔验证轮询真的发生)', async () => {
    let polls = 0
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/check-runs'), () => {
      polls += 1
      return polls < 2
        ? {
            status: 200,
            json: { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] },
          }
        : {
            status: 200,
            json: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
          }
    })
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/status'), () => ({
      status: 200,
      json: { state: null },
    }))

    const r = await provider({ pollIntervalMs: 5 }).waitForCi({
      repoId: 'r1',
      remoteUrl: REMOTE,
      headSha: 'sha-x',
    })
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(r.ok && r.value).toBe('passed')
  })

  it('Commit Status failure 也算失败(Checks 不是唯一事实源)', async () => {
    ciRoutes({ total_count: 0, check_runs: [] }, { state: 'failure' })
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('failed')
  })

  it('Commit Status state=pending 且无 status 上报 → passed(Actions-only 仓库的真实形态)', async () => {
    ciRoutes(
      { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] },
      {
        state: 'pending',
        statuses: [],
      },
    )
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('passed')
  })

  it('Commit Status 有真实上报且 pending → 继续等待', async () => {
    ciRoutes(
      { total_count: 0, check_runs: [] },
      {
        state: 'pending',
        statuses: [{ state: 'pending', context: 'ci/legacy' }],
      },
    )
    const r = await provider({ pollIntervalMs: 1, pollTimeoutMs: 10 }).waitForCi({
      repoId: 'r1',
      remoteUrl: REMOTE,
      headSha: 'sha-x',
    })
    // 轮询到硬超时仍 pending → failed(不是永远等)
    expect(r.ok && r.value).toBe('failed')
  })

  it('无任何 CI 配置 + 静默期已过 → passed(仓库不该永远卡死)', async () => {
    ciRoutes({ total_count: 0, check_runs: [] }, { state: null })
    const r = await provider({ emptySettleMs: 0 }).waitForCi({
      repoId: 'r1',
      remoteUrl: REMOTE,
      headSha: 'sha-x',
    })
    expect(r.ok && r.value).toBe('passed')
  })

  // ── 假绿反例(2026-08-28 第六次真实验收实录)────────────────────────────────
  //
  // Actions-only 仓库建 PR 后的头几秒:check-runs 还没注册(total_count=0),
  // commit status 恒为 pending + 空 statuses —— 两个端点都读不到东西。
  // 旧实现把这一瞬间当 passed,PR 建好 3.5 秒就流出 T-024,而真实 check-run
  // 是又过 5 秒才启动的。判据要的是「通过 CI 的 PR」,那个结论是假的。

  it('check-run 尚未注册时不得当成 passed —— 等到真结果为 failed(假绿反例)', async () => {
    let polls = 0
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/check-runs'), () => {
      polls += 1
      return polls === 1
        ? { status: 200, json: { total_count: 0, check_runs: [] } }
        : {
            status: 200,
            json: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] },
          }
    })
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/status'), () => ({
      status: 200,
      json: { state: 'pending', statuses: [] },
    }))

    // 静默期远大于轮询间隔:第一次「什么都没读到」必须继续等,不能下结论
    const r = await provider({ pollIntervalMs: 5, emptySettleMs: 10_000 }).waitForCi({
      repoId: 'r1',
      remoteUrl: REMOTE,
      headSha: 'sha-x',
    })
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(r.ok && r.value).toBe('failed')
  })

  it('静默期内无人上报 → 继续轮询,期满才认定「没配 CI」', async () => {
    let polls = 0
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/check-runs'), () => {
      polls += 1
      return { status: 200, json: { total_count: 0, check_runs: [] } }
    })
    routes.set(routeKey('GET', '/repos/acme/widget/commits/sha-x/status'), () => ({
      status: 200,
      json: { state: 'pending', statuses: [] },
    }))

    const r = await provider({
      pollIntervalMs: 5,
      emptySettleMs: 40,
      pollTimeoutMs: 10_000,
    }).waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    // 期满前至少轮询过两次 —— 证明没有第一次就早退
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(r.ok && r.value).toBe('passed')
  })
})

// ──────────────────── #1-11 · ownerRepo 解析(验收 cleanup 复用)────────────────────

describe('ownerRepo —— 从远程 URL 解析 owner/repo(#1-11)', () => {
  it('https 带 .git 尾部', () => {
    const r = ownerRepo('https://github.com/jionpz/keel.git')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('jionpz/keel')
  })

  it('https 不带 .git', () => {
    const r = ownerRepo('https://github.com/jionpz/keel')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('jionpz/keel')
  })

  it('ssh 形式 git@github.com:owner/repo.git', () => {
    const r = ownerRepo('git@github.com:acme/widget.git')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('acme/widget')
  })

  it('无法解析 → error(不抛出,返回 Result)', () => {
    const r = ownerRepo('https://example.com/x/y')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })
})

describe('parseIssueUrl', () => {
  it('标准 Issue URL', () => {
    const r = parseIssueUrl('https://github.com/acme/widget/issues/42')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.remoteUrl).toBe('https://github.com/acme/widget.git')
    expect(r.value.number).toBe(42)
  })

  it('带尾部斜杠', () => {
    const r = parseIssueUrl('https://github.com/acme/widget/issues/7/')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.number).toBe(7)
  })

  it('非法 URL → WORKSPACE_ERROR', () => {
    const r = parseIssueUrl('https://github.com/acme/widget/pull/1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })
})

describe('getIssue', () => {
  it('提取 label、排除 PR、body=null → 空串', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues/5'), () => ({
      status: 200,
      json: {
        number: 5,
        title: 'Bug report',
        body: null,
        state: 'open',
        labels: [{ name: 'keel' }, { name: 'bug' }],
      },
    }))

    const r = await provider().getIssue(REMOTE, 5)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      number: 5,
      title: 'Bug report',
      body: '',
      labels: ['keel', 'bug'],
      state: 'open',
      closedAt: null,
      isPullRequest: false,
    })
  })

  it('closed issue 原样带出 closed_at —— 对账证据不本地编造', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues/8'), () => ({
      status: 200,
      json: {
        number: 8,
        title: 'Closed',
        body: 'done',
        state: 'closed',
        closed_at: '2026-11-07T12:34:56Z',
        labels: [],
      },
    }))

    const r = await provider().getIssue(REMOTE, 8)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.state).toBe('closed')
    expect(r.value.closedAt).toBe('2026-11-07T12:34:56Z')
  })

  it('含 pull_request 字段 → isPullRequest=true', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues/9'), () => ({
      status: 200,
      json: {
        number: 9,
        title: 'PR disguised',
        body: 'x',
        state: 'open',
        labels: [],
        pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/9' },
      },
    }))

    const r = await provider().getIssue(REMOTE, 9)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.isPullRequest).toBe(true)
  })

  it('404 → NOT_FOUND', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues/99'), () => ({
      status: 404,
      json: { message: 'Not Found' },
    }))

    const r = await provider().getIssue(REMOTE, 99)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
  })
})

// ──────────────────── GHES host（issue #69）────────────────────

describe('GHES host 解析', () => {
  it('https GHES remote → owner/repo', () => {
    const r = ownerRepo('https://github.example.com/acme/widget.git')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('acme/widget')
  })

  it('ssh SCP-like GHES remote → owner/repo', () => {
    const r = ownerRepo('git@github.example.com:acme/widget.git')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('acme/widget')
  })

  it('ssh:// GHES remote → owner/repo', () => {
    const r = ownerRepo('ssh://git@github.example.com/acme/widget')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('acme/widget')
  })

  it('http GHES remote 也接受', () => {
    const r = ownerRepo('http://github.corp.example/acme/widget')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('acme/widget')
  })

  it('parseRemoteUrl 保留 host 并归一化 remoteUrl', () => {
    const r = parseRemoteUrl('git@github.example.com:acme/widget.git')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.host).toBe('github.example.com')
    expect(r.value.remoteUrl).toBe('https://github.example.com/acme/widget.git')
  })

  it('parseIssueUrl 保留 GHES host', () => {
    const r = parseIssueUrl('https://github.example.com/acme/widget/issues/7/')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.remoteUrl).toBe('https://github.example.com/acme/widget.git')
    expect(r.value.number).toBe(7)
  })

  it('apiRootForHost: 公网与 GHES', () => {
    expect(apiRootForHost('github.com')).toBe('https://api.github.com')
    expect(apiRootForHost('GitHub.com')).toBe('https://api.github.com')
    expect(apiRootForHost('github.example.com')).toBe('https://github.example.com/api/v3')
  })

  it('非 github.* host 仍拒绝', () => {
    expect(ownerRepo('https://gitlab.com/a/b.git').ok).toBe(false)
    expect(parseIssueUrl('https://gitlab.com/a/b/issues/1').ok).toBe(false)
  })

  it('host 白名单:github.com / github.* 接受,github.com.* 排除', () => {
    expect(isGitHubHost('github.com')).toBe(true)
    expect(isGitHubHost('GitHub.com')).toBe(true)
    expect(isGitHubHost('github.example.com')).toBe(true)
    expect(isGitHubHost('github.corp.example')).toBe(true)
    expect(isGitHubHost('github.com.evil.com')).toBe(false)
    expect(isGitHubHost('ghe.corp.example')).toBe(false)
    expect(ownerRepo('https://github.com.evil.com/acme/widget.git').ok).toBe(false)
  })
})

describe('parseRemoteUrl 归一与拒绝路径', () => {
  it('尾斜杠与 .git 一起剥离', () => {
    const r = parseRemoteUrl('https://github.com/acme/widget.git/')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.repo).toBe('widget')
  })

  it('.git 只剥离一次', () => {
    const r = parseRemoteUrl('https://github.com/acme/widget.git.git')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.repo).toBe('widget.git')
  })

  it('path 必须恰好两段:单段拒绝', () => {
    expect(parseRemoteUrl('https://github.com/acme').ok).toBe(false)
  })

  it('path 必须恰好两段:三段拒绝', () => {
    expect(parseRemoteUrl('https://github.com/acme/widget/extra').ok).toBe(false)
  })

  it('repo 为 `..` 拒绝(路径穿越)', () => {
    const r = parseRemoteUrl('git@github.com:acme/..')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })

  it('owner 为 `..` 拒绝(路径穿越)', () => {
    expect(parseRemoteUrl('git@github.com:../widget').ok).toBe(false)
    expect(parseRemoteUrl('https://github.com/../widget').ok).toBe(false)
  })

  it('file:// 等本地路径拒绝', () => {
    const r = parseRemoteUrl('file:///tmp/repo')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })

  it('host 统一小写', () => {
    const r = parseRemoteUrl('https://GitHub.COM/acme/widget.git')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.host).toBe('github.com')
      expect(r.value.remoteUrl).toBe('https://github.com/acme/widget.git')
    }
  })
})

describe('listOpenIssues —— poller 的扫描入口', () => {
  /** issues API 的列表元素形状；extra 用来模拟 PR / 跨页重复 */
  function listed(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      number: n,
      title: `issue ${n}`,
      state: 'open',
      labels: [{ name: 'keel' }],
      ...extra,
    }
  }

  function parsedRemote(remoteUrl: string) {
    const r = parseRemoteUrl(remoteUrl)
    if (!r.ok) throw new Error(`parseRemoteUrl 失败:${remoteUrl}`)
    return r.value
  }

  it('过滤 pull_request、保留 label 与状态', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), () => ({
      status: 200,
      json: [
        listed(1, { labels: [{ name: 'keel' }, { name: 'bug' }] }),
        listed(2, { pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/2' } }),
      ],
    }))

    const r = await provider().listOpenIssues(REMOTE, 'keel')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.truncated).toBe(false)
    expect(r.value.issues).toEqual([
      {
        number: 1,
        title: 'issue 1',
        state: 'open',
        isPullRequest: false,
        labels: ['keel', 'bug'],
      },
    ])
  })

  it('分页拼接两页，并按 number 丢弃跨页重复', async () => {
    const requests: string[] = []
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), (req) => {
      requests.push(req.url)
      const page = new URL(`http://x${req.url}`).searchParams.get('page')
      if (page === '1') {
        return {
          status: 200,
          json: Array.from({ length: 100 }, (_, i) => listed(i + 1)),
        }
      }
      // 第二页:一条与第一页重复 + 两条新的；不足 100 即停
      return { status: 200, json: [listed(2), listed(101), listed(102)] }
    })

    const r = await provider().listOpenIssues(REMOTE, 'keel')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.issues).toHaveLength(102)
    expect(r.value.issues.map((i) => i.number)).toContain(101)
    expect(new Set(r.value.issues.map((i) => i.number)).size).toBe(102)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toContain('per_page=100')
    expect(requests[1]).toContain('page=2')
  })

  it('触到 maxPages 上限且最后一页是满页 → truncated:true（不静默截断）', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), (req) => {
      const page = Number(new URL(`http://x${req.url}`).searchParams.get('page'))
      return {
        status: 200,
        json: Array.from({ length: 100 }, (_, i) => listed((page - 1) * 100 + i + 1)),
      }
    })

    const r = await provider().listOpenIssues(REMOTE, 'keel', { maxPages: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.issues).toHaveLength(200)
    expect(r.value.truncated).toBe(true)
  })

  it('label 含空格 / 斜杠 / 中文时 query 正确编码', async () => {
    let requested: string | undefined
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), (req) => {
      requested = req.url
      return { status: 200, json: [] }
    })

    const label = '需 review/评审'
    const r = await provider().listOpenIssues(REMOTE, label)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.issues).toEqual([])
    expect(requested).toBeDefined()
    const params = new URL(`http://x${requested}`).searchParams
    expect(params.get('labels')).toBe(label)
    expect(params.get('state')).toBe('open')
  })

  it('空 label 拒绝且不发请求 —— 空 labels 会列出全部 open issue', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await provider().listOpenIssues(REMOTE, '   ')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('非 GitHub host 拒绝', async () => {
    const r = await provider().listOpenIssues('https://gitlab.com/acme/widget.git', 'keel')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
  })

  it('响应不是数组 → PROTOCOL_ERROR', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), () => ({
      status: 200,
      json: { message: 'unexpected' },
    }))
    const r = await provider().listOpenIssues(REMOTE, 'keel')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('PROTOCOL_ERROR')
  })

  it('列表元素形状不对 → PROTOCOL_ERROR（不静默跳过）', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/issues?'), () => ({
      status: 200,
      json: [{ number: '1' }],
    }))
    const r = await provider().listOpenIssues(REMOTE, 'keel')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('PROTOCOL_ERROR')
  })

  it('issueUrlFor 归一化 https / ssh / GHES remote', () => {
    expect(issueUrlFor(parsedRemote('https://github.com/acme/widget.git'), 3)).toBe(
      'https://github.com/acme/widget/issues/3',
    )
    expect(issueUrlFor(parsedRemote('git@github.com:acme/widget.git'), 7)).toBe(
      'https://github.com/acme/widget/issues/7',
    )
    expect(issueUrlFor(parsedRemote('ssh://git@github.example.com/acme/widget'), 9)).toBe(
      'https://github.example.com/acme/widget/issues/9',
    )
  })
})

describe('API root 按 host 推导', () => {
  const saved = process.env.KEEL_GITHUB_API_ROOT

  afterEach(() => {
    if (saved === undefined) delete process.env.KEEL_GITHUB_API_ROOT
    else process.env.KEEL_GITHUB_API_ROOT = saved
    vi.restoreAllMocks()
  })

  const issueJson = JSON.stringify({
    number: 1,
    title: 't',
    body: '',
    labels: [],
    state: 'open',
  })

  it('未设环境变量: GHES host → https://<host>/api/v3', async () => {
    delete process.env.KEEL_GITHUB_API_ROOT
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(issueJson, { status: 200 }))

    const p = new GitHubProvider({ token: 't' })
    const r = await p.getIssue('https://github.example.com/acme/widget.git', 1)
    expect(r.ok).toBe(true)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://github.example.com/api/v3/repos/acme/widget/issues/1',
    )
  })

  it('KEEL_GITHUB_API_ROOT 覆盖 host 推导', async () => {
    process.env.KEEL_GITHUB_API_ROOT = 'https://gateway.example/api/v3/'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(issueJson, { status: 200 }))

    const p = new GitHubProvider({ token: 't' })
    const r = await p.getIssue('https://github.example.com/acme/widget.git', 1)
    expect(r.ok).toBe(true)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://gateway.example/api/v3/repos/acme/widget/issues/1',
    )
  })

  it('空白 KEEL_GITHUB_API_ROOT → WORKSPACE_ERROR 且不发请求', async () => {
    process.env.KEEL_GITHUB_API_ROOT = '   '
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const p = new GitHubProvider({ token: 't' })
    const r = await p.getIssue('https://github.com/acme/widget.git', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('github.com 缺省仍打 api.github.com', async () => {
    delete process.env.KEEL_GITHUB_API_ROOT
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(issueJson, { status: 200 }))

    const p = new GitHubProvider({ token: 't' })
    const r = await p.getIssue('https://github.com/acme/widget.git', 1)
    expect(r.ok).toBe(true)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/repos/acme/widget/issues/1',
    )
  })

  it('opts.apiRoot 优先级高于 KEEL_GITHUB_API_ROOT', async () => {
    process.env.KEEL_GITHUB_API_ROOT = 'https://env.example/api/v3'
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(issueJson, { status: 200 }))

    const p = new GitHubProvider({ apiRoot: 'https://explicit.example/api/v3', token: 't' })
    const r = await p.getIssue('https://github.example.com/acme/widget.git', 1)
    expect(r.ok).toBe(true)
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      'https://explicit.example/api/v3/repos/acme/widget/issues/1',
    )
  })

  it('空白 opts.apiRoot → WORKSPACE_ERROR 且不发请求', async () => {
    delete process.env.KEEL_GITHUB_API_ROOT
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const p = new GitHubProvider({ apiRoot: '   ', token: 't' })
    const r = await p.getIssue('https://github.com/acme/widget.git', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('非 http(s) 的 opts.apiRoot → WORKSPACE_ERROR 且不发请求', async () => {
    delete process.env.KEEL_GITHUB_API_ROOT
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const p = new GitHubProvider({ apiRoot: 'ftp://gateway.example', token: 't' })
    const r = await p.getIssue('https://github.com/acme/widget.git', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('非 http(s) 的 KEEL_GITHUB_API_ROOT → WORKSPACE_ERROR 且不发请求', async () => {
    process.env.KEEL_GITHUB_API_ROOT = 'ftp://gateway.example/api/v3'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const p = new GitHubProvider({ token: 't' })
    const r = await p.getIssue('https://github.example.com/acme/widget.git', 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('WORKSPACE_ERROR')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
