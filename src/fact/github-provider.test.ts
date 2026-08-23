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
 *   - CI 三态归并与硬超时
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubProvider } from './github-provider.js'

let server: Server
let baseUrl: string

/** 每个用例自己注册路由;未命中路由返回 500 以暴露测试缺口 */
type Handler = (
  req: { method: string; url: string },
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
      const out = handler?.({ method: req.method ?? 'GET', url: req.url ?? '' }, body) ?? {
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
    expect(r.error.detail).not.toContain('Bearer')
  })
})

describe('waitForCi 三态归并', () => {
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

  it('无任何 CI 配置 → passed(仓库不该永远卡死)', async () => {
    ciRoutes({ total_count: 0, check_runs: [] }, { state: null })
    const r = await provider().waitForCi({ repoId: 'r1', remoteUrl: REMOTE, headSha: 'sha-x' })
    expect(r.ok && r.value).toBe('passed')
  })

  it('硬超时 → failed(不是永远等下去)', async () => {
    ciRoutes(
      { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] },
      { state: 'pending' },
    )
    const r = await provider({ pollIntervalMs: 1, pollTimeoutMs: 10 }).waitForCi({
      repoId: 'r1',
      remoteUrl: REMOTE,
      headSha: 'sha-x',
    })
    expect(r.ok && r.value).toBe('failed')
  })
})
