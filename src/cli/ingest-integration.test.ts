/**
 * ingest-issue 集成测试 —— AC1–AC4。
 *
 * GitHub 侧用 stub HTTP server(与 github-provider.test.ts 同模式),数据库是真库:
 * 「零写入」这类断言只有在真库上才有意义。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asOwner, closePool } from '../fact/db.js'
import { GitHubProvider } from '../fact/github-provider.js'
import { ingestIssue } from './ingest-issue.js'
import { registerRepoMain } from './register-repo.js'

const NOW = '2026-08-27T12:00:00Z'
const ISSUE_URL = 'https://github.com/acme/widget/issues/42'
const REMOTE = 'https://github.com/acme/widget.git'

interface IssuePayload {
  number: number
  title: string
  body: string | null
  state: string
  labels: { name: string }[]
  pull_request?: unknown
}

const OPEN_LABELED: IssuePayload = {
  number: 42,
  title: 'Add date filter to export',
  body: 'Users need to filter exports by date range.',
  state: 'open',
  labels: [{ name: 'keel' }],
}

let server: Server
let baseUrl: string
/** 每个用例可改写 stub 返回的 Issue,不必重开 server */
let issuePayload: IssuePayload

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )

  issuePayload = { ...OPEN_LABELED }
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(issuePayload))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterAll(closePool)

function github(): GitHubProvider {
  return new GitHubProvider({ apiRoot: baseUrl, token: 'test' })
}

async function countRows(table: 'feedback' | 'task'): Promise<number> {
  const r = await asOwner((c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
  return Number(r.rows[0]?.n ?? 0)
}

describe('ingest-issue 集成', () => {
  it('AC1: ingest 产生 github feedback + S-NEW task + T-001 SideEffectApplied', async () => {
    await registerRepoMain([REMOTE])

    const result = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.created).toBe(true)

    const task = await asOwner((c) =>
      c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [result.value.taskId]),
    )
    expect(task.rows[0]?.status).toBe('S-NEW')

    const fb = await asOwner((c) =>
      c.query<{ source: string; external_ref: string }>(
        'SELECT source, external_ref FROM feedback WHERE id = $1',
        [result.value.feedbackId],
      ),
    )
    expect(fb.rows[0]?.source).toBe('github')
    expect(fb.rows[0]?.external_ref).toBe('acme/widget#42')

    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: unknown }>(
        `SELECT type, payload FROM event WHERE task_id = $1 ORDER BY seq`,
        [result.value.taskId],
      ),
    )
    const applied = evs.rows.filter((e) => e.type === 'SideEffectApplied')
    expect(applied.length).toBe(2)
    expect(applied.some((e) => (e.payload as { kind: string }).kind === 'CreateTask')).toBe(true)
    expect(applied.some((e) => (e.payload as { kind: string }).kind === 'LinkFeedback')).toBe(true)
    // AC1 要求以 Applied 而非 Intent 落账
    expect(evs.rows.some((e) => e.type === 'SideEffectIntent')).toBe(false)

    const tsc = evs.rows.find((e) => e.type === 'TaskStatusChanged')
    expect(tsc).toBeDefined()
    if (tsc === undefined) return
    expect((tsc.payload as { transition: string }).transition).toBe('T-001')
  })

  it('AC2: 重复 ingest 返回既有 taskId,不产生第二条 feedback/task', async () => {
    await registerRepoMain([REMOTE])
    const first = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    const second = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.value.taskId).toBe(first.value.taskId)
    expect(second.value.feedbackId).toBe(first.value.feedbackId)
    expect(second.value.created).toBe(false)
    expect(await countRows('task')).toBe(1)
    expect(await countRows('feedback')).toBe(1)
  })

  it('AC3: 无目标 label → 拒绝且零写入', async () => {
    await registerRepoMain([REMOTE])
    issuePayload = { ...OPEN_LABELED, labels: [] }

    const r = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('PERMISSION_DENIED')
    expect(r.error.detail).toMatch(/label/)
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })

  it('AC3: label 名不匹配 --label → 拒绝且零写入', async () => {
    await registerRepoMain([REMOTE])
    issuePayload = { ...OPEN_LABELED, labels: [{ name: 'bug' }] }

    const r = await ingestIssue({
      issueUrl: ISSUE_URL,
      label: 'keel',
      github: github(),
      now: NOW,
    })
    expect(r.ok).toBe(false)
    expect(await countRows('feedback')).toBe(0)
  })

  it('AC3: pull_request 型条目 → 拒绝且零写入', async () => {
    await registerRepoMain([REMOTE])
    issuePayload = {
      ...OPEN_LABELED,
      pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
    }

    const r = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toMatch(/Pull Request/)
    expect(await countRows('feedback')).toBe(0)
    expect(await countRows('task')).toBe(0)
  })

  it('AC3: 已关闭 Issue → 拒绝且零写入', async () => {
    await registerRepoMain([REMOTE])
    issuePayload = { ...OPEN_LABELED, state: 'closed' }

    const r = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toMatch(/关闭/)
    expect(await countRows('feedback')).toBe(0)
  })

  it('repo 未注册 → NOT_FOUND 且零写入(提示先 register-repo)', async () => {
    const r = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
    expect(r.error.detail).toMatch(/register-repo/)
    expect(await countRows('feedback')).toBe(0)
  })

  it('register-repo 幂等:同一 remote(带/不带 .git)只注册一次', async () => {
    await registerRepoMain([REMOTE])
    await registerRepoMain(['https://github.com/acme/widget'])
    const n = await asOwner((c) => c.query<{ n: string }>('SELECT count(*) AS n FROM repo'))
    expect(Number(n.rows[0]?.n)).toBe(1)
  })

  it('AC4: ingest 出的 task 不经 seed SQL,既有 T-002 路径不回归', async () => {
    await registerRepoMain([REMOTE])
    const ingested = await ingestIssue({ issueUrl: ISSUE_URL, github: github(), now: NOW })
    expect(ingested.ok).toBe(true)
    if (!ingested.ok) return

    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    const adv = await driver.advance(ingested.value.taskId, { type: 'Dispatch' }, NOW)
    expect(adv.ok && adv.value.advanced).toBe(true)
    if (!adv.ok || !adv.value.advanced) return
    expect(adv.value.transition_id).toBe('T-002')
    expect(adv.value.to).toBe('S-PM_ANALYZING')
  })
})
