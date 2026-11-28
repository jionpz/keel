import { listenTestServer } from '../test-support/http-server.js'
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiRootForHost,
  GitHubProvider,
  issueUrlFor,
  ownerRepo,
  parseIssueUrl,
} from './github-provider.js'
import { isGitHubHost, parseRemoteUrl } from './github-remote.js'

let server: Server
let baseUrl: string
let http: Awaited<ReturnType<typeof listenTestServer>>

/** 每个用例自己注册路由;未命中路由返回 500 以暴露测试缺口 */
type Handler = (
  req: { method: string; url: string; headers: IncomingHttpHeaders },
  body: unknown,
) => {
  status: number
  json: unknown
  headers?: Record<string, string>
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
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers })
      res.end(JSON.stringify(out.json))
    })
  })
  http = await listenTestServer(server)
  baseUrl = http.baseUrl
})

afterEach(async () => {
  await http?.close()
})

const REMOTE = 'https://github.com/acme/widget.git'
const CI_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const CI_INPUT = { repoId: 'r1', remoteUrl: REMOTE, headSha: CI_SHA }
const CI_PR_PATH = '/repos/acme/widget/pulls/7'
const CHECKS_PATH = `/repos/acme/widget/commits/${CI_SHA}/check-runs?filter=all`
const STATUS_PATH = `/repos/acme/widget/commits/${CI_SHA}/status?`
const ACTIONS_PATH = '/repos/acme/widget/actions/runs'
const ACTIONS_LIST_PATH = `${ACTIONS_PATH}?head_sha=${CI_SHA}`
const ACTIONS_JOBS_PATH = `${ACTIONS_PATH}/42/jobs?filter=latest`
const ACTIONS_RUN_PATH = `${ACTIONS_PATH}/42`

function pullRequest(sha = CI_SHA) {
  return {
    number: 7,
    html_url: 'https://github.com/acme/widget/pull/7',
    state: 'open',
    merged: false,
    head: { ref: 'ai/task-7', sha },
    base: { ref: 'main' },
  }
}

function checkRun(id: number, name: string, conclusion: string | null) {
  return {
    id,
    name,
    head_sha: CI_SHA,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
  }
}

function checkRuns(checks: readonly unknown[] = []) {
  return { total_count: checks.length, check_runs: checks }
}

function combinedStatus(statuses: readonly unknown[] = [], sha = CI_SHA) {
  return { sha, total_count: statuses.length, statuses }
}

function ciRoutes({
  checks = [],
  statuses = [],
}: {
  checks?: readonly unknown[]
  statuses?: readonly unknown[]
} = {}): void {
  routes.set(routeKey('GET', CHECKS_PATH), () => ({ status: 200, json: checkRuns(checks) }))
  routes.set(routeKey('GET', STATUS_PATH), () => ({ status: 200, json: combinedStatus(statuses) }))
}

function actionsCheck(id: number, conclusion: string | null) {
  return {
    ...checkRun(id, 'verify', conclusion),
    app: { id: 1, slug: 'github-actions' },
    check_suite: { id: 11 },
  }
}

function actionsRun(attempt: number, conclusion: string | null) {
  return {
    id: 42,
    head_sha: CI_SHA,
    check_suite_id: 11,
    run_attempt: attempt,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
  }
}

function actionsJob(check: ReturnType<typeof actionsCheck>) {
  return {
    check_run_url: `https://api.github.com/repos/acme/widget/check-runs/${check.id}`,
    head_sha: check.head_sha,
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
  }
}

describe('observeCi / rerunFailedCi', () => {
  it('读取准确 SHA 的失败步骤，且仅对仍失败的首轮 Actions 请求重跑', async () => {
    const input = { ...CI_INPUT, prNumber: 7 }
    const firstCheck = actionsCheck(100, 'failure')
    let runAttempt = 1
    let prHead = CI_SHA
    let conclusion: string | null = 'failure'
    let posts = 0
    const workflow = () => actionsRun(runAttempt, conclusion)
    const currentCheck = () => actionsCheck(99 + runAttempt, conclusion)
    ciRoutes()
    routes.set(routeKey('GET', CHECKS_PATH), () => ({
      status: 200,
      json: checkRuns(runAttempt === 1 ? [currentCheck()] : [currentCheck(), firstCheck]),
    }))
    routes.set(routeKey('GET', ACTIONS_LIST_PATH), () => ({
      status: 200,
      json: {
        total_count: 2,
        workflow_runs: [{ ...workflow(), id: 41, check_suite_id: 10 }, workflow()],
      },
    }))
    routes.set(routeKey('GET', ACTIONS_JOBS_PATH), () => ({
      status: 200,
      json: { total_count: 1, jobs: [actionsJob(currentCheck())] },
    }))
    routes.set(routeKey('GET', `${ACTIONS_RUN_PATH}/attempts/1/jobs?`), () => ({
      status: 200,
      json: {
        total_count: 1,
        jobs: [
          {
            name: 'verify',
            conclusion: 'failure',
            steps: [
              { name: 'setup', conclusion: 'success' },
              { name: 'Vitest test-token', conclusion: 'failure' },
            ],
          },
        ],
      },
    }))
    routes.set(routeKey('GET', ACTIONS_RUN_PATH), () => ({ status: 200, json: workflow() }))
    routes.set(routeKey('GET', CI_PR_PATH), () => ({
      status: 200,
      json: pullRequest(prHead),
    }))
    routes.set(routeKey('POST', `${ACTIONS_RUN_PATH}/rerun-failed-jobs`), () => {
      posts++
      return { status: 201, json: {} }
    })
    const gh = provider()
    expect(await gh.observeCi(input)).toMatchObject({
      ok: true,
      value: {
        state: 'failed',
        rerun: { runId: 42, attempt: 1 },
        evidence: { jobs: [{ name: 'verify', failedSteps: ['Vitest ***'] }] },
      },
    })
    expect(await gh.rerunFailedCi(input, { runId: 42, attempt: 1 })).toEqual({
      ok: true,
      value: true,
    })
    runAttempt = 2
    conclusion = null
    expect(await gh.observeCi(input)).toEqual({ ok: true, value: { state: 'pending' } })
    expect(await gh.rerunFailedCi(input, { runId: 42, attempt: 1 })).toMatchObject({
      ok: false,
      error: { kind: 'STALE_EVIDENCE' },
    })
    conclusion = 'success'
    expect(await gh.observeCi(input)).toEqual({ ok: true, value: { state: 'passed' } })
    expect(
      await gh.observeRequiredChecks({
        ...input,
        expectedHeadSha: CI_SHA,
        requiredChecks: ['verify'],
        observedAt: '2026-11-11T00:00:00.000Z',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        headSha: CI_SHA,
        checks: [{ name: 'verify', source: 'check_run', conclusion: 'success', externalId: '101' }],
      },
    })
    runAttempt = 1
    conclusion = 'failure'
    prHead = OTHER_SHA
    expect(await gh.rerunFailedCi(input, { runId: 42, attempt: 1 })).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
    expect(posts).toBe(1)
  })

  it.each([
    { scenario: 'check-runs 仍返回首轮失败', jobsCheck: actionsCheck(101, 'success'), attempt: 2 },
    { scenario: '工作流在复查前进入新轮次', jobsCheck: actionsCheck(100, 'failure'), attempt: 1 },
  ])('$scenario 时返回 CONFLICT', async ({ jobsCheck, attempt }) => {
    ciRoutes({ checks: [actionsCheck(100, 'failure')] })
    routes.set(routeKey('GET', ACTIONS_LIST_PATH), () => ({
      status: 200,
      json: { total_count: 1, workflow_runs: [actionsRun(attempt, jobsCheck.conclusion)] },
    }))
    routes.set(routeKey('GET', ACTIONS_JOBS_PATH), () => ({
      status: 200,
      json: { total_count: 1, jobs: [actionsJob(jobsCheck)] },
    }))
    routes.set(routeKey('GET', ACTIONS_RUN_PATH), () => ({
      status: 200,
      json: actionsRun(2, 'success'),
    }))
    expect(await provider().observeCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })
})

function provider(opts: ConstructorParameters<typeof GitHubProvider>[0] = {}): GitHubProvider {
  return new GitHubProvider({
    apiRoot: baseUrl,
    fetchFn: (input, init) => http.fetch(input, init),
    token: 'test-token',
    ...opts,
  })
}

describe('IssueGateway', () => {
  it('PR 的 merged 字段缺失时拒绝推断为未合并关闭', async () => {
    routes.set(routeKey('GET', '/repos/acme/widget/pulls/7'), () => ({
      status: 200,
      json: { number: 7, state: 'closed' },
    }))
    const result = await provider().getPullRequest({ repoId: 'r1', remoteUrl: REMOTE, number: 7 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('PROTOCOL_ERROR')
  })
  it('响应体读取超时与非 JSON 均降级为 Result，不向上抛异常或泄露错误内容', async () => {
    const response = new Response('not-json', { status: 200 })
    const read = vi.spyOn(response, 'text').mockRejectedValueOnce(new Error('secret-query'))
    const api = provider({ fetchFn: async () => response })
    const timeout = await api.issueActor(REMOTE)
    expect(timeout.ok).toBe(false)
    if (!timeout.ok) {
      expect(timeout.error.kind).toBe('HARNESS_UNAVAILABLE')
      expect(timeout.error.detail).not.toContain('secret-query')
    }
    read.mockRestore()
    const invalid = await api.issueActor(REMOTE)
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.kind).toBe('PROTOCOL_ERROR')
  })
  it('GHES 评论读取、创建与关闭共用 host/token 请求路径', async () => {
    const comment = {
      id: 12,
      body: '请补充预期',
      created_at: '2026-11-12T10:00:00Z',
      user: { login: 'keel-bot' },
    }
    routes.set(routeKey('GET', '/user'), () => ({ status: 200, json: { login: 'keel-bot' } }))
    routes.set(routeKey('GET', '/repos/acme/widget/issues/7/comments'), (request) => {
      expect(request.url).toContain('since=2026-11-12')
      expect(request.headers.authorization).toBe('Bearer test-token')
      return { status: 200, json: [comment] }
    })
    routes.set(routeKey('POST', '/repos/acme/widget/issues/7/comments'), (_request, body) => {
      expect(body).toEqual({ body: '请补充预期' })
      return { status: 201, json: comment }
    })
    routes.set(routeKey('PATCH', '/repos/acme/widget/issues/7'), (_request, body) => {
      expect(body).toEqual({ state: 'closed', state_reason: 'not_planned' })
      return { status: 200, json: {} }
    })
    const github = provider()
    const remote = 'https://github.example.com/acme/widget.git'
    expect(await github.issueActor(remote)).toEqual({ ok: true, value: 'keel-bot' })
    expect(await github.listIssueComments(remote, 7, '2026-11-12T10:00:00Z')).toMatchObject({
      ok: true,
      value: { truncated: false, comments: [{ id: 12, author: 'keel-bot' }] },
    })
    expect(await github.createIssueComment(remote, 7, '请补充预期')).toMatchObject({
      ok: true,
      value: { id: 12 },
    })
    expect(await github.closeIssue(remote, 7, 'not_planned')).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it('写失败保留 HTTP 错误，形状损坏不冒充成功', async () => {
    routes.set(routeKey('POST', '/repos/acme/widget/issues/7/comments'), () => ({
      status: 503,
      json: {},
    }))
    expect(await provider().createIssueComment(REMOTE, 7, 'body')).toMatchObject({
      ok: false,
      error: { kind: 'HARNESS_UNAVAILABLE' },
    })
    routes.set(routeKey('GET', '/repos/acme/widget/issues/7/comments'), () => ({
      status: 200,
      json: [{ id: 1 }],
    }))
    expect(await provider().listIssueComments(REMOTE, 7)).toMatchObject({
      ok: false,
      error: { kind: 'PROTOCOL_ERROR' },
    })
  })
})

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
    const p = new GitHubProvider({
      apiRoot: baseUrl,
      fetchFn: (input, init) => http.fetch(input, init),
      token: null,
    })
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
      fetchFn: (input, init) => http.fetch(input, init),
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
      fetchFn: (input, init) => http.fetch(input, init),
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
      fetchFn: (input, init) => http.fetch(input, init),
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
      fetchFn: (input, init) => http.fetch(input, init),
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

describe('waitForCi', () => {
  it.each(['success', 'skipped'])('准确 SHA 上的 %s check 可以通过', async (conclusion) => {
    ciRoutes({ checks: [checkRun(11, 'tests', conclusion)] })
    routes.set(routeKey('GET', STATUS_PATH), () => ({
      status: 200,
      json: { ...combinedStatus(), state: 'pending' },
    }))
    expect(await provider({ pollTimeoutMs: 0 }).waitForCi(CI_INPUT)).toEqual({
      ok: true,
      value: 'passed',
    })
  })

  it.each([
    { source: 'check-run', checks: [checkRun(11, 'tests', 'failure')], statuses: [] },
    {
      source: 'commit status',
      checks: [checkRun(11, 'tests', 'success')],
      statuses: [{ id: 21, context: 'ci/legacy', state: 'failure' }],
    },
  ])('准确 SHA 上可信的 $source 失败会结束等待', async ({ checks, statuses }) => {
    ciRoutes({ checks, statuses })
    expect(await provider({ pollTimeoutMs: 0 }).waitForCi(CI_INPUT)).toEqual({
      ok: true,
      value: 'failed',
    })
  })

  it.each([
    {
      from: '进行中',
      initial: [checkRun(11, 'tests', null)],
      conclusion: 'success',
      end: 'passed',
    },
    { from: '未上报', initial: [], conclusion: 'failure', end: 'failed' },
    {
      from: '读到旧 SHA 的失败',
      initial: [{ ...checkRun(10, 'tests', 'failure'), head_sha: OTHER_SHA }],
      conclusion: 'success',
      end: 'passed',
    },
  ])('$from 后重新读取，直到可信终态 $end', async ({ initial, conclusion, end }) => {
    ciRoutes()
    let polls = 0
    routes.set(routeKey('GET', CHECKS_PATH), () => ({
      status: 200,
      json: checkRuns(polls++ === 0 ? initial : [checkRun(11, 'tests', conclusion)]),
    }))
    const gh = provider({ pollIntervalMs: 1, pollTimeoutMs: 1_000 })
    expect(await gh.waitForCi(CI_INPUT)).toEqual({
      ok: true,
      value: end,
    })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('已上报 pending 的 commit status 耗尽预算时返回 RUN_TIMEOUT', async () => {
    ciRoutes({ statuses: [{ id: 21, context: 'ci/legacy', state: 'pending' }] })
    const gh = provider({ pollTimeoutMs: 0, emptySettleMs: 0 })
    expect(await gh.observeCi(CI_INPUT)).toEqual({ ok: true, value: { state: 'pending' } })
    expect(await gh.waitForCi({ ...CI_INPUT, allowUnreported: true })).toMatchObject({
      ok: false,
      error: { kind: 'RUN_TIMEOUT' },
    })
  })

  it('无人上报默认耗尽观测预算，显式允许时才可在静默期后通过', async () => {
    ciRoutes()
    const gh = provider({ pollTimeoutMs: 0, emptySettleMs: 0 })
    expect(await gh.observeCi(CI_INPUT)).toEqual({ ok: true, value: { state: 'unreported' } })
    expect(await gh.waitForCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'RUN_TIMEOUT' },
    })
    expect(await gh.waitForCi({ ...CI_INPUT, allowUnreported: true })).toEqual({
      ok: true,
      value: 'passed',
    })
  })

  it('显式允许无人上报时，静默期内继续轮询', async () => {
    ciRoutes()
    let polls = 0
    routes.set(routeKey('GET', CHECKS_PATH), () => {
      polls++
      return { status: 200, json: checkRuns() }
    })
    const gh = provider({ pollIntervalMs: 1, pollTimeoutMs: 1_000, emptySettleMs: 20 })
    expect(await gh.waitForCi({ ...CI_INPUT, allowUnreported: true })).toEqual({
      ok: true,
      value: 'passed',
    })
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('持续读取到旧 SHA 时返回 RUN_TIMEOUT 并保留冲突分类', async () => {
    ciRoutes({ checks: [{ ...checkRun(11, 'tests', 'failure'), head_sha: OTHER_SHA }] })
    const gh = provider({ pollIntervalMs: 1, pollTimeoutMs: 25, emptySettleMs: 0 })
    expect(await gh.waitForCi({ ...CI_INPUT, allowUnreported: true })).toMatchObject({
      ok: false,
      error: { kind: 'RUN_TIMEOUT', cause: { kind: 'CONFLICT' } },
    })
  })
})

describe('observeCi 的证据边界', () => {
  it.each([
    {
      source: 'check-run',
      path: CHECKS_PATH,
      json: checkRuns([
        checkRun(12, 'tests', 'success'),
        { ...checkRun(11, 'lint', 'success'), head_sha: OTHER_SHA },
      ]),
    },
    {
      source: 'combined status',
      path: STATUS_PATH,
      json: combinedStatus([{ id: 21, context: 'ci/legacy', state: 'failure' }], OTHER_SHA),
    },
  ])('$source 返回旧 SHA 时报告冲突', async ({ path, json }) => {
    ciRoutes()
    routes.set(routeKey('GET', path), () => ({ status: 200, json }))
    expect(await provider().observeCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it.each([
    {
      source: 'check-run 缺少 SHA',
      path: CHECKS_PATH,
      json: checkRuns([{ ...checkRun(11, 'tests', 'success'), head_sha: undefined }]),
    },
    {
      source: 'combined status 缺少 SHA',
      path: STATUS_PATH,
      json: { ...combinedStatus(), sha: undefined },
    },
    {
      source: 'combined status 的 SHA 被截短',
      path: STATUS_PATH,
      json: combinedStatus([], CI_SHA.slice(0, 7)),
    },
  ])('$source 时以协议错误结束等待', async ({ path, json }) => {
    ciRoutes({ checks: [checkRun(11, 'tests', 'success')] })
    routes.set(routeKey('GET', path), () => ({ status: 200, json }))
    const gh = provider({ pollTimeoutMs: 0 })
    expect(await gh.waitForCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'PROTOCOL_ERROR' },
    })
  })

  it('PR 换头后，旧 head 的失败失效，新 head 的成功可独立观察', async () => {
    ciRoutes()
    let head = CI_SHA
    routes.set(routeKey('GET', CI_PR_PATH), () => ({ status: 200, json: pullRequest(head) }))
    routes.set(routeKey('GET', CHECKS_PATH), () => {
      head = OTHER_SHA
      return { status: 200, json: checkRuns([checkRun(11, 'tests', 'failure')]) }
    })
    routes.set(
      routeKey('GET', `/repos/acme/widget/commits/${OTHER_SHA}/check-runs?filter=all`),
      () => ({
        status: 200,
        json: checkRuns([{ ...checkRun(12, 'tests', 'success'), head_sha: OTHER_SHA }]),
      }),
    )
    routes.set(routeKey('GET', `/repos/acme/widget/commits/${OTHER_SHA}/status?`), () => ({
      status: 200,
      json: combinedStatus([], OTHER_SHA),
    }))
    const gh = provider()
    const input = { ...CI_INPUT, prNumber: 7 }
    expect(await gh.observeCi(input)).toMatchObject({ ok: false, error: { kind: 'CONFLICT' } })
    expect(await gh.observeCi({ ...input, headSha: OTHER_SHA })).toEqual({
      ok: true,
      value: { state: 'passed' },
    })
  })

  it.each([
    {
      source: 'check-runs',
      path: CHECKS_PATH,
      json: { ...checkRuns([checkRun(11, 'tests', 'success')]), total_count: 2 },
    },
    {
      source: 'combined status',
      path: STATUS_PATH,
      json: {
        ...combinedStatus([{ id: 21, context: 'ci/legacy', state: 'success' }]),
        total_count: 2,
      },
    },
  ])('$source 的响应少于声明的总数时拒绝通过', async ({ path, json }) => {
    ciRoutes({ checks: [checkRun(11, 'tests', 'success')] })
    routes.set(routeKey('GET', path), () => ({ status: 200, json }))
    expect(await provider().observeCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it('第二页的失败会影响结论，重复标识则使整次观测失效', async () => {
    ciRoutes()
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      checkRun(index + 1, `checks/${index + 1}`, 'success'),
    )
    const next = `${CHECKS_PATH}&per_page=100&page=2`
    let secondPage = [checkRun(101, 'tests', 'failure')]
    routes.set(routeKey('GET', CHECKS_PATH), ({ url }) => {
      const page = new URL(url, baseUrl).searchParams.get('page')
      return page === '2'
        ? { status: 200, json: { total_count: 101, check_runs: secondPage } }
        : {
            status: 200,
            json: { total_count: 101, check_runs: firstPage },
            headers: { Link: `<${baseUrl}${next}>; rel="next"` },
          }
    })
    const gh = provider()
    expect(await gh.observeCi(CI_INPUT)).toMatchObject({
      ok: true,
      value: { state: 'failed', evidence: { checks: [{ name: 'tests', conclusion: 'failure' }] } },
    })
    secondPage = [checkRun(1, 'checks/1', 'success')]
    expect(await gh.observeCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it.each([
    { status: 401, headers: {}, kind: 'AUTH_FAILED', retryable: false },
    { status: 403, headers: {}, kind: 'AUTH_FAILED', retryable: false },
    { status: 403, headers: { 'Retry-After': '1' }, kind: 'HARNESS_UNAVAILABLE', retryable: true },
    { status: 429, headers: { 'Retry-After': '1' }, kind: 'HARNESS_UNAVAILABLE', retryable: true },
  ])('HTTP $status 的观察错误分类为 $kind', async ({ status, headers, kind, retryable }) => {
    ciRoutes({ checks: [checkRun(11, 'tests', 'success')] })
    routes.set(routeKey('GET', STATUS_PATH), () => ({ status, headers, json: {} }))
    const gh = provider({ pollTimeoutMs: 0 })
    expect(await gh.observeCi(CI_INPUT)).toMatchObject({ ok: false, error: { kind, retryable } })
    expect(await gh.waitForCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: retryable ? { kind: 'RUN_TIMEOUT', cause: { kind } } : { kind },
    })
  })

  it('网络拒绝归类为暂不可用，耗尽预算时保留原因', async () => {
    const gh = provider({
      pollTimeoutMs: 0,
      fetchFn: async () => {
        throw new TypeError('connection reset')
      },
    })
    expect(await gh.observeCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'HARNESS_UNAVAILABLE', retryable: true },
    })
    expect(await gh.waitForCi(CI_INPUT)).toMatchObject({
      ok: false,
      error: { kind: 'RUN_TIMEOUT', cause: { kind: 'HARNESS_UNAVAILABLE' } },
    })
  })
})

describe('getPullRequest', () => {
  const SHA = '1111111111111111111111111111111111111111'
  const PR_PATH = '/repos/acme/widget/pulls/7'

  it('open PR 原样返回 open / merged=false / 缺失时间为 null', async () => {
    routes.set(routeKey('GET', PR_PATH), () => ({
      status: 200,
      json: {
        number: 7,
        html_url: 'https://github.com/acme/widget/pull/7',
        state: 'open',
        merged: false,
        head: { sha: SHA },
      },
    }))

    const r = await provider().getPullRequest({ repoId: 'r1', remoteUrl: REMOTE, number: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      number: 7,
      url: 'https://github.com/acme/widget/pull/7',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      closedAt: null,
      headSha: SHA,
    })
  })

  it('merged PR 带出 merged_at / merge_commit_sha / closed_at', async () => {
    routes.set(routeKey('GET', PR_PATH), () => ({
      status: 200,
      json: {
        number: 7,
        html_url: 'https://github.com/acme/widget/pull/7',
        state: 'closed',
        merged: true,
        merged_at: '2026-11-12T01:02:03Z',
        merge_commit_sha: 'b'.repeat(40),
        closed_at: '2026-11-12T01:02:03Z',
        head: { sha: SHA },
      },
    }))

    const r = await provider().getPullRequest({ repoId: 'r1', remoteUrl: REMOTE, number: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({
      state: 'closed',
      merged: true,
      mergedAt: '2026-11-12T01:02:03Z',
      mergeSha: 'b'.repeat(40),
      closedAt: '2026-11-12T01:02:03Z',
    })
  })

  it('closed 未合并 → merged=false，完成语义不靠 state=closed 推断', async () => {
    routes.set(routeKey('GET', PR_PATH), () => ({
      status: 200,
      json: {
        number: 7,
        html_url: 'https://github.com/acme/widget/pull/7',
        state: 'closed',
        merged: false,
        closed_at: '2026-11-12T02:00:00Z',
        head: { sha: SHA },
      },
    }))

    const r = await provider().getPullRequest({ repoId: 'r1', remoteUrl: REMOTE, number: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ state: 'closed', merged: false })
    expect(r.value.mergedAt).toBeNull()
  })

  it('404 → NOT_FOUND', async () => {
    routes.set(routeKey('GET', PR_PATH), () => ({ status: 404, json: { message: 'Not Found' } }))

    const r = await provider().getPullRequest({ repoId: 'r1', remoteUrl: REMOTE, number: 7 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
    expect(r.error.retryable).toBe(false)
  })

  it('编号不一致或 merged=true 但 state=open → PROTOCOL_ERROR', async () => {
    routes.set(routeKey('GET', PR_PATH), () => ({
      status: 200,
      json: {
        number: 8,
        state: 'closed',
        merged: true,
        merged_at: '2026-11-12T01:02:03Z',
      },
    }))
    const wrongNumber = await provider().getPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      number: 7,
    })
    expect(wrongNumber.ok).toBe(false)
    if (wrongNumber.ok) return
    expect(wrongNumber.error.kind).toBe('PROTOCOL_ERROR')

    routes.set(routeKey('GET', PR_PATH), () => ({
      status: 200,
      json: { number: 7, state: 'open', merged: true },
    }))
    const impossible = await provider().getPullRequest({
      repoId: 'r1',
      remoteUrl: REMOTE,
      number: 7,
    })
    expect(impossible.ok).toBe(false)
    if (impossible.ok) return
    expect(impossible.error.kind).toBe('PROTOCOL_ERROR')
  })
})

describe('observeRequiredChecks', () => {
  const input = {
    repoId: CI_INPUT.repoId,
    remoteUrl: CI_INPUT.remoteUrl,
    prNumber: 7,
    expectedHeadSha: CI_SHA,
    requiredChecks: ['test'],
    observedAt: '2026-11-11T00:00:00.000Z',
  }

  beforeEach(() => {
    routes.set(routeKey('GET', CI_PR_PATH), () => ({ status: 200, json: pullRequest() }))
  })

  it('返回准确 PR head SHA 上匹配 required check 的显式结论', async () => {
    ciRoutes({
      checks: [
        {
          ...checkRun(12, 'test', 'success'),
          details_url: 'https://example.test/check/12',
        },
        checkRun(13, 'unrelated', 'failure'),
      ],
    })
    const result = await provider().observeRequiredChecks(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({
      repo: 'acme/widget',
      prNumber: 7,
      prState: 'open',
      headBranch: 'ai/task-7',
      baseBranch: 'main',
      headSha: CI_SHA,
    })
    expect(result.value.checks).toEqual([
      {
        name: 'test',
        source: 'check_run',
        conclusion: 'success',
        externalId: '12',
        detailsUrl: 'https://example.test/check/12',
      },
    ])
  })

  it('其他检查已经成功时，未上报的 required check 仍无事实', async () => {
    ciRoutes({
      checks: [checkRun(12, 'unrelated', 'success')],
      statuses: [{ id: 21, context: 'ci/legacy', state: 'success' }],
    })
    expect(await provider().observeRequiredChecks(input)).toMatchObject({
      ok: true,
      value: { headSha: CI_SHA, checks: [] },
    })
  })

  it('required check 来自其他 SHA 时报告冲突', async () => {
    ciRoutes({
      checks: [{ ...checkRun(14, 'test', 'success'), head_sha: OTHER_SHA }],
    })
    expect(await provider().observeRequiredChecks(input)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it('读到的 PR head 与调用方指定的 SHA 不同时报告冲突', async () => {
    routes.set(routeKey('GET', CI_PR_PATH), () => ({
      status: 200,
      json: pullRequest(OTHER_SHA),
    }))
    expect(await provider().observeRequiredChecks(input)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it('PR head 在观察中变化时整次证据作废', async () => {
    ciRoutes()
    let head = CI_SHA
    routes.set(routeKey('GET', CI_PR_PATH), () => ({
      status: 200,
      json: pullRequest(head),
    }))
    routes.set(routeKey('GET', CHECKS_PATH), () => {
      head = OTHER_SHA
      return { status: 200, json: checkRuns([checkRun(12, 'test', 'success')]) }
    })
    expect(await provider().observeRequiredChecks(input)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
  })

  it('Commit Status 的 required context 也作为独立事实源返回', async () => {
    ciRoutes({
      statuses: [
        {
          id: 21,
          context: 'ci/legacy',
          state: 'success',
          target_url: 'https://example.test/status/21',
        },
      ],
    })
    const result = await provider().observeRequiredChecks({
      ...input,
      requiredChecks: ['ci/legacy'],
    })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.value.checks).toEqual([
        {
          name: 'ci/legacy',
          source: 'commit_status',
          conclusion: 'success',
          externalId: '21',
          detailsUrl: 'https://example.test/status/21',
        },
      ])
  })

  it.each([
    {
      scenario: '同名 check-run 和 commit status 结论相反',
      checks: [checkRun(12, 'test', 'success')],
      statuses: [{ id: 21, context: 'test', state: 'failure' }],
    },
    {
      scenario: '不同 app 发布同名 check-run',
      checks: [
        { ...checkRun(12, 'test', 'failure'), app: { id: 2 }, check_suite: { id: 10 } },
        { ...checkRun(13, 'test', 'success'), app: { id: 3 }, check_suite: { id: 10 } },
      ],
      statuses: [],
    },
    {
      scenario: '同一 app 在不同 suite 发布同名 check-run',
      checks: [
        { ...checkRun(12, 'test', 'failure'), app: { id: 3 }, check_suite: { id: 10 } },
        { ...checkRun(13, 'test', 'success'), app: { id: 3 }, check_suite: { id: 11 } },
      ],
      statuses: [],
    },
    {
      scenario: 'combined status 重复同一个上下文',
      checks: [checkRun(12, 'test', 'success')],
      statuses: [
        { id: 21, context: 'test', state: 'failure' },
        { id: 22, context: 'test', state: 'success' },
      ],
    },
  ])('$scenario 时两条观察路径都拒绝证据', async ({ checks, statuses }) => {
    ciRoutes({ checks, statuses })
    const gh = provider()
    const conflict = { ok: false, error: { kind: 'CONFLICT' } }
    expect(await gh.observeRequiredChecks(input)).toMatchObject(conflict)
    expect(await gh.observeCi(CI_INPUT)).toMatchObject(conflict)
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
