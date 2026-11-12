import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { createConsoleHandler } from './console.js'

const token = 'console-database-test-token'
let taskId: string

beforeEach(async () => {
  taskId = randomUUID()
  await asOwner(async (client) => {
    await client.query('TRUNCATE repo CASCADE')
    const repoId = randomUUID()
    await client.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/console-db','main')`,
      [repoId],
    )
    await client.query(
      `INSERT INTO task (id, title, status, repo_id, base_branch, work_branch)
       VALUES ($1,'真实数据库面板验收','S-NEW',$2,'main','ai/console-db')`,
      [taskId, repoId],
    )
  })
})

afterAll(closePool)

async function withConsole(
  use: (api: (path: string, body?: unknown) => Promise<Response>) => Promise<void>,
) {
  const handler = createConsoleHandler({
    query: (sql, params) =>
      asRole('keel_control', async (client) => (await client.query(sql, [...params])).rows),
    auth: { password: 'console-database-test-password' },
    token,
  })
  const server = createServer((request, response) => {
    handler(request, response).catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('未监听 HTTP 端口')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keel-console': token },
      body: JSON.stringify({ password: 'console-database-test-password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    await use((path, body) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-keel-console': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('控制台真实 PostgreSQL 与 HTTP', () => {
  it('仅 RUNNING 轮次关联遥测，空遥测和非运行轮次返回 null', async () => {
    const runIds = [randomUUID(), randomUUID(), randomUUID()]
    await asOwner(async (client) => {
      for (const [index, status] of ['RUNNING', 'SUCCEEDED', 'PENDING'].entries()) {
        await client.query(
          `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
           VALUES ($1,$2,'pm','PM',$3,$4,$5)`,
          [runIds[index], taskId, index + 1, status, `${taskId}/pm/${index + 1}`],
        )
        await client.query(
          `INSERT INTO run_liveness (run_id, last_progress_at, silence_ms, owner_heartbeat_at)
           VALUES ($1,'2026-11-12T08:00:00Z',300000,'2026-11-12T08:00:01Z')`,
          [runIds[index]],
        )
      }
    })
    await withConsole(async (api) => {
      const response = await api(`/api/tasks/${taskId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        runs: {
          status: string
          liveness: {
            last_progress_at: string
            silence_threshold_ms: number
            owner_heartbeat_at: string
          } | null
        }[]
      }
      const live = body.runs.find((run) => run.status === 'RUNNING')?.liveness
      expect(live?.silence_threshold_ms).toBe(300000)
      expect(Date.parse(live?.last_progress_at ?? '')).toBe(Date.parse('2026-11-12T08:00:00Z'))
      expect(Date.parse(live?.owner_heartbeat_at ?? '')).toBe(Date.parse('2026-11-12T08:00:01Z'))
      expect(body.runs.find((run) => run.status === 'SUCCEEDED')?.liveness).toBeNull()
      expect(body.runs.find((run) => run.status === 'PENDING')?.liveness).toBeNull()
      await asOwner((client) =>
        client.query('DELETE FROM run_liveness WHERE run_id=$1', [runIds[0]]),
      )
      const missing = (await (await api(`/api/tasks/${taskId}`)).json()) as typeof body
      expect(missing.runs.find((run) => run.status === 'RUNNING')?.liveness).toBeNull()
    })
  })

  it('真实写入口完成暂停、恢复、接管、带 A-State 交还，过期请求返回 409', async () => {
    await withConsole(async (api) => {
      const path = `/api/tasks/${taskId}/control`
      expect((await api(path, { action: 'pause', expected_mode: 'auto' })).status).toBe(200)
      expect((await api(path, { action: 'takeover', expected_mode: 'auto' })).status).toBe(409)
      expect((await api(path, { action: 'resume', expected_mode: 'paused' })).status).toBe(200)
      expect((await api(path, { action: 'takeover', expected_mode: 'auto' })).status).toBe(200)
      expect((await api(path, { action: 'resume', expected_mode: 'human' })).status).toBe(409)
      expect(
        (
          await api(path, {
            action: 'resume',
            expected_mode: 'human',
            note: '人工核对，无阶段完成。',
          })
        ).status,
      ).toBe(200)
      const detail = (await (await api(`/api/tasks/${taskId}`)).json()) as {
        task: { status: string; control_mode: string }
        artifacts: { kind: string; body: { confirmed_facts: { text: string }[] } }[]
        events: { type: string }[]
      }
      expect(detail.task).toMatchObject({ status: 'S-NEW', control_mode: 'auto' })
      expect(detail.artifacts[0]?.body.confirmed_facts[0]?.text).toBe('人工核对，无阶段完成。')
      expect(detail.events.filter((event) => event.type === 'ControlModeChanged')).toHaveLength(4)
    })
  })
})
