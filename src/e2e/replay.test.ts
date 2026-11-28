import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it, onTestFinished } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type { HarnessAdapter } from '../contracts/harness-adapter.js'
import type { ManagedTicketStageRunner } from '../contracts/managed.js'
import type { ProjectVerificationRunner } from '../contracts/project-verification.js'
import { ZERO_USAGE } from '../contracts/types.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runActionGatewayOnce } from '../control/managed/action-gateway.js'
import { runCheckGatewayOnce } from '../control/managed/check-gateway.js'
import {
  answerCheckReobservation,
  requestCheckReobservation,
} from '../control/managed/check-recovery.js'
import { listCheckEvidence } from '../control/managed/check-store.js'
import { recordDelegationPolicy } from '../control/managed/decision-store.js'
import { fixtureRoutePackage, fixtureRoutePlan } from '../control/managed/route-test-utils.js'
import { listManagedTicketStages } from '../control/managed/ticket-store.js'
import { diffDigest } from '../control/managed/ticket-workspace.js'
import {
  commitManagedWorkflowPlan,
  createManagedWorkflow,
  getManagedWorkflowProjection,
  type ManagedWorkflowWorker,
  tickManagedWorkflow,
} from '../control/managed/workflow-runtime.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'
import { GitCliPushGateway } from '../fact/git-push.js'
import { branchFor, GitWorkspace } from '../fact/git-workspace.js'
import { GitHubProvider } from '../fact/github-provider.js'
import type { ManagedTicketStageResult, RepoVerificationContract } from '../generated/managed.js'
import { listenTestServer } from '../test-support/http-server.js'
import { summarizeReliability } from '../test-support/reliability-metrics.js'

const repoUrl = 'https://github.example.test/acme/replay'
const apiRepo = '/api/v3/repos/acme/replay'
const prNumber = 7
const prUrl = `${repoUrl}/pull/${prNumber}`
const runId = 42
const suiteId = 11
const window = { start: '2026-08-23T00:00:00Z', end: '2026-08-24T00:00:00Z' }
const now = '2026-08-23T13:00:00Z'
const token = 'replay-fixture-token'

const unexpectedSession = async (): Promise<never> => {
  throw new Error('已绑定 PR 的 CI 回放不应启动 Harness')
}
const adapter: HarnessAdapter = {
  describe: () => ({
    harness_id: 'replay',
    version: '0',
    tier: 'L0',
    capabilities: [],
    cost_basis: 'unavailable',
    limits: { max_input_bytes: null, max_wall_clock_s: null },
  }),
  startRun: unexpectedSession,
  awaitResult: unexpectedSession,
  collectChanges: unexpectedSession,
  interrupt: unexpectedSession,
  dispose: unexpectedSession,
}

function check(headSha: string, id: number, conclusion: 'failure' | 'success' | null) {
  return {
    id,
    name: 'verify',
    head_sha: headSha,
    status: conclusion === null ? 'in_progress' : 'completed',
    conclusion,
    app: { id: 17, slug: 'github-actions' },
    check_suite: { id: suiteId },
  }
}

type Check = ReturnType<typeof check>
type StatusFault = 401 | 429 | 'disconnect'
type CommitStatus = { id: number; context: string; state: 'success' | 'failure' }

async function githubFixture(headSha: string, branch: string) {
  const pr = { headSha, mergeSha: null as string | null }
  const checks = new Map<string, Check[]>()
  const statuses = new Map<string, CommitStatus[]>()
  const statusFaults: StatusFault[] = []
  const statusReads: string[] = []
  const unexpectedRequests: string[] = []
  let moveHeadOnStatus: string | undefined
  let posts = 0
  let disconnectRerun = false
  let actions: { attempt: number; current: Check } | undefined
  const actionsPath = `${apiRepo}/actions/runs`
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.test')
    const path = url.pathname
    const reply = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      unexpectedRequests.push(`${req.method} ${path} 缺少夹具鉴权`)
      return reply({}, 401)
    }
    if (
      req.method === 'GET' &&
      path === `${apiRepo}/pulls` &&
      url.searchParams.get('head') === `acme:${branch}`
    ) {
      return reply([{ number: prNumber, html_url: prUrl }])
    }
    if (req.method === 'GET' && path === `${apiRepo}/pulls/${prNumber}`) {
      return reply({
        number: prNumber,
        html_url: prUrl,
        state: pr.mergeSha === null ? 'open' : 'closed',
        merged: pr.mergeSha !== null,
        merged_at: pr.mergeSha === null ? null : now,
        closed_at: pr.mergeSha === null ? null : now,
        merge_commit_sha: pr.mergeSha,
        head: { sha: pr.headSha, ref: branch },
        base: { ref: 'main' },
      })
    }

    const commit = path.slice(`${apiRepo}/commits/`.length)
    const [sha, endpoint] = commit.split('/')
    if (req.method === 'GET' && path.startsWith(`${apiRepo}/commits/`) && sha !== undefined) {
      if (endpoint === 'check-runs') {
        const all = checks.get(sha) ?? []
        const visible = url.searchParams.get('filter') === 'all' ? all : all.slice(-1)
        return reply({ total_count: visible.length, check_runs: visible })
      }
      if (endpoint === 'status' || endpoint === 'statuses') {
        statusReads.push(sha)
        if (moveHeadOnStatus !== undefined) {
          pr.headSha = moveHeadOnStatus
          moveHeadOnStatus = undefined
        }
        const fault = statusFaults.shift()
        if (fault === 'disconnect') return req.socket.destroy()
        if (fault !== undefined) return reply({}, fault)
        const posted = statuses.get(sha) ?? []
        if (endpoint === 'statuses') return reply(posted)
        return reply({
          sha,
          total_count: posted.length,
          state: posted.length === 0 ? 'pending' : 'success',
          statuses: posted,
        })
      }
    }

    if (actions !== undefined) {
      const { current, attempt } = actions
      const workflow = {
        id: runId,
        head_sha: current.head_sha,
        check_suite_id: suiteId,
        run_attempt: attempt,
        status: current.status,
        conclusion: current.conclusion,
        event: 'pull_request',
        pull_requests: [{ number: prNumber, head: { sha: current.head_sha } }],
      }
      const job = {
        name: current.name,
        head_sha: current.head_sha,
        check_run_url: `${repoUrl}/check-runs/${current.id}`,
        run_id: runId,
        run_attempt: attempt,
        status: current.status,
        conclusion: current.conclusion,
        steps: [{ name: 'Run Vitest', conclusion: current.conclusion }],
      }
      if (req.method === 'GET' && path === actionsPath) {
        const runs = url.searchParams.get('head_sha') === current.head_sha ? [workflow] : []
        return reply({ total_count: runs.length, workflow_runs: runs })
      }
      if (req.method === 'GET' && path === `${actionsPath}/${runId}`) return reply(workflow)
      if (
        req.method === 'GET' &&
        (path === `${actionsPath}/${runId}/jobs` ||
          path === `${actionsPath}/${runId}/attempts/${attempt}/jobs`)
      ) {
        return reply({ total_count: 1, jobs: [job] })
      }
      if (req.method === 'POST' && path === `${actionsPath}/${runId}/rerun-failed-jobs`) {
        posts++
        if (disconnectRerun) return req.socket.destroy()
        return reply({}, 201)
      }
    }
    if (req.method === 'GET' && path === actionsPath)
      return reply({ total_count: 0, workflow_runs: [] })

    unexpectedRequests.push(`${req.method} ${url.pathname}${url.search}`)
    return reply({}, 404)
  })
  const http = await listenTestServer(server)
  onTestFinished(async () => {
    await http.close()
    expect(unexpectedRequests).toEqual([])
  })
  return {
    provider: new GitHubProvider({
      token,
      apiRoot: `${http.baseUrl}/api/v3`,
      fetchFn: http.fetch,
    }),
    pr,
    checks,
    statuses,
    statusFaults,
    statusReads,
    rerunPosts: () => posts,
    disconnectOnRerun: () => {
      disconnectRerun = true
    },
    raceHeadTo: (sha: string) => {
      moveHeadOnStatus = sha
    },
    publishActions: (attempt: number, current: Check, history: Check[] = []) => {
      actions = { attempt, current }
      checks.set(current.head_sha, [...history, current])
    },
  }
}

function temporaryReplayRoot() {
  const root = mkdtempSync(join(tmpdir(), 'keel-replay-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function gitAt(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Keel Replay',
      '-c',
      'user.email=replay@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim()
}

function requireOk<Value>(result: Result<Value>): Value {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.detail}`)
  return result.value
}

async function seedReplay() {
  const root = temporaryReplayRoot()
  const taskId = randomUUID()
  const repoId = randomUUID()
  const branch = branchFor(taskId)
  const gitCommand = (args: string[]) => gitAt(root, args)
  gitCommand(['init', '-b', 'main'])
  gitCommand(['commit', '--allow-empty', '-m', 'base'])
  const oldSha = gitCommand(['rev-parse', 'HEAD'])
  gitCommand(['switch', '-c', branch])
  gitCommand(['commit', '--allow-empty', '-m', 'head'])
  const headSha = gitCommand(['rev-parse', 'HEAD'])
  gitCommand(['switch', 'main'])
  gitCommand(['merge', '--no-ff', '-m', 'merge replay PR', branch])
  const mergeSha = gitCommand(['rev-parse', 'HEAD'])

  const git = new GitWorkspace({ root: join(root, 'workspace') })
  const prepared = await git.prepareProject(
    { mode: 'managed', repoId },
    pathToFileURL(root).href,
    'main',
  )
  if (!prepared.ok) throw new Error(prepared.error.detail)
  const project = prepared.value
  const http = await githubFixture(headSha, branch)
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'github',$2,'main')`,
      [repoId, repoUrl],
    )
    await client.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch, created_at)
       VALUES ($1,'S-PR_OPEN','故障回放',$2,'main',$3,$4)`,
      [taskId, repoId, branch, window.start],
    )
    await client.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key, started_at, ended_at)
       VALUES ($1,$2,'develop','DEV',1,'SUCCEEDED',$3,$4,$4)`,
      [randomUUID(), taskId, `${taskId}/develop/1`, window.start],
    )
    await client.query(
      `INSERT INTO event (task_id, type, payload, occurred_at)
       VALUES ($1,'SideEffectApplied',$2,$3)`,
      [
        taskId,
        {
          kind: 'CreatePullRequest',
          dedupe_key: branch,
          pr_number: prNumber,
          pr_url: prUrl,
          head_branch: branch,
        },
        window.start,
      ],
    )
  })
  const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
    git,
    repoId,
    project,
  })
  const drive = () =>
    runTaskToCompletion(
      taskId,
      {
        driver,
        sessions: new HarnessSessionManager(),
        adapter,
        workspace: { mode: 'worktree', git, repoId, project },
        now: () => now,
      },
      { ci: http.provider, pullRequests: http.provider },
    )
  const readEvidence = () =>
    asOwner(async (client) => {
      const task = await client.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [
        taskId,
      ])
      const runs = await client.query<{
        id: string
        stage: string
        attempt: number
        status: string
        started_at: Date | null
        tokens_in: string | null
        tokens_out: string | null
      }>(
        `SELECT id, stage, attempt, status, started_at, tokens_in, tokens_out
         FROM run WHERE task_id=$1 ORDER BY stage, attempt`,
        [taskId],
      )
      const events = await client.query<{
        kind: string
        occurred_at: Date
        payload: {
          head_sha?: string
          merge_sha?: string
          failure_key?: string
        }
      }>(
        `SELECT COALESCE(payload->>'event', type) AS kind, payload, occurred_at
         FROM event
         WHERE task_id=$1 AND (type IN ('CiRerunClaimed','CiRerunUnconfirmed','TaskStatusChanged')
           OR payload->>'event' IN ('HumanApproved','HumanRejected','HumanRequestedRework'))
         ORDER BY seq`,
        [taskId],
      )
      const row = task.rows[0]
      if (row === undefined) throw new Error('回放任务不存在')
      return { task: row, runs: runs.rows, events: events.rows }
    })
  return { taskId, repoId, oldSha, headSha, mergeSha, http, drive, readEvidence }
}

afterAll(closePool)

const waitingForCi = {
  ok: true,
  value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
}
const waitingForMerge = {
  ok: true,
  value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-pr-merge' },
}

it('旧 SHA 红、当前 SHA 未上报，当前 SHA 的 Actions 重跑转绿后等到绑定 PR 合并', async () => {
  const replay = await seedReplay()
  const { http, oldSha, headSha, mergeSha } = replay
  http.checks.set(oldSha, [check(oldSha, 90, 'failure')])
  expect(await replay.drive()).toMatchObject(waitingForCi)
  expect((await replay.readEvidence()).events).toEqual([])

  const failed = check(headSha, 101, 'failure')
  http.publishActions(1, failed)
  expect(await replay.drive()).toMatchObject(waitingForCi)
  expect(await replay.drive()).toMatchObject(waitingForCi)
  expect(http.rerunPosts()).toBe(1)
  const claimed = (await replay.readEvidence()).events
  expect(claimed).toMatchObject([
    {
      kind: 'CiRerunClaimed',
      payload: { head_sha: headSha, pr_number: prNumber, run_id: runId, attempt: 1 },
    },
  ])

  http.publishActions(2, check(headSha, 102, null), [failed])
  expect(await replay.drive()).toMatchObject(waitingForCi)
  expect((await replay.readEvidence()).events).toEqual(claimed)
  http.publishActions(2, check(headSha, 102, 'success'), [failed])
  expect(await replay.drive()).toMatchObject(waitingForMerge)
  expect(await replay.drive()).toMatchObject(waitingForMerge)
  expect((await replay.readEvidence()).task.status).toBe('S-PR_OPEN')

  http.pr.mergeSha = mergeSha
  expect(await replay.drive()).toMatchObject({
    ok: true,
    value: { finalStatus: 'S-DONE', stopReason: 'terminal' },
  })
  const { task, runs, events } = await replay.readEvidence()
  expect(task.status).toBe('S-DONE')
  expect(runs).toMatchObject([{ stage: 'develop', attempt: 1, status: 'SUCCEEDED' }])
  expect(events).toMatchObject([
    { kind: 'CiRerunClaimed', payload: { head_sha: headSha, failure_key: expect.any(String) } },
    { kind: 'CIPassed', payload: { source: 'github', head_sha: headSha, transition: 'T-042' } },
    { kind: 'PRMerged', payload: { merge_sha: mergeSha, merged_at: now } },
  ])
  expect(new Set(http.statusReads)).toEqual(new Set([headSha]))
  expect(http.rerunPosts()).toBe(1)

  const [red, green, merged] = events
  if (red === undefined || green === undefined || merged === undefined || !red.payload.failure_key)
    throw new Error('回放缺少 CI 恢复或 PR 合并证据')
  const claimedAt = runs[0]?.started_at
  if (!claimedAt) throw new Error('回放缺少初次 develop 认领时间')
  const remote = await http.provider.getPullRequest({
    repoId: replay.repoId,
    remoteUrl: repoUrl,
    number: prNumber,
  })
  const humanIntervened = events.some(({ kind }) =>
    ['HumanApproved', 'HumanRejected', 'HumanRequestedRework'].includes(kind),
  )
  const summary = summarizeReliability(window, [
    {
      taskId: replay.taskId,
      claimedAt: claimedAt.toISOString(),
      deliveredAt: merged.occurred_at.toISOString(),
      humanIntervened,
      attempts: runs.flatMap((run) =>
        run.started_at === null
          ? []
          : [
              {
                id: run.id,
                startedAt: run.started_at.toISOString(),
                repeatedWithoutProgress: run.attempt === 1 ? false : null,
                tokensIn: run.tokens_in === null ? null : Number(run.tokens_in),
                tokensOut: run.tokens_out === null ? null : Number(run.tokens_out),
              },
            ],
      ),
      incidents: [
        {
          key: red.payload.failure_key,
          failedAt: red.occurred_at.toISOString(),
          recoveredAt: green.occurred_at.toISOString(),
          sameTarget:
            red.payload.head_sha === undefined || green.payload.head_sha === undefined
              ? null
              : red.payload.head_sha === green.payload.head_sha,
          extraCodeAttempts: runs.filter(({ stage, attempt }) => stage === 'develop' && attempt > 1)
            .length,
          humanIntervened,
        },
      ],
      approvals: [],
      terminal: {
        at: merged.occurred_at.toISOString(),
        remoteAgreement:
          !remote.ok || remote.value.mergeSha === null || merged.payload.merge_sha === undefined
            ? null
            : task.status === 'S-DONE' &&
              remote.value.state === 'closed' &&
              remote.value.merged &&
              remote.value.mergeSha === merged.payload.merge_sha,
      },
    },
  ])
  expect(summary).toMatchObject({
    deliveryWithoutIntervention: { numerator: 1, denominator: 1, unknown: 0 },
    externalCiRecoveryWithoutIntervention: { numerator: 1, denominator: 1, unknown: 0 },
    terminalRemoteAgreement: { numerator: 1, denominator: 1, unknown: 0 },
    taskTokens: [{ taskId: replay.taskId, tokens: null, knownTokens: 0, unknownAttempts: 1 }],
  })
})

it('限流与 Unix socket 断连在同一次驱动内重新观察，后续才记录当前 SHA 的绿灯', async () => {
  const replay = await seedReplay()
  replay.http.statusFaults.push(429, 'disconnect')
  expect(await replay.drive()).toMatchObject(waitingForCi)
  expect(replay.http.statusReads).toEqual(Array(3).fill(replay.headSha))
  expect((await replay.readEvidence()).events).toEqual([])

  replay.http.publishActions(1, check(replay.headSha, 101, 'success'))
  expect(await replay.drive()).toMatchObject(waitingForMerge)
  const { events, runs } = await replay.readEvidence()
  expect(events).toMatchObject([{ kind: 'CIPassed', payload: { head_sha: replay.headSha } }])
  expect(runs).toMatchObject([{ stage: 'develop', attempt: 1 }])
  expect(replay.http.rerunPosts()).toBe(0)
})

it('重跑响应丢失后并发驱动只 POST 一次，持续失败等待人工且保留合并对账', async () => {
  const replay = await seedReplay()
  const { http, headSha, mergeSha } = replay
  const first = check(headSha, 101, 'failure')
  http.publishActions(1, first)
  http.disconnectOnRerun()
  await Promise.all([replay.drive(), replay.drive()])
  expect(http.rerunPosts()).toBe(1)
  const claimed = await replay.readEvidence()
  expect(claimed.events.filter(({ kind }) => kind === 'CiRerunClaimed')).toHaveLength(1)
  expect(claimed.events.filter(({ kind }) => kind === 'CiRerunUnconfirmed')).toHaveLength(1)
  expect(claimed.runs).toMatchObject([{ stage: 'develop', attempt: 1 }])

  http.publishActions(2, check(headSha, 102, 'failure'), [first])
  expect(await replay.drive()).toMatchObject({
    ok: true,
    value: { finalStatus: 'S-HUMAN_REVIEW' },
  })
  expect((await replay.readEvidence()).events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'CIFailed',
        payload: expect.objectContaining({ head_sha: headSha }),
      }),
    ]),
  )
  http.pr.mergeSha = mergeSha
  expect(await replay.drive()).toMatchObject({
    ok: true,
    value: { finalStatus: 'S-DONE', stopReason: 'terminal' },
  })
  expect(http.rerunPosts()).toBe(1)
  expect((await replay.readEvidence()).runs).toMatchObject([{ stage: 'develop', attempt: 1 }])
})

it.each([
  { faults: [401], error: 'AUTH_FAILED' },
  { faults: [429, 429, 429], error: 'HARNESS_UNAVAILABLE' },
] satisfies { faults: StatusFault[]; error: string }[])(
  '观测返回 $error 时保持绑定 PR 等待，且不派发 develop',
  async ({ faults, error }) => {
    const replay = await seedReplay()
    replay.http.statusFaults.push(...faults)
    expect(await replay.drive()).toMatchObject({ ok: false, error: { kind: error } })
    expect(replay.http.statusReads).toEqual(Array(faults.length).fill(replay.headSha))
    const { task, events, runs } = await replay.readEvidence()
    expect(task.status).toBe('S-PR_OPEN')
    expect(events).toEqual([])
    expect(runs).toMatchObject([{ stage: 'develop', attempt: 1 }])
    expect(replay.http.rerunPosts()).toBe(0)
  },
)

it('观测检查时 PR head 变化，旧 head 的绿灯不能写入持久事件', async () => {
  const replay = await seedReplay()
  const { http, headSha, oldSha } = replay
  http.publishActions(1, check(headSha, 101, 'success'))
  http.raceHeadTo(oldSha)
  expect(await replay.drive()).toMatchObject({ ok: false, error: { kind: 'CONFLICT' } })
  expect((await replay.readEvidence()).events).toEqual([])

  expect(await replay.drive()).toMatchObject(waitingForCi)
  http.publishActions(1, check(oldSha, 102, 'success'))
  expect(await replay.drive()).toMatchObject(waitingForMerge)
  const { events, runs } = await replay.readEvidence()
  expect(events).toMatchObject([{ kind: 'CIPassed', payload: { head_sha: oldSha } }])
  expect(runs).toMatchObject([{ stage: 'develop', attempt: 1 }])
  expect(http.rerunPosts()).toBe(0)
})

it('当前 SHA 的 API 返回旧 SHA 红灯时，拒绝取证且后续仍可转绿', async () => {
  const replay = await seedReplay()
  const { http, headSha, oldSha } = replay
  http.checks.set(headSha, [check(oldSha, 90, 'failure')])
  expect(await replay.drive()).toMatchObject({ ok: false, error: { kind: 'CONFLICT' } })
  expect(http.statusReads).toEqual([headSha, headSha, headSha])
  expect((await replay.readEvidence()).events).toEqual([])

  http.publishActions(1, check(headSha, 101, 'success'))
  expect(await replay.drive()).toMatchObject(waitingForMerge)
  const { events, runs } = await replay.readEvidence()
  expect(events).toMatchObject([{ kind: 'CIPassed', payload: { head_sha: headSha } }])
  expect(runs).toMatchObject([{ stage: 'develop', attempt: 1 }])
  expect(http.rerunPosts()).toBe(0)
})

const runMixedTicket: ManagedTicketStageRunner = async (input) => {
  const root = input.workspace_path
  const success = (
    output: Omit<ManagedTicketStageResult, 'schema_version' | 'status' | 'summary'>,
  ): Awaited<ReturnType<ManagedTicketStageRunner>> => ({
    ok: true,
    value: {
      output: { ...output, schema_version: '1.0', status: 'completed', summary: '混合栈回放' },
      usage: ZERO_USAGE,
    },
  })
  if (input.stage === 'execute') {
    writeFileSync(join(root, 'src/frontend.ts'), 'export const label = "updated"\n')
    writeFileSync(join(root, 'src/backend.py'), 'limit = 2\n')
    gitAt(root, ['add', 'src'])
    gitAt(root, ['commit', '-m', 'update frontend and backend'])
    const commit = gitAt(root, ['rev-parse', 'HEAD'])
    return success({ stage: 'execute', commit, worktree_head: commit })
  }
  const head = gitAt(root, ['rev-parse', 'HEAD'])
  if (input.stage === 'verify') throw new Error('固定的项目检查不应派发 Harness verify')
  if (input.stage === 'review') {
    const digest = requireOk(await diffDigest(root, input.baseline_commit, head))
    return success({
      stage: 'review',
      review: { reviewed_commit: head, diff_digest: digest, findings: [] },
    })
  }
  return success({
    stage: 'land',
    land: {
      branch: gitAt(root, ['branch', '--show-current']),
      commit: head,
      action_intent: {
        kind: 'push_and_pr',
        remote: 'origin',
        pr_title: '混合栈回放',
        pr_body: '验证双栈 required checks',
      },
    },
  })
}

it.each([false, true])(
  'managed 双栈验证与远端重观测绑定同一提交（遗漏本地后端证据=%s）',
  { timeout: 30_000 },
  async (omitBackend) => {
    await asOwner((client) =>
      client.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'),
    )
    const root = temporaryReplayRoot()
    const source = join(root, 'source')
    const remote = join(root, 'remote.git')
    mkdirSync(join(source, 'src'), { recursive: true })
    gitAt(root, ['init', '--bare', '-b', 'main', remote])
    gitAt(source, ['init', '-b', 'main'])
    writeFileSync(join(source, 'src/frontend.ts'), 'export const label = "initial"\n')
    writeFileSync(join(source, 'src/backend.py'), 'limit = 1\n')
    writeFileSync(join(source, 'AGENTS.md'), 'node -e "throw new Error(\'untrusted rule\')"\n')
    gitAt(source, ['add', 'src', 'AGENTS.md'])
    gitAt(source, ['commit', '-m', 'seed mixed repository'])

    const contract: RepoVerificationContract = {
      version: '1',
      checks: [
        {
          id: 'frontend-guard',
          kind: 'local',
          argv: [
            process.execPath,
            '-e',
            'if (!require("node:fs").readFileSync("src/frontend.ts","utf8").includes("updated")) process.exit(1); console.log("frontend verified")',
          ],
          paths: ['src'],
        },
        {
          id: 'backend-guard',
          kind: 'local',
          argv: [
            'python3',
            '-I',
            '-B',
            '-c',
            'import runpy; assert runpy.run_path("src/backend.py")["limit"] == 2; print("backend verified")',
          ],
          paths: ['src'],
        },
        { id: 'backend-ci', kind: 'remote', name: 'backend/tests', paths: ['src'] },
      ],
    }
    const repoId = randomUUID()
    await asOwner((client) =>
      client.query(
        `INSERT INTO repo (id,provider,remote_url,default_branch,local_path,verification_contract)
       VALUES ($1,'github',$2,'main',$3,$4)`,
        [repoId, repoUrl, source, JSON.stringify(contract)],
      ),
    )
    const approved = '2026-08-22T00:00:00Z'
    requireOk(
      await recordDelegationPolicy({
        schema_version: '1.0',
        id: randomUUID(),
        policy_id: 'replay-mixed-checks',
        version: 1,
        project_id: repoId,
        approved_by_owner: 'fixture-owner',
        approved_at: approved,
        valid_from: approved,
        created_at: approved,
        rules: [
          {
            id: 'push-pr',
            decision_kinds: ['approval'],
            actions: ['push_and_pr'],
            resource_selectors: ['*'],
            environments: ['production'],
            reversibility: 'reversible',
            impact_limits: {
              environments: ['production'],
              reversibilities: ['reversible'],
              max_affected_resources: 8,
            },
            budget_limits: {},
            required_evidence: [],
            required_checks: ['frontend/build'],
            mode: 'delegated',
          },
        ],
      }),
    )
    const packagePath = join(root, 'route-package.json')
    writeFileSync(packagePath, JSON.stringify(fixtureRoutePackage()))
    const workflowId = requireOk(
      await createManagedWorkflow(repoId, packagePath, '混合栈回放', {
        scopePaths: ['src'],
        worktreeRoot: join(root, 'worktrees'),
      }),
    )
    requireOk(await commitManagedWorkflowPlan(workflowId, fixtureRoutePlan('S', 1)))

    const verifiedLocally: string[] = []
    const verifyProject: ProjectVerificationRunner = async ({ workspace, checks }) => {
      expect(checks.map(({ id }) => id)).toEqual(['frontend-guard', 'backend-guard'])
      const local = contract.checks.filter((check) => check.kind === 'local')
      expect(checks.map(({ argv }) => argv)).toEqual(local.map(({ argv }) => argv))
      return ok(
        checks.slice(0, omitBackend ? 1 : checks.length).map(({ id, argv }) => {
          const [program, ...args] = argv
          const output = execFileSync(program, args, {
            cwd: workspace,
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          verifiedLocally.push(id)
          return { id, argv, exit_code: 0, output_excerpt: output.trim() }
        }),
      )
    }
    let remoteFacts: ManagedWorkflowWorker['pullRequests']
    const worker: ManagedWorkflowWorker = {
      harness: 'pi',
      toolInventory: [
        'read',
        'grep',
        'find',
        'ls',
        'edit',
        'write',
        'bash',
        'Agent',
        'web_search',
        'fetch_content',
      ],
      run: runMixedTicket,
      verifyProject,
    }
    const tick = async () =>
      requireOk(
        await tickManagedWorkflow(
          remoteFacts === undefined ? worker : { ...worker, pullRequests: remoteFacts },
          workflowId,
        ),
      )
    const projection = async () => requireOk(await getManagedWorkflowProjection(workflowId))
    for (let count = 0; count < 8; count += 1) {
      const result = await tick()
      if (result?.status === 'WAITING_GATEWAY' || result?.status === 'PAUSED' || result === null)
        break
    }
    const waiting = await projection()
    const ticketId = waiting.nodes[0]?.ticket_task_id
    if (!ticketId) throw new Error('混合栈 ticket 未创建')
    const stages = await listManagedTicketStages(ticketId)
    if (omitBackend) {
      expect(verifiedLocally).toEqual(['frontend-guard'])
      expect(stages.find(({ stage }) => stage === 'verify')?.status).toBe('FAILED')
      expect(stages.some(({ stage }) => stage === 'land')).toBe(false)
      expect(waiting.evidence.some(({ stage }) => stage === 'archive')).toBe(false)
      expect(gitAt(remote, ['for-each-ref', 'refs/heads'])).toBe('')
      return
    }
    expect(
      waiting.workflow.status,
      waiting.nodes[0]?.last_error ?? waiting.workflow.last_error ?? undefined,
    ).toBe('WAITING_GATEWAY')
    const node = waiting.nodes[0]
    if (node?.worktree_path == null || node.ticket_task_id === null)
      throw new Error('混合栈 ticket 未绑定工作区')
    const branch = gitAt(node.worktree_path, ['branch', '--show-current'])
    const headSha = gitAt(node.worktree_path, ['rev-parse', 'HEAD'])
    const baseline = gitAt(source, ['rev-parse', 'HEAD'])
    const http = await githubFixture(headSha, branch)
    remoteFacts = http.provider
    expect(verifiedLocally).toEqual(['frontend-guard', 'backend-guard'])
    expect(stages.find(({ stage }) => stage === 'verify')).toMatchObject({
      status: 'SUCCEEDED',
      input_commit: headSha,
      evidence: {
        project_verification: {
          required_check_ids: ['frontend-guard', 'backend-guard', 'backend-ci'],
          local: [
            { id: 'frontend-guard', exit_code: 0 },
            { id: 'backend-guard', exit_code: 0 },
          ],
        },
      },
    })
    const push = new GitCliPushGateway(null)
    const remoteUrl = pathToFileURL(remote).href
    const actionAt = new Date(Date.now() + 1_000).toISOString()
    const action = requireOk(
      await runActionGatewayOnce({
        now: () => actionAt,
        push: {
          push: (input) => push.push({ ...input, remoteUrl }),
          inspect: (input) => push.inspect({ ...input, remoteUrl }),
        },
        pullRequests: http.provider,
      }),
    )
    expect(action).toMatchObject({ status: 'SUCCEEDED', prNumber })
    expect(gitAt(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(headSha)

    const frontend = { id: 1, context: 'frontend/build', state: 'success' } satisfies CommitStatus
    const backend = { id: 2, context: 'backend/tests', state: 'success' } satisfies CommitStatus
    http.statuses.set(baseline, [backend])
    http.statuses.set(headSha, [frontend])
    const observe = async (offset: number) =>
      requireOk(
        await runCheckGatewayOnce({
          checks: http.provider,
          now: () => new Date(Date.parse(actionAt) + offset).toISOString(),
          pollIntervalMs: 1,
        }),
      )
    expect(await observe(1)).toMatchObject({ status: 'CHECKING', headSha, prNumber })
    await tick()
    expect((await projection()).evidence.some(({ stage }) => stage === 'archive')).toBe(false)
    const waitingChecks = await listCheckEvidence({ taskId: node.ticket_task_id })
    expect(waitingChecks[0]?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check_name: 'backend/tests',
          conclusion: 'missing',
          head_sha: headSha,
        }),
      ]),
    )

    http.statuses.set(headSha, [frontend, { ...backend, state: 'failure' }])
    expect(await observe(2)).toMatchObject({ status: 'FAILED', headSha, prNumber })
    expect(await tick()).toMatchObject({ status: 'PAUSED' })
    const targetId = waitingChecks[0]?.target.id
    if (!targetId) throw new Error('混合栈回放未建立远端检查目标')
    const recovery = requireOk(await requestCheckReobservation(targetId, new Date().toISOString()))
    const approval = {
      targetId,
      requestId: recovery.id,
      revision: recovery.revision,
      optionId: 'option-1',
    } as const
    expect(await answerCheckReobservation(approval, http.provider)).toMatchObject({
      ok: true,
      value: { status: 'CHECKING' },
    })
    expect(await answerCheckReobservation(approval, http.provider)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
    http.statuses.set(headSha, [frontend, { ...backend, id: 3 }])
    const ready = await observe(5_000)
    expect(ready).toMatchObject({
      status: 'READY',
      headSha,
      prNumber,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await tick()).toMatchObject({ status: 'DONE' })
    const archived = await projection()
    expect(archived.nodes).toMatchObject([{ status: 'ARCHIVED', output_commit: headSha }])
    expect(archived.evidence.filter(({ stage }) => stage === 'archive')).toMatchObject([
      {
        status: 'VALID',
        input_commit: headSha,
        result: { head_sha: headSha, ticket_status: 'PR_READY' },
        evidence: { pr: { evidence_digest: ready?.evidenceDigest } },
      },
    ])
    expect(new Set(http.statusReads)).toEqual(new Set([headSha]))
    expect(
      (await listManagedTicketStages(ticketId)).filter(({ stage }) => stage === 'execute'),
    ).toHaveLength(1)
  },
)
