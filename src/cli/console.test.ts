/**
 * 控制台端点的行为测试。
 *
 * 用注入的假 query 起一个真实 http server —— 验证路由 / 状态码 / JSON 形状，
 * 不依赖 Postgres。真实数据库的那一段由 `pnpm run console` 手工验证
 * （与 CLI 的 status / timeline 对账），不在默认单测里连库。
 */

import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createConsoleHandler, type QueryFn, type Row } from './console.js'

const TASK_ID = '1d891a16-be91-4763-8333-38edd182a824'

async function withServer(query: QueryFn, fn: (base: string) => Promise<void>): Promise<void> {
  const handler = createConsoleHandler({ query })
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function fakeQuery(rows: {
  tasks?: readonly Row[]
  task?: readonly Row[]
  runs?: readonly Row[]
  events?: readonly Row[]
  artifacts?: readonly Row[]
  feedbacks?: readonly Row[]
  timers?: readonly Row[]
}): QueryFn {
  return async (sql: string) => {
    if (sql.includes('FROM task t JOIN repo r') && sql.includes('WHERE t.id = $1')) {
      return rows.task ?? []
    }
    if (sql.includes('FROM task t JOIN repo r')) return rows.tasks ?? []
    if (sql.includes('FROM run')) return rows.runs ?? []
    if (sql.includes('FROM event')) return rows.events ?? []
    if (sql.includes('FROM artifact')) return rows.artifacts ?? []
    if (sql.includes('FROM task_feedback')) return rows.feedbacks ?? []
    if (sql.includes('FROM timer')) return rows.timers ?? []
    return []
  }
}

describe('keel console', () => {
  it('GET / 返回页面', async () => {
    await withServer(fakeQuery({}), async (base) => {
      const res = await fetch(`${base}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('Keel')
      expect(html).toContain('OBSERVATORY')
      expect(html).toContain('kpi-strip')
      expect(html).toContain('task-search')
      expect(html).toContain('status-filters')
    })
  })

  it('GET /api/tasks 返回任务列表', async () => {
    const tasks: Row[] = [
      { id: TASK_ID, title: 'demo', status: 'S-DONE', control_mode: 'auto', repo: 'file:///tmp/x' },
    ]
    await withServer(fakeQuery({ tasks }), async (base) => {
      const res = await fetch(`${base}/api/tasks`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tasks: Row[] }
      expect(body.tasks).toHaveLength(1)
      expect(body.tasks[0]?.title).toBe('demo')
    })
  })

  it('GET /api/tasks/:id 组装 task / runs / events / artifacts / feedbacks / timers', async () => {
    const query = fakeQuery({
      task: [{ id: TASK_ID, title: 'demo', status: 'S-DONE' }],
      runs: [{ stage: 'pm', attempt: 1, status: 'SUCCEEDED' }],
      events: [{ seq: 1, type: 'TaskCreated', payload: {} }],
      artifacts: [{ kind: 'rfc', key: '', version: 1, body: {} }],
      feedbacks: [{ id: 'f1', source: 'github_issue', external_ref: 'o/r#1', body: '需求正文' }],
      timers: [{ id: 't1', kind: 'gate_timeout', state: 'PENDING' }],
    })
    await withServer(query, async (base) => {
      const res = await fetch(`${base}/api/tasks/${TASK_ID}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        task: Row
        runs: Row[]
        events: Row[]
        artifacts: Row[]
        feedbacks: Row[]
        timers: Row[]
      }
      expect(body.task.id).toBe(TASK_ID)
      expect(body.runs).toHaveLength(1)
      expect(body.events).toHaveLength(1)
      expect(body.artifacts).toHaveLength(1)
      expect(body.feedbacks).toHaveLength(1)
      expect(body.feedbacks[0]?.source).toBe('github_issue')
      expect(body.timers).toHaveLength(1)
      expect(body.timers[0]?.kind).toBe('gate_timeout')
    })
  })

  it('不存在的 task 返回 404，而不是空数据', async () => {
    await withServer(fakeQuery({ task: [] }), async (base) => {
      const res = await fetch(`${base}/api/tasks/${TASK_ID}`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('task not found')
    })
  })

  it('非法 task id 返回 404', async () => {
    await withServer(fakeQuery({}), async (base) => {
      const res = await fetch(`${base}/api/tasks/not-a-uuid`)
      expect(res.status).toBe(404)
    })
  })

  it('写方法被拒绝（只读）', async () => {
    await withServer(fakeQuery({}), async (base) => {
      const res = await fetch(`${base}/api/tasks`, { method: 'POST' })
      expect(res.status).toBe(405)
    })
  })

  it('数据库不可用时 /healthz 返回 503', async () => {
    const broken: QueryFn = async () => {
      throw new Error('connection refused')
    }
    await withServer(broken, async (base) => {
      const res = await fetch(`${base}/healthz`)
      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('connection refused')
    })
  })
})
