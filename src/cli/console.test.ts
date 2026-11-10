/**
 * 控制台端点的行为测试。
 *
 * 用注入的假 query 起一个真实 http server —— 验证路由 / 状态码 / JSON 形状，
 * 不依赖 Postgres。真实数据库的那一段由 `pnpm run console` 手工验证
 * （与 CLI 的 status / timeline 对账），不在默认单测里连库。
 *
 * 鉴权：`withServer` 默认先登录并把会话 Cookie 注入 `api`，业务用例不重复关心登录；
 * `{ anonymous: true }` 时不登录，用来断言「未登录进不去」。
 */

import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  type ConsoleActions,
  type ConsoleDeps,
  createConsoleHandler,
  type QueryFn,
  type Row,
} from './console.js'
import { type AuthOptions, SESSION_COOKIE } from './console-auth.js'
import { CONSOLE_HTML, CONSOLE_TOKEN_PLACEHOLDER } from './console-page.js'
import { DECISIONS } from './decide.js'

const TASK_ID = '1d891a16-be91-4763-8333-38edd182a824'
const TOKEN = 'test-token-0123456789abcdef'
const PASSWORD = 'test-password-0123456789'

type ServerDeps = Omit<ConsoleDeps, 'auth'> & { readonly auth?: AuthOptions }
type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>

/** 登录一次，取出 `cookie` 请求头需要的 `name=value`。 */
async function loginCookie(base: string): Promise<string> {
  const res = await loginRequest(base, PASSWORD)
  if (res.status !== 200) throw new Error(`测试登录失败：HTTP ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const pair = setCookie.split(';')[0] ?? ''
  if (!pair.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`登录没有返回会话 Cookie：${setCookie}`)
  }
  return pair
}

function loginRequest(
  base: string,
  password: string,
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-keel-console': TOKEN, ...extra },
    body: JSON.stringify({ password }),
  })
}

async function withServer(
  deps: QueryFn | ServerDeps,
  fn: (base: string, api: ApiFetch) => Promise<void>,
  opts: { readonly anonymous?: boolean } = {},
): Promise<void> {
  const input: ServerDeps = typeof deps === 'function' ? { query: deps } : deps
  const resolved: ConsoleDeps = {
    query: input.query,
    token: input.token ?? TOKEN,
    auth: input.auth ?? { password: PASSWORD },
    ...(input.act !== undefined ? { act: input.act } : {}),
    ...(input.boundHost !== undefined ? { boundHost: input.boundHost } : {}),
    ...(input.secureCookie !== undefined ? { secureCookie: input.secureCookie } : {}),
  }
  const handler = createConsoleHandler(resolved)
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  const cookie = opts.anonymous === true ? undefined : await loginCookie(base)
  const api: ApiFetch = (path, init = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  try {
    await fn(base, api)
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
  api: ApiFetch,
  verb: 'decide' | 'answer',
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return api(`/api/tasks/${TASK_ID}/${verb}`, {
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

interface SeamElement {
  innerHTML: string
  style: Record<string, string>
  classList: {
    toggle(name: string, force?: boolean): void
  }
  addEventListener(...args: unknown[]): void
  setAttribute(name: string, value: unknown): void
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
}

interface ConsoleStateSeam {
  meta: {
    statuses: { stage: string[]; gate: string[]; terminal: string[] }
    statusLabels: Record<string, string>
    eventLabels: Record<string, string>
    transitions: unknown[]
  } | null
  tasks: Row[]
  mode: string
}

interface ConsoleSeam {
  renderDecisionFacts(detail: Row): string
  renderDecisionOptions(detail: Row): string
  renderCockpitHeader(detail: Row): string
  renderTasks(): void
  projectGroupOf(status: string): string
  isGateStatus(status: string): boolean
  state: ConsoleStateSeam
}

function makeSeamElement(): SeamElement {
  const attrs = new Map<string, string>()
  const classes = new Set<string>()
  return {
    innerHTML: '',
    style: {},
    classList: {
      toggle(name, force) {
        const on = force ?? !classes.has(name)
        if (on) classes.add(name)
        else classes.delete(name)
      },
    },
    addEventListener() {},
    setAttribute(name, value) {
      attrs.set(name, String(value))
    },
    getAttribute(name) {
      return attrs.get(name) ?? null
    },
    removeAttribute(name) {
      attrs.delete(name)
    },
  }
}

function loadConsoleSeam(): { seam: ConsoleSeam; elements: Map<string, SeamElement> } {
  const start = CONSOLE_HTML.indexOf('<script>')
  const end = CONSOLE_HTML.lastIndexOf('</script>')
  const script = CONSOLE_HTML.slice(start + '<script>'.length, end)
  const instrumented = script.replace(
    /\}\)\(\);\s*$/,
    `
  globalThis.__keelSeam = {
    renderDecisionFacts: renderDecisionFacts,
    renderDecisionOptions: renderDecisionOptions,
    renderCockpitHeader: renderCockpitHeader,
    renderTasks: renderTasks,
    projectGroupOf: projectGroupOf,
    isGateStatus: isGateStatus,
    state: state
  };
})();`,
  )
  if (instrumented === script) throw new Error('控制台脚本结尾变化，渲染 seam 注入失败')

  const elements = new Map<string, SeamElement>()
  const element = (id: string): SeamElement => {
    const existing = elements.get(id)
    if (existing !== undefined) return existing
    const created = makeSeamElement()
    elements.set(id, created)
    return created
  }
  const document = {
    documentElement: makeSeamElement(),
    getElementById: element,
    querySelectorAll: () => [],
  }
  const sandbox: Record<string, unknown> = {
    document,
    window: {
      location: { hash: '' },
      addEventListener() {},
    },
    localStorage: { getItem: () => null, removeItem() {} },
    fetch: () => new Promise<never>(() => {}),
    setInterval: () => 1,
  }
  runInNewContext(instrumented, sandbox)
  const seam = sandbox.__keelSeam
  if (seam === undefined) throw new Error('渲染 seam 未注入')
  return { seam: seam as ConsoleSeam, elements }
}

function expectNoNesting(html: string, parent: string, children: readonly string[]): void {
  const voids = new Set(['br', 'hr', 'img', 'input', 'meta', 'link'])
  const stack: string[] = []
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = match[0]
    const name = (match[1] ?? '').toLowerCase()
    if (tag.startsWith('</')) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.length = at
      continue
    }
    if (voids.has(name)) continue
    if (stack.includes(parent) && children.includes(name)) {
      throw new Error(`<${name}> 不允许嵌套在 <${parent}> 内`)
    }
    stack.push(name)
  }
}

describe('keel console 鉴权', () => {
  it('未登录访问页面 302 到 /login', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        const res = await fetch(`${base}/`, { redirect: 'manual' })
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/login')
      },
      { anonymous: true },
    )
  })

  it('未登录访问 API 401，不泄漏事实', async () => {
    await withServer(
      fakeQuery({ tasks: [{ id: TASK_ID, title: 'secret' }] }),
      async (base) => {
        for (const path of ['/api/tasks', '/api/stats', '/api/meta', `/api/tasks/${TASK_ID}`]) {
          const res = await fetch(`${base}${path}`)
          expect(res.status).toBe(401)
          const body = (await res.json()) as { ok: boolean; error: string }
          expect(body.ok).toBe(false)
          expect(body.error).toBe('未登录')
        }
      },
      { anonymous: true },
    )
  })

  it('登录页可访问，且注入了本机令牌', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        const res = await fetch(`${base}/login`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('login-form')
        expect(html).toContain('访问口令')
        expect(html).toContain(`name="keel-console-token" content="${TOKEN}"`)
        expect(html).not.toContain(CONSOLE_TOKEN_PLACEHOLDER)
      },
      { anonymous: true },
    )
  })

  it('已登录访问 /login 直接回控制台', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const res = await api('/login', { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
    })
  })

  it('错误口令 401，且不签发 Cookie', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        const res = await loginRequest(base, 'wrong-password')
        expect(res.status).toBe(401)
        expect(res.headers.get('set-cookie')).toBeNull()
        const body = (await res.json()) as { ok: boolean; error: string }
        expect(body.error).toBe('口令不正确')
      },
      { anonymous: true },
    )
  })

  it('正确口令签发 HttpOnly / SameSite=Strict Cookie', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        const res = await loginRequest(base, PASSWORD)
        expect(res.status).toBe(200)
        const setCookie = res.headers.get('set-cookie') ?? ''
        expect(setCookie).toContain(`${SESSION_COOKIE}=`)
        expect(setCookie).toContain('HttpOnly')
        expect(setCookie).toContain('SameSite=Strict')
        expect(setCookie).toContain('Max-Age=43200')
        expect(setCookie).not.toContain('Secure')
      },
      { anonymous: true },
    )
  })

  it('保持登录使用 7 天会话', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        const res = await fetch(`${base}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-keel-console': TOKEN },
          body: JSON.stringify({ password: PASSWORD, remember: true }),
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('set-cookie')).toContain('Max-Age=604800')
      },
      { anonymous: true },
    )
  })

  it('连续失败 5 次后 429，正确口令也被限流', async () => {
    await withServer(
      fakeQuery({}),
      async (base) => {
        for (let i = 0; i < 5; i += 1) {
          expect((await loginRequest(base, 'wrong')).status).toBe(401)
        }
        const limited = await loginRequest(base, 'wrong')
        expect(limited.status).toBe(429)
        expect(limited.headers.get('retry-after')).toBeTruthy()
        expect((await loginRequest(base, PASSWORD)).status).toBe(429)
      },
      { anonymous: true },
    )
  })

  it('退出后旧 Cookie 立即失效', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      expect((await api('/api/tasks')).status).toBe(200)
      const out = await api('/api/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-keel-console': TOKEN },
        body: '{}',
      })
      expect(out.status).toBe(200)
      expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await api('/api/tasks')).status).toBe(401)
    })
  })

  it('页面与 API 带安全响应头', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const page = await api('/')
      expect(page.headers.get('x-frame-options')).toBe('DENY')
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")

      const meta = await api('/api/meta')
      expect(meta.headers.get('x-frame-options')).toBe('DENY')
    })
  })

  it('非回环绑定仍要求 Origin 与 Host 同源', async () => {
    const { act, calls } = fakeActions()
    await withServer(
      { query: fakeQuery({}), token: TOKEN, act, boundHost: '0.0.0.0' },
      async (_base, api) => {
        const res = await action(
          api,
          'decide',
          { decision: 'approve' },
          {
            origin: 'https://evil.example',
          },
        )
        expect(res.status).toBe(403)
      },
    )
    expect(calls).toEqual([])
  })
})

describe('keel console', () => {
  it('GET / 返回页面', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const res = await api('/')
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
      // 退出入口：令牌来自 meta，POST /api/logout 后回登录页
      expect(html).toContain('id="logout"')
      expect(html).toContain("fetch('/api/logout'")
    })
  })

  it('视觉系统：墨色定位、颜色只用来说「要不要你动手」', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const html = await (await api('/')).text()
      // 冷纸 + 墨色 + 四个语义色，缺一个整套配色就塌
      for (const token of [
        '--paper',
        '--panel',
        '--ink',
        '--ink-2',
        '--ink-3',
        '--signal',
        '--move',
        '--good',
        '--bad',
      ]) {
        expect(html).toContain(token + ':')
      }
      // 旧 macOS 系统色必须清干净：看到它们就是回退到「AI 默认皮肤」
      for (const gone of ['#0a7aff', '#f5f5f7', '#ff9f0a', '#30d158', '#ff453a']) {
        expect(html.toLowerCase()).not.toContain(gone)
      }
      // 品牌是字标 + 龙骨，不是圆角色块
      expect(html).toContain('brand-glyph')
      // 状态标记 = 方块 + 文字，不做胶囊、不做脉冲
      expect(html).toContain('class="dot"')
      expect(html).not.toContain('pulse-ring')
      expect(html).not.toContain('@keyframes')
      // 位置刻度：列表行上靠 10 段阶梯读「走到哪了」
      expect(html).toContain('class="ladder')
      // CTA 去掉箭头
      expect(html).not.toContain('去决策 →')
      expect(html).not.toContain('去回答 →')
      // 元信息用中文逗号成句，不用 `·` 拼接
      expect(html).not.toContain(' · ')
    })
  })

  it('GET /api/tasks 返回任务列表', async () => {
    const tasks: Row[] = [
      { id: TASK_ID, title: 'demo', status: 'S-DONE', control_mode: 'auto', repo: 'file:///tmp/x' },
    ]
    await withServer(fakeQuery({ tasks }), async (_base, api) => {
      const res = await api('/api/tasks')
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
    await withServer(query, async (_base, api) => {
      const res = await api(`/api/tasks/${TASK_ID}`)
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
    await withServer(fakeQuery({ task: [] }), async (_base, api) => {
      const res = await api(`/api/tasks/${TASK_ID}`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { error: string }
      expect(body.error).toBe('task not found')
    })
  })

  it('非法 task id 返回 404', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const res = await api('/api/tasks/not-a-uuid')
      expect(res.status).toBe(404)
    })
  })

  it('非写端点的写方法仍被拒绝（405）', async () => {
    await withServer(fakeQuery({}), async (_base, api) => {
      const res = await api('/api/tasks', { method: 'POST' })
      expect(res.status).toBe(405)
    })
  })

  it('页面注入了本机令牌，模板占位符不残留', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const html = await (await api('/')).text()
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
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const html = await (await api('/')).text()
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
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const html = await (await api('/')).text()
      expect(html).not.toContain('window.prompt(')
      expect(html).not.toContain('window.confirm(')
      // 理由内联在卡片里，按 data-note-for 取值
      expect(html).toContain('data-note-for=')
    })
  })

  it('选项 key 与 decide.ts 的 DECISIONS 完全一致，改一处不会漏掉另一处', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const html = await (await api('/')).text()
      const keys = [...html.matchAll(/key: '([a-z]+)',\s*\n\s*title:/g)].map((m) => m[1])
      expect(new Set(keys)).toEqual(new Set(DECISIONS))
    })
  })

  it('决策 Tab 只在闸门状态注入，且闸门状态默认落在它上面', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const html = await (await api('/')).text()
      expect(html).toContain('isGateStatus')
      expect(html).toContain("'S-HUMAN_REVIEW'")
      expect(html).toContain("'S-NEED_CLARIFICATION'")
      expect(html).toContain('data-tab="decision"')
      expect(html).toContain("if (gate && !state.tabChosen) tab = 'decision'")
    })
  })

  it('写端点：缺令牌 403', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      const res = await action(api, 'decide', { decision: 'approve' }, { 'x-keel-console': '' })
      expect(res.status).toBe(403)
    })
    expect(calls).toEqual([])
  })

  it('写端点：非 application/json 415（挡跨站简单请求）', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      const res = await action(api, 'decide', JSON.stringify({ decision: 'approve' }), {
        'content-type': 'text/plain',
      })
      expect(res.status).toBe(415)
    })
    expect(calls).toEqual([])
  })

  it('写端点：外站 Origin 403（DNS rebinding / 跨站）', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      const res = await action(
        api,
        'decide',
        { decision: 'approve' },
        {
          origin: 'https://evil.example',
        },
      )
      expect(res.status).toBe(403)
    })
    expect(calls).toEqual([])
  })

  it('写端点：带令牌的裁决转调 decide，note 去空白', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      const res = await action(api, 'decide', { decision: 'approve', note: '  理由  ' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; to: string }
      expect(body.ok).toBe(true)
      expect(body.to).toBe('S-DEVELOPING')
    })
    expect(calls).toEqual([`decide ${TASK_ID} approve 理由`])
  })

  it('写端点：非法 decision 400，不调用动作', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      const res = await action(api, 'decide', { decision: 'maybe' })
      expect(res.status).toBe(400)
    })
    expect(calls).toEqual([])
  })

  it('写端点：澄清空文本 400，非空转调 answer', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), token: TOKEN, act }, async (_base, api) => {
      expect((await action(api, 'answer', { text: '   ' })).status).toBe(400)
      expect((await action(api, 'answer', { text: '补充说明' })).status).toBe(200)
    })
    expect(calls).toEqual([`answer ${TASK_ID} 补充说明`])
  })

  it('写端点：GET 405（只接受 POST）', async () => {
    await withServer({ query: fakeQuery({}), token: TOKEN }, async (_base, api) => {
      const res = await api(`/api/tasks/${TASK_ID}/decide`)
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
    await withServer(fakeQuery({ statsDays, statsTotals }), async (_base, api) => {
      const res = await api('/api/stats')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { days: Row[]; totals: Row }
      expect(body.days).toHaveLength(1)
      expect(body.days[0]?.runs).toBe(5)
      expect(body.totals.tasks_done).toBe(3)
    })
  })

  it('数据库不可用时：匿名 /healthz 只回 ok，不带错误与连接串', async () => {
    const broken: QueryFn = async () => {
      throw new Error('connection refused')
    }
    await withServer(
      broken,
      async (base) => {
        const res = await fetch(`${base}/healthz`)
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ ok: false })
      },
      { anonymous: true },
    )
  })

  it('数据库不可用时：已登录 /healthz 保留排障详情', async () => {
    const broken: QueryFn = async () => {
      throw new Error('connection refused')
    }
    await withServer(broken, async (_base, api) => {
      const res = await api('/healthz')
      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; error: string; connection: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('connection refused')
      expect(body.connection).toContain('postgres')
    })
  })
})

describe('console 页面渲染 seam', () => {
  it('RFC 目标 / 验收条件按真实结构渲染，转义后 details 不再嵌在 span 里', () => {
    const { seam } = loadConsoleSeam()
    const detail: Row = {
      task: { id: TASK_ID, status: 'S-HUMAN_REVIEW', work_branch: 'ai/demo' },
      runs: [],
      feedbacks: [],
      timers: [],
      artifacts: [
        {
          kind: 'rfc',
          key: '',
          version: 2,
          body: {
            title: '方案 <script>alert(1)</script>',
            goals: ['目标 <b>一</b>', '目标 & 二'],
            acceptance_criteria: [
              { id: 'AC1', text: '验收 <img src=x>', verifiable_by: '人工 & 核对' },
            ],
          },
        },
      ],
      events: [
        {
          seq: 7,
          type: 'WorkspaceDiffCollected',
          payload: {
            patch: [
              'diff --git a/src/a.ts b/src/a.ts',
              '--- a/src/a.ts',
              '+++ b/src/a.ts',
              '@@ -1 +1 @@',
              '-old',
              '+new',
              '+added',
            ].join('\n'),
          },
        },
      ],
    }

    const html = seam.renderDecisionFacts(detail)

    expect(html).not.toContain('[object Object]')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('目标 &lt;b&gt;一&lt;/b&gt;')
    expect(html).toContain('目标 &amp; 二')
    expect(html).toContain('AC1')
    expect(html).toContain('验收 &lt;img src=x&gt;')
    expect(html).toContain('人工 &amp; 核对')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('+2')
    expect(html).toContain('-1')
    expectNoNesting(html, 'span', ['details', 'div'])
  })

  it('任务列表把人工闸门和系统等待分开，只有前者标 needs-action', () => {
    const { seam, elements } = loadConsoleSeam()
    seam.state.meta = {
      statuses: {
        stage: ['S-DEVELOPING'],
        gate: ['S-HUMAN_REVIEW', 'S-NEED_CLARIFICATION', 'S-NEW', 'S-RFC_READY', 'S-PR_OPEN'],
        terminal: ['S-DONE'],
      },
      statusLabels: {
        'S-HUMAN_REVIEW': '等待人工复核',
        'S-RFC_READY': 'RFC 就绪',
      },
      eventLabels: {},
      transitions: [],
    }
    seam.state.mode = 'tasks'
    seam.state.tasks = [
      {
        id: TASK_ID,
        title: '需要人',
        status: 'S-HUMAN_REVIEW',
        repo: 'file:///tmp/a',
        updated_at: '2026-11-10T10:00:00Z',
      },
      {
        id: '6f0d1cce-0f4b-4f4d-8f8e-2f5a8f7b6c5d',
        title: '等系统',
        status: 'S-RFC_READY',
        repo: 'file:///tmp/a',
        updated_at: '2026-11-10T11:00:00Z',
      },
    ]

    seam.renderTasks()
    const html = elements.get('task-list')?.innerHTML ?? ''
    const items = html.split('<li ').slice(1)
    const itemFor = (id: string): string =>
      items.find((item) => item.includes(`data-id="${id}"`)) ?? ''
    const human = itemFor(TASK_ID)
    const waiting = itemFor('6f0d1cce-0f4b-4f4d-8f8e-2f5a8f7b6c5d')

    expect(human).toContain('task-dot gate')
    expect(human).toContain('needs-action')
    expect(human).toContain('need-badge')
    expect(human).toContain('（需处理）')
    expect(waiting).toContain('task-dot waiting')
    expect(waiting).not.toContain('needs-action')
    expect(waiting).not.toContain('need-badge')
    expect(waiting).not.toContain('（需处理）')

    expect(seam.isGateStatus('S-HUMAN_REVIEW')).toBe(true)
    expect(seam.isGateStatus('S-RFC_READY')).toBe(false)
    expect(seam.projectGroupOf('S-HUMAN_REVIEW')).toBe('needs')
    expect(seam.projectGroupOf('S-NEED_CLARIFICATION')).toBe('needs')
    expect(seam.projectGroupOf('S-RFC_READY')).toBe('waiting')
    expect(seam.projectGroupOf('S-NEW')).toBe('waiting')
  })

  it('只有批准卡片带主路径标记，返工与驳回不冒充默认选项', () => {
    const { seam } = loadConsoleSeam()
    const html = seam.renderDecisionOptions({
      task: { id: TASK_ID, status: 'S-HUMAN_REVIEW', work_branch: 'ai/demo' },
      runs: [{ stage: 'develop', attempt: 1, status: 'SUCCEEDED' }],
    })
    const cards = html.split('<div class="option-card ').slice(1)
    const cardFor = (key: string): string => {
      const card = cards.find((item) => item.slice(0, item.indexOf('"')).split(' ')[0] === key)
      if (card === undefined) throw new Error(`没有 ${key} 选项卡片`)
      return card
    }

    expect(cardFor('approve')).toContain('class="option-badge-recommended"')
    expect(cardFor('approve')).toContain('主路径')
    expect(cardFor('rework')).not.toContain('主路径')
    expect(cardFor('reject')).not.toContain('主路径')
    expect(html).not.toContain(' primary')
  })

  it('复制按钮的可见文案和 title 都指向 data-copy 里的同一条命令', () => {
    const { seam } = loadConsoleSeam()
    seam.state.meta = {
      statuses: { stage: ['S-DEVELOPING'], gate: ['S-HUMAN_REVIEW'], terminal: ['S-DONE'] },
      statusLabels: { 'S-HUMAN_REVIEW': '等待人工复核' },
      eventLabels: {},
      transitions: [],
    }
    const html = seam.renderCockpitHeader({
      task: {
        id: TASK_ID,
        title: 'demo',
        status: 'S-HUMAN_REVIEW',
        repo: 'file:///tmp/demo',
        work_branch: 'ai/demo',
        base_branch: 'main',
        created_at: '2026-11-10T10:00:00Z',
        updated_at: '2026-11-10T10:00:00Z',
      },
      runs: [],
      events: [],
      artifacts: [],
      feedbacks: [],
      timers: [],
    })

    expect(html).toContain(`data-copy="pnpm keel status ${TASK_ID}"`)
    expect(html).toContain(`title="复制 CLI 状态查询命令：pnpm keel status ${TASK_ID}"`)
    expect(html).toContain(`data-copy="pnpm run timeline -- ${TASK_ID}"`)
    expect(html).toContain(`title="复制完整时间线导出命令：pnpm run timeline -- ${TASK_ID}"`)
  })
})
