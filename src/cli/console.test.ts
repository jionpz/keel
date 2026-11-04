/**
 * 控制台端点的行为测试。
 *
 * 用注入的假 query 起一个真实 http server —— 验证路由 / 状态码 / JSON 形状，
 * 不依赖 Postgres。真实数据库的那一段由 `pnpm run console` 手工验证
 * （与 CLI 的 status / timeline 对账），不在默认单测里连库。
 */

import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  type ConsoleActions,
  type ConsoleDeps,
  createConsoleHandler,
  type QueryFn,
  type Row,
} from './console.js'
import { CONSOLE_TOKEN_PLACEHOLDER } from './console-page.js'
import { DECISIONS } from './decide.js'

const TASK_ID = '1d891a16-be91-4763-8333-38edd182a824'
const TOKEN = 'test-token-0123456789abcdef'

async function withServer(
  deps: QueryFn | ConsoleDeps,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const handler = createConsoleHandler(typeof deps === 'function' ? { query: deps } : deps)
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

/** 记录调用的假写入口 —— 写端点只负责校验 + 转调，不复制状态机。 */
function fakeActions() {
  const calls: string[] = []
  const act: ConsoleActions = {
    async decide(taskId, decision, note) {
      calls.push(`decide ${taskId} ${decision} ${note ?? ''}`)
      return { status: 200, body: { ok: true, from: 'S-HUMAN_REVIEW', to: 'S-DEVELOPING' } }
    },
    async answer(taskId, text) {
      calls.push(`answer ${taskId} ${text}`)
      return { status: 200, body: { ok: true, from: 'S-NEED_CLARIFICATION', to: 'S-PM_ANALYZING' } }
    },
  }
  return { act, calls }
}

function action(
  base: string,
  verb: 'decide' | 'answer',
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/api/tasks/${TASK_ID}/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-keel-console': TOKEN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function fakeQuery(rows: {
  tasks?: readonly Row[]
  task?: readonly Row[]
  runs?: readonly Row[]
  events?: readonly Row[]
  artifacts?: readonly Row[]
  feedbacks?: readonly Row[]
  timers?: readonly Row[]
  statsDays?: readonly Row[]
  statsTotals?: readonly Row[]
}): QueryFn {
  return async (sql: string) => {
    if (sql.includes('WITH days AS')) return rows.statsDays ?? []
    if (sql.includes('AS tasks_done')) return rows.statsTotals ?? []
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
      expect(html).toContain('brand-bar')
      expect(html).toContain('mode-switch')
      expect(html).toContain('task-search')
      expect(html).toContain('status-filters')
      // 三个视图 + 底部状态栏是页面骨架的一部分，掉一个就是回归
      expect(html).toContain('data-mode="overview"')
      expect(html).toContain('data-mode="projects"')
      expect(html).toContain('id="statusbar"')
      // 项目页：按行动分组、待处理徽章、筛选项随列表 —— 掉一个就是回到指标仪表盘
      expect(html).toContain('需要你处理')
      expect(html).toContain('proj-attention')
      expect(html).toContain('proj-filters')
      expect(html).toContain('needsYou')
      expect(html).toContain("fetchJSON('/api/stats')")
      // 人工闸门提示条：可点的按钮 + 一行等价的 CLI 命令
      expect(html).toContain('human-callout')
      // 命令必须带上 `pnpm ` 前缀 —— 仓库里没有全局 `keel` 可执行文件，
      // 只写 `keel decide` 会让人复制到终端后得到 command not found
      expect(html).toContain('pnpm keel decide ')
      expect(html).toContain('pnpm keel answer ')
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

  it('非写端点的写方法仍被拒绝（405）', async () => {
    await withServer(fakeQuery({}), async (base) => {
      const res = await fetch(`${base}/api/tasks`, { method: 'POST' })
      expect(res.status).toBe(405)
    })
  })

  it('页面注入了本机令牌，模板占位符不残留', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const html = await (await fetch(`${base}/`)).text()
      expect(html).toContain(`name="keel-console-token" content="${TOKEN}"`)
      expect(html).not.toContain(CONSOLE_TOKEN_PLACEHOLDER)
      // 按钮是派发入口，光有命令不算数（按钮由 JS 拼出，只断言构建逻辑与令牌注入）
      expect(html).toContain("'approve'")
      expect(html).toContain("'reject'")
      expect(html).toContain("'rework'")
      expect(html).toContain("'answer'")
      expect(html).toContain('data-act=')
      expect(html).toContain("'x-keel-console'")
    })
  })

  it('决策页：给出「为什么停 / 在批什么 / 每个选项的后果」，不是一排按钮', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const html = await (await fetch(`${base}/`)).text()
      // 四块骨架
      expect(html).toContain('decision-page')
      expect(html).toContain('为什么停在这里')
      expect(html).toContain('这次决定依赖的事实')
      expect(html).toContain('同阶段轨迹')
      // 三种后果必须落到转移表的副作用上（T-014 / T-016 / T-015）
      expect(html).toContain('并派发 develop 第 ')
      expect(html).toContain('回到方案讨论')
      expect(html).toContain('S-REJECTED')
      expect(html).toContain('不可恢复')
      // 澄清闸门：问什么 + 不回答会怎样
      expect(html).toContain('在问什么')
      expect(html).toContain('不回答会怎样')
      expect(html).toContain('S-ABANDONED')
    })
  })

  it('决策页不用 window.prompt / window.confirm 拿输入', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const html = await (await fetch(`${base}/`)).text()
      expect(html).not.toContain('window.prompt(')
      expect(html).not.toContain('window.confirm(')
      // 理由内联在卡片里，按 data-note-for 取值
      expect(html).toContain('data-note-for=')
    })
  })

  it('选项 key 与 decide.ts 的 DECISIONS 完全一致，改一处不会漏掉另一处', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const html = await (await fetch(`${base}/`)).text()
      const keys = [...html.matchAll(/key: '([a-z]+)',\s*\n\s*title:/g)].map((m) => m[1])
      expect(new Set(keys)).toEqual(new Set(DECISIONS))
    })
  })

  it('决策 Tab 只在闸门状态注入，且闸门状态默认落在它上面', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const html = await (await fetch(`${base}/`)).text()
      expect(html).toContain('isGateStatus')
      expect(html).toContain("'S-HUMAN_REVIEW'")
      expect(html).toContain("'S-NEED_CLARIFICATION'")
      expect(html).toContain('data-tab="decision"')
      expect(html).toContain("if (gate && !state.tabChosen) tab = 'decision'")
    })
  })

  it('写端点：缺令牌 403', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      const res = await action(base, 'decide', { decision: 'approve' }, { 'x-keel-console': '' })
      expect(res.status).toBe(403)
    })
    expect(calls).toEqual([])
  })

  it('写端点：非 application/json 415（挡跨站简单请求）', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      const res = await action(base, 'decide', JSON.stringify({ decision: 'approve' }), {
        'content-type': 'text/plain',
      })
      expect(res.status).toBe(415)
    })
    expect(calls).toEqual([])
  })

  it('写端点：外站 Origin 403（DNS rebinding / 跨站）', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      const res = await action(
        base,
        'decide',
        { decision: 'approve' },
        { origin: 'https://evil.example' },
      )
      expect(res.status).toBe(403)
    })
    expect(calls).toEqual([])
  })

  it('写端点：带令牌的裁决转调 decide，note 去空白', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      const res = await action(base, 'decide', { decision: 'approve', note: '  理由  ' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; to: string }
      expect(body.ok).toBe(true)
      expect(body.to).toBe('S-DEVELOPING')
    })
    expect(calls).toEqual([`decide ${TASK_ID} approve 理由`])
  })

  it('写端点：非法 decision 400，不调用动作', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      const res = await action(base, 'decide', { decision: 'maybe' })
      expect(res.status).toBe(400)
    })
    expect(calls).toEqual([])
  })

  it('写端点：澄清空文本 400，非空转调 answer', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (base) => {
      expect((await action(base, 'answer', { text: '   ' })).status).toBe(400)
      expect((await action(base, 'answer', { text: '补充说明' })).status).toBe(200)
    })
    expect(calls).toEqual([`answer ${TASK_ID} 补充说明`])
  })

  it('写端点：GET 405（只接受 POST）', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (base) => {
      const res = await fetch(`${base}/api/tasks/${TASK_ID}/decide`)
      expect(res.status).toBe(405)
    })
  })

  it('GET /api/stats 返回按天序列与累计', async () => {
    const statsDays: Row[] = [
      {
        date: '2026-10-27',
        runs: 5,
        runs_ok: 5,
        runs_failed: 0,
        cost_usd: '0.77',
        tasks_done: 1,
        tasks_failed: 0,
        issues_solved: 1,
      },
    ]
    const statsTotals: Row[] = [{ tasks: 8, tasks_done: 3, runs: 28, cost_usd: '3.21' }]
    await withServer(fakeQuery({ statsDays, statsTotals }), async (base) => {
      const res = await fetch(`${base}/api/stats`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { days: Row[]; totals: Row }
      expect(body.days).toHaveLength(1)
      expect(body.days[0]?.runs).toBe(5)
      expect(body.totals.tasks_done).toBe(3)
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
