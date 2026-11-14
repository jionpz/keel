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
import { listenTestServer } from '../test-support/http-server.js'
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
async function loginCookie(fetch: typeof globalThis.fetch, base: string): Promise<string> {
  const res = await loginRequest(fetch, base, PASSWORD)
  if (res.status !== 200) throw new Error(`测试登录失败：HTTP ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  const pair = setCookie.split(';')[0] ?? ''
  if (!pair.startsWith(`${SESSION_COOKIE}=`)) {
    throw new Error(`登录没有返回会话 Cookie：${setCookie}`)
  }
  return pair
}

function loginRequest(
  fetch: typeof globalThis.fetch,
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
  fn: (base: string, api: ApiFetch, fetch: typeof globalThis.fetch) => Promise<void>,
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
  const { baseUrl: base, fetch, close } = await listenTestServer(server)
  try {
    const cookie = opts.anonymous === true ? undefined : await loginCookie(fetch, base)
    const api: ApiFetch = (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(cookie === undefined ? {} : { cookie }),
          ...(init.headers as Record<string, string> | undefined),
        },
      })
    await fn(base, api, fetch)
  } finally {
    await close()
  }
}

/** 记录调用的假写入口 —— 写端点只负责校验 + 转调，不复制状态机。 */
function fakeActions() {
  const calls: string[] = []
  const act: ConsoleActions = {
    async control(taskId, command, expectedMode, note) {
      calls.push(`control ${taskId} ${command} ${expectedMode ?? ''} ${note ?? ''}`)
      return { status: 200, body: { ok: true, from: expectedMode ?? 'auto', to: 'paused' } }
    },
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
  verb: 'decide' | 'answer' | 'control',
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
  repos?: readonly Row[]
  task?: readonly Row[]
  runs?: readonly Row[]
  events?: readonly Row[]
  artifacts?: readonly Row[]
  feedbacks?: readonly Row[]
  timers?: readonly Row[]
  statsDays?: readonly Row[]
  statsTotals?: readonly Row[]
  workflows?: readonly Row[]
  workflow?: readonly Row[]
  workflowNodes?: readonly Row[]
  workflowEvidence?: readonly Row[]
  workflowGraph?: readonly Row[]
}): QueryFn {
  return async (sql: string) => {
    if (sql.includes('WITH days AS')) return rows.statsDays ?? []
    if (sql.includes('AS tasks_done')) return rows.statsTotals ?? []
    if (sql.includes('FROM managed_workflow_evidence')) return rows.workflowEvidence ?? []
    if (sql.includes('FROM managed_workflow_graph')) return rows.workflowGraph ?? []
    if (sql.includes('FROM managed_workflow w')) return rows.workflows ?? []
    if (sql.includes('SELECT to_jsonb(nodes) AS node')) {
      return (rows.workflowNodes ?? []).map((node) => ({ node }))
    }
    if (sql.includes('FROM managed_workflow WHERE id = $1')) return rows.workflow ?? []
    if (sql.includes('FROM repo') && !sql.includes('JOIN task')) return rows.repos ?? []
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
  textContent: string
  style: Record<string, string>
  classList: {
    toggle(name: string, force?: boolean): void
    add(name: string): void
    remove(name: string): void
    contains(name: string): boolean
  }
  addEventListener(...args: unknown[]): void
  setAttribute(name: string, value: unknown): void
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
}

interface ConsoleStateSeam {
  controlRequest?: { taskId: string; mode: string; action: string } | null
  controlNote?: string
  meta: {
    statuses: { stage: string[]; gate: string[]; terminal: string[] }
    statusLabels: Record<string, string>
    eventLabels: Record<string, string>
    transitions: unknown[]
  } | null
  tasks: Row[]
  repos: Row[]
  workflows: Row[]
  mode: string
  selectedRepo: string | null
  selectedWorkflowId: string | null
  workflowsError: string
  statusCat: string
  workflowDetail: Row | null
}

interface ConsoleSeam {
  renderClarificationBlock(detail: Row): string
  renderTaskControl(task: Row): string
  renderDecisionFacts(detail: Row): string
  renderDecisionOptions(detail: Row): string
  renderCockpitHeader(detail: Row): string
  renderRunLiveness(run: Row, now: number): string
  computeDetailSig(detail: Row): string
  groupByRepo(items: Row[], repos?: Row[]): Row[]
  workItems(): Row[]
  projectGroups(): Row[]
  renderProjectProgress(project: Row): string
  renderTasks(): void
  renderWorkflowList(): void
  renderWorkflowDetail(data: Row): void
  loadRecords(silent?: boolean): Promise<boolean>
  loadWorkflowDetail(id: string, silent?: boolean): Promise<void>
  selectWorkflow(id: string): Promise<void> | void
  projectGroupOf(row: Row): string
  setMode(mode: string): Promise<unknown> | undefined
  refreshAll(silent?: boolean): Promise<void>
  renderInFlight(): string
  renderOverviewProjects(): string
  renderProjectView(): void
  recordKind(row: Row): string
  recordNeedsHuman(row: Row): boolean
  isGateStatus(status: string): boolean
  state: ConsoleStateSeam
}

function makeSeamElement(): SeamElement {
  const attrs = new Map<string, string>()
  const classes = new Set<string>()
  return {
    innerHTML: '',
    textContent: '',
    style: {},
    classList: {
      add(name) {
        classes.add(name)
      },
      remove(name) {
        classes.delete(name)
      },
      contains(name) {
        return classes.has(name)
      },
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

type SeamFetch = (url: string, init?: RequestInit) => Promise<Response>

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function loadConsoleSeam(fetchImpl: SeamFetch = () => new Promise<never>(() => {})): {
  seam: ConsoleSeam
  elements: Map<string, SeamElement>
} {
  const start = CONSOLE_HTML.indexOf('<script>')
  const end = CONSOLE_HTML.lastIndexOf('</script>')
  const script = CONSOLE_HTML.slice(start + '<script>'.length, end)
  const instrumented = script.replace(
    /\}\)\(\);\s*$/,
    `
  globalThis.__keelSeam = {
    renderClarificationBlock: renderClarificationBlock,
    renderDecisionFacts: renderDecisionFacts,
    renderTaskControl: renderTaskControl,
    renderDecisionOptions: renderDecisionOptions,
    renderCockpitHeader: renderCockpitHeader,
    renderRunLiveness: renderRunLiveness,
    computeDetailSig: computeDetailSig,
    groupByRepo: groupByRepo,
    workItems: workItems,
    projectGroups: projectGroups,
    renderProjectProgress: renderProjectProgress,
    renderTasks: renderTasks,
    renderWorkflowList: renderWorkflowList,
    renderWorkflowDetail: renderWorkflowDetail,
    loadRecords: loadRecords,
    loadWorkflowDetail: loadWorkflowDetail,
    selectWorkflow: selectWorkflow,
    projectGroupOf: projectGroupOf,
    setMode: setMode,
    refreshAll: refreshAll,
    renderInFlight: renderInFlight,
    renderOverviewProjects: renderOverviewProjects,
    renderProjectView: renderProjectView,
    recordKind: recordKind,
    recordNeedsHuman: recordNeedsHuman,
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
    fetch: fetchImpl,
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

describe('结构化澄清问题', () => {
  it('优先显示当前 PM 的具体问题并转义正文', () => {
    const { seam } = loadConsoleSeam()
    const html = seam.renderClarificationBlock({
      task: { status: 'S-NEED_CLARIFICATION' },
      artifacts: [
        {
          id: 'pm-outcome',
          kind: 'stage_outcome',
          key: 'pm',
          version: 1,
          body: { stage: 'pm', questions: ['预期 <b>哪些值</b>？'] },
        },
      ],
    })
    expect(html).toContain('预期 &lt;b&gt;哪些值&lt;/b&gt;？')
    expect(html).not.toContain('<b>哪些值</b>')
  })
})

describe('运行活跃度', () => {
  const now = Date.parse('2026-11-12T08:00:00Z')
  const run = {
    id: TASK_ID,
    status: 'RUNNING',
    liveness: {
      last_progress_at: new Date(now - 3000).toISOString(),
      silence_threshold_ms: 300000,
      owner_heartbeat_at: new Date(now - 1000).toISOString(),
    },
  }

  it('只在运行中显示活跃度，缺遥测时不宣称活跃', () => {
    const { seam } = loadConsoleSeam()
    expect(seam.renderRunLiveness(run, now)).toContain('活跃 · 最近信号 3.0s前')
    expect(seam.renderRunLiveness(run, now)).toContain('run-liveness active')
    expect(seam.renderRunLiveness({ ...run, status: 'SUCCEEDED' }, now)).toBe('')
    expect(seam.renderRunLiveness({ id: TASK_ID, status: 'RUNNING' }, now)).toContain(
      '暂无进展信号',
    )
  })

  it('按新进展而非 owner 心跳区分沉默与超阈值，豁免阈值不报警', () => {
    const { seam } = loadConsoleSeam()
    expect(seam.renderRunLiveness(run, now + 45000)).toContain('run-liveness silent')
    expect(seam.renderRunLiveness(run, now + 300000)).toContain('可能卡死')
    expect(
      seam.renderRunLiveness(
        { ...run, liveness: { ...run.liveness, silence_threshold_ms: null } },
        now + 300000,
      ),
    ).not.toContain('可能卡死')
    expect(
      seam.renderRunLiveness(
        { ...run, liveness: { ...run.liveness, last_progress_at: 'invalid' } },
        now,
      ),
    ).toContain('暂无进展信号')
  })

  it('只有遥测变化时详情指纹也变化，轮询能更新指示器', () => {
    const { seam } = loadConsoleSeam()
    const before = seam.computeDetailSig({ task: { id: TASK_ID }, runs: [run] })
    const after = seam.computeDetailSig({
      task: { id: TASK_ID },
      runs: [
        { ...run, liveness: { ...run.liveness, last_progress_at: new Date(now).toISOString() } },
      ],
    })
    expect(after).not.toBe(before)
  })
})

describe('项目阶段分布', () => {
  it.each([
    ['READY', 0, 'waiting', 'gate'],
    ['CANCELLED', 0, 'terminal', 'bad'],
    ['PAUSED', 0, 'waiting', 'gate'],
    ['WAITING_HUMAN', 0, 'waiting', 'gate'],
    ['WAITING_HUMAN', 1, 'needs', 'gate'],
    ['RUNNING', 0, 'stage', 'stage'],
    ['DONE', 0, 'terminal', 'done'],
    ['FAILED', 0, 'terminal', 'bad'],
  ])('工作流 %s（人工待办 %s）保留状态并归入 %s', (status, waiting, group, kind) => {
    const { seam } = loadConsoleSeam()
    seam.state.workflows = [{ id: 'w1', status, waiting_human: waiting }]
    const row = seam.workItems()[0] ?? {}
    expect(row.status).toBe(status)
    expect(seam.projectGroupOf(row)).toBe(group)
    expect(seam.recordKind(row)).toBe(kind)
    expect(seam.recordNeedsHuman(row)).toBe(waiting > 0)
  })

  it('混合项目的节点数、真实执行次数与待办独立计数，概览沿用工作流跳转', () => {
    const { seam, elements } = loadConsoleSeam()
    const repo = 'file:///tmp/console'
    seam.state.tasks = [{ id: 'legacy', repo, status: 'S-DEVELOPING', run_count: 5 }]
    seam.state.workflows = [
      { id: 'queued', repo, status: 'READY', node_count: 30, run_count: 2 },
      { id: 'paused', repo, status: 'PAUSED', node_count: 1, run_count: 0 },
      {
        id: 'tianwen',
        repo,
        status: 'WAITING_HUMAN',
        waiting_human: 0,
        tickets: [{ ticket_id: 'T-1', current_stage: 'review', decision_status: 'PROCESSING' }],
      },
      { id: 'human', repo, status: 'WAITING_HUMAN', waiting_human: 1, run_count: 0 },
    ]
    const projects = seam.groupByRepo(seam.workItems())
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      counts: { all: 5, stage: 2, gate: 3, done: 0, bad: 0 },
      needsYou: 1,
      runs: 7,
      nodes: 31,
      unknownRuns: 1,
    })
    seam.state.selectedRepo = repo
    seam.renderProjectView()
    const projectHtml = elements.get('detail')?.innerHTML ?? ''
    expect(projectHtml).toContain('31 个工作流节点')
    expect(projectHtml).toContain('7 次阶段执行')
    expect(projectHtml).toContain('1 项次数不可用')
    expect(projectHtml).toContain('天问处理中')
    const inFlight = seam.renderInFlight()
    expect(inFlight).toContain('data-task-id="legacy"')
    for (const id of ['queued', 'paused', 'tianwen', 'human']) {
      expect(inFlight).toContain(`data-workflow-id="${id}"`)
    }
    expect(inFlight).toContain('排队等待')
    expect(seam.renderOverviewProjects()).toContain('1 待处理')
  })

  it('缺执行次数时显示不可用，不从节点数补零或伪造次数', () => {
    const { seam, elements } = loadConsoleSeam()
    seam.state.workflows = [{ id: 'w1', repo: 'file:///tmp/demo', status: 'READY', node_count: 18 }]
    const row = seam.workItems()[0] ?? {}
    expect(row.run_count).toBeUndefined()
    seam.renderProjectView()
    expect(elements.get('detail')?.innerHTML).toContain('执行次数不可用')
    expect(elements.get('detail')?.innerHTML).not.toContain('18 次阶段执行')
  })

  it('合并更新时间按时刻排序，不让 SQL JSON 的时区偏移改变记录次序', () => {
    const { seam } = loadConsoleSeam()
    const repo = 'file:///tmp/demo'
    seam.state.tasks = [{ id: 'legacy', repo, status: 'S-NEW', updated_at: '2026-11-13T03:30:00Z' }]
    seam.state.workflows = [
      { id: 'older', repo, status: 'READY', updated_at: '2026-11-13T03:00:00Z' },
      {
        id: 'newer',
        repo,
        status: 'READY',
        updated_at: '2026-11-13T01:00:00Z',
        tickets: [{ ticket_id: 'T-1', activity_at: '2026-11-13T12:00:00+08:00' }],
      },
    ]
    const records = seam.workItems()
    expect(records.map((record) => record.id)).toEqual(['newer:T-1', 'legacy', 'older'])
    const projects = seam.groupByRepo(records)
    expect(Date.parse(String(projects[0]?.lastUpdated))).toBe(Date.parse('2026-11-13T04:00:00Z'))
  })

  it.each([
    ['RUNNING', null],
    ['WAITING_HUMAN', 'PROCESSING'],
  ])(
    'READY 图下真实 ticket=%s、决策=%s 时按 ticket 展示并计为活跃',
    async (ticketStatus, decisionStatus) => {
      const workflow = {
        id: 'w1',
        status: 'READY',
        repo: 'file:///tmp/demo',
        waiting_human: 0,
        node_count: 1,
        run_count: 1,
        tickets: [
          {
            ticket_id: 'T-1',
            ticket_status: ticketStatus,
            decision_status: decisionStatus,
            current_stage: 'execute',
            run_count: 1,
          },
        ],
      }
      const { seam, elements } = loadConsoleSeam((url) => {
        if (url === '/api/tasks') return jsonResponse({ tasks: [] })
        if (url === '/api/workflows') return jsonResponse({ workflows: [workflow] })
        return new Promise<never>(() => {})
      })
      await seam.setMode('projects')
      const row = seam.workItems()[0] ?? {}
      expect(row.status).toBe(ticketStatus)
      expect(seam.projectGroupOf(row)).toBe('stage')
      expect(seam.recordNeedsHuman(row)).toBe(false)
      expect(elements.get('sb-running')?.textContent).toBe('1')
      expect(elements.get('sb-waiting')?.textContent).toBe('0')
      expect(elements.get('detail')?.innerHTML).not.toContain('排队等待')
      expect(elements.get('detail')?.innerHTML).toContain('T-1 · execute')
      expect(elements.get('workflow-list')?.innerHTML).toContain('READY')
      if (decisionStatus === 'PROCESSING') {
        expect(elements.get('detail')?.innerHTML).toContain('天问处理中')
      } else {
        expect(elements.get('detail')?.innerHTML).toContain('运行中')
      }
      const ticket = workflow.tickets[0]
      if (ticket === undefined) throw new Error('缺少测试 ticket')
      ticket.ticket_status = 'PAUSED'
      ticket.decision_status = null
      await seam.refreshAll(true)
      expect(seam.projectGroupOf(seam.workItems()[0] ?? {})).toBe('waiting')
      expect(elements.get('sb-running')?.textContent).toBe('0')
      expect(elements.get('sb-waiting')?.textContent).toBe('1')
    },
  )

  it('工作流或统计失败时概览仍显示当前记录，并把旧计数标成未同步；恢复后清除错误', async () => {
    let unavailable = false
    const workflow = {
      id: 'w1',
      status: 'READY',
      repo: 'file:///tmp/demo',
      request: '排队的工作流',
    }
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === '/api/tasks') return jsonResponse({ tasks: [] })
      if (url === '/api/workflows') {
        return unavailable ? jsonResponse({}, 503) : jsonResponse({ workflows: [workflow] })
      }
      if (url === '/api/stats') return jsonResponse({}, 503)
      return new Promise<never>(() => {})
    })
    await seam.setMode('overview')
    expect(elements.get('detail')?.innerHTML).toContain('data-workflow-id="w1"')
    unavailable = true
    await seam.refreshAll(true)
    expect(elements.get('detail')?.innerHTML).toContain('含上次成功加载')
    expect(elements.get('detail')?.innerHTML).toContain('data-workflow-id="w1"')
    expect(elements.get('sb-health')?.textContent).toBe('工作流数据未同步')
    expect(elements.get('pulse')?.textContent).toContain('部分同步')
    unavailable = false
    await seam.refreshAll(true)
    expect(elements.get('detail')?.innerHTML).not.toContain('含上次成功加载')
    expect(elements.get('sb-health')?.textContent).toBe('已连接')
  })

  it('切入项目页遇到任务加载失败时保留旧任务，明确报错并继续加载工作流', async () => {
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === '/api/tasks') return jsonResponse({}, 503)
      if (url === '/api/workflows') {
        return jsonResponse({
          workflows: [{ id: 'w1', status: 'READY', repo: 'file:///tmp/demo' }],
        })
      }
      return new Promise<never>(() => {})
    })
    seam.state.tasks = [{ id: 'legacy', repo: 'file:///tmp/demo', status: 'S-DEVELOPING' }]
    await seam.setMode('projects')
    expect(seam.state.tasks).toHaveLength(1)
    expect(seam.state.workflows).toHaveLength(1)
    expect(elements.get('detail')?.innerHTML).toContain('无法加载任务')
    expect(elements.get('detail')?.innerHTML).toContain('含上次成功加载的任务记录')
    expect(elements.get('sb-health')?.textContent).toBe('任务数据未同步')
    expect(elements.get('sb-running')?.textContent).toBe('1')
    expect(elements.get('sb-waiting')?.textContent).toBe('1')
  })

  it('概览首次加载和静默轮询都读取两类记录，仅 ticket 变化也刷新并保留项目筛选', async () => {
    const calls: string[] = []
    const repo = 'file:///tmp/managed-only'
    const workflow = {
      id: 'w1',
      repo,
      request: '托管执行',
      status: 'WAITING_HUMAN',
      updated_at: '2026-11-13T01:00:00Z',
      waiting_human: 0,
      run_count: 1,
      tickets: [
        {
          ticket_id: 'T-1',
          current_stage: 'execute',
          ticket_status: 'WAITING_HUMAN',
          decision_status: 'PROCESSING',
          activity_at: '2026-11-13T02:00:00Z',
        },
      ],
    }
    const { seam, elements } = loadConsoleSeam((url) => {
      calls.push(url)
      if (url === '/api/tasks') return jsonResponse({ tasks: [] })
      if (url === '/api/workflows') return jsonResponse({ workflows: [workflow] })
      if (url === '/api/stats') return jsonResponse({ days: [], totals: {} })
      return new Promise<never>(() => {})
    })
    await seam.setMode('overview')
    expect(calls.filter((url) => url === '/api/workflows')).toHaveLength(1)
    expect(calls.filter((url) => url === '/api/tasks')).toHaveLength(1)
    expect(elements.get('sb-running')?.textContent).toBe('1')
    expect(elements.get('sb-waiting')?.textContent).toBe('0')
    expect(elements.get('mode-count-overview')?.textContent).toBe('1')
    expect(elements.get('mode-count-projects')?.textContent).toBe('1')
    expect(elements.get('detail')?.innerHTML).toContain('天问处理中')
    workflow.waiting_human = 1
    const ticket = workflow.tickets[0]
    if (ticket === undefined) throw new Error('缺少测试 ticket')
    ticket.decision_status = 'WAITING_HUMAN'
    ticket.current_stage = 'verify'
    await seam.refreshAll(true)
    expect(elements.get('detail')?.innerHTML).toContain('1 待处理')
    expect(elements.get('detail')?.innerHTML).toContain('T-1 · verify')
    expect(elements.get('detail')?.innerHTML).not.toContain('天问处理中')
    await seam.setMode('projects')
    seam.state.statusCat = 'gate'
    await seam.refreshAll(true)
    expect(seam.state.mode).toBe('projects')
    expect(seam.state.selectedRepo).toBe(repo)
    expect(seam.state.statusCat).toBe('gate')
    expect(calls.filter((url) => url === '/api/workflows')).toHaveLength(4)
    expect(calls.filter((url) => url === '/api/tasks')).toHaveLength(4)
  })

  it('没有 legacy task 时，托管工作流仍按仓库出现在项目投影', () => {
    const { seam } = loadConsoleSeam()
    seam.state.tasks = []
    seam.state.workflows = [
      {
        id: 'workflow-1',
        repo_id: 'repo-1',
        repo: 'https://github.com/jionpz/keel.git',
        repo_provider: 'github',
        request: '运行 #134 与 #135 的受管工作流',
        status: 'READY',
        node_count: 2,
        updated_at: '2026-11-13T11:26:09.800Z',
      },
    ]

    const records = seam.workItems()
    const projects = seam.groupByRepo(records)

    expect(records[0]).toMatchObject({
      id: 'workflow-1',
      repo: 'https://github.com/jionpz/keel.git',
      item_type: 'workflow',
      status: 'READY',
    })
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({
      repo: 'https://github.com/jionpz/keel.git',
      counts: { all: 1, stage: 0, gate: 1, done: 0, bad: 0 },
    })
  })

  it('消融重复投影后，任务、项目和状态栏只消费同一组工作项', () => {
    const repo = 'https://github.com/jionpz/active.git'
    const emptyRepo = 'https://github.com/jionpz/empty.git'
    const { seam, elements } = loadConsoleSeam()
    seam.state.repos = [
      { id: 'repo-active', repo, provider: 'github', created_at: '2026-11-12T01:00:00Z' },
      { id: 'repo-empty', repo: emptyRepo, provider: 'github', created_at: '2026-11-13T01:00:00Z' },
    ]
    seam.state.tasks = [
      {
        id: 'legacy',
        title: 'legacy work',
        status: 'S-DEVELOPING',
        repo,
        run_count: 1,
        updated_at: '2026-11-13T01:00:00Z',
      },
    ]
    seam.state.workflows = [
      {
        id: 'materialized',
        repo,
        status: 'RUNNING',
        node_count: 2,
        run_count: 2,
        updated_at: '2026-11-13T03:00:00Z',
        tickets: [
          {
            ticket_task_id: 'ticket-1',
            ticket_id: 'T-1',
            ticket_title: 'running ticket',
            ticket_status: 'RUNNING',
            run_count: 1,
            activity_at: '2026-11-13T03:00:00Z',
          },
          {
            ticket_task_id: 'ticket-2',
            ticket_id: 'T-2',
            ticket_title: 'waiting ticket',
            ticket_status: 'PENDING',
            run_count: 1,
            activity_at: '2026-11-13T02:00:00Z',
          },
        ],
      },
      {
        id: 'planned',
        repo,
        status: 'ROUTING',
        node_count: 3,
        request: 'planned workflow',
        updated_at: '2026-11-13T04:00:00Z',
      },
    ]
    seam.state.mode = 'tasks'

    const items = seam.workItems()
    expect(items.map((item) => item.item_type).sort()).toEqual([
      'task',
      'ticket',
      'ticket',
      'workflow',
    ])
    expect(
      items.every(
        (item) =>
          !('managed_ticket' in item) &&
          !('managed_workflow' in item) &&
          !('repository_only' in item),
      ),
    ).toBe(true)

    const projects = seam.projectGroups()
    const active = projects.find((project) => project.repo === repo)
    const empty = projects.find((project) => project.repo === emptyRepo)
    expect(active).toMatchObject({
      counts: { all: 4, stage: 3, gate: 1, done: 0, bad: 0 },
      nodes: 5,
    })
    expect(active?.items).toHaveLength(4)
    expect(empty?.items).toEqual([])
    expect(empty && 'repositoryOnly' in empty).toBe(false)

    seam.renderTasks()
    expect(elements.get('mode-count-tasks')?.textContent).toBe('4')
    expect(elements.get('count')?.textContent).toBe('4 个任务')
    expect(elements.get('task-list')?.innerHTML).toContain('data-work-item-type="ticket"')
    expect(elements.get('task-list')?.innerHTML).toContain('data-work-item-type="workflow"')
    expect(elements.get('task-list')?.innerHTML).toContain('planned workflow')
  })

  it('零 ticket workflow 保留规划项，有 ticket 后由真实 ticket 替换容器', () => {
    const repo = 'file:///tmp/work-items'
    const { seam } = loadConsoleSeam()
    seam.state.workflows = [
      {
        id: 'planned',
        repo,
        status: 'ROUTING',
        request: 'planned workflow',
        updated_at: '2026-11-13T01:00:00Z',
      },
      {
        id: 'materialized',
        repo,
        status: 'READY',
        request: 'materialized workflow',
        updated_at: '2026-11-13T01:00:00Z',
        tickets: [
          {
            ticket_task_id: 'ticket-1',
            ticket_id: 'T-1',
            ticket_title: 'real ticket',
            activity_at: '2026-11-13T02:00:00Z',
          },
        ],
      },
    ]

    expect(seam.workItems()).toMatchObject([
      { id: 'ticket-1', item_type: 'ticket', workflow_id: 'materialized' },
      { id: 'planned', item_type: 'workflow', workflow_id: 'planned' },
    ])
  })

  it('未登记到 repo 注册表的 workflow 仍进入项目投影，不被静默丢弃', () => {
    const registeredRepo = 'file:///tmp/registered'
    const orphanRepo = 'file:///tmp/orphan'
    const { seam } = loadConsoleSeam()
    seam.state.repos = [{ id: 'repo-1', repo: registeredRepo }]
    seam.state.workflows = [{ id: 'orphan-workflow', repo: orphanRepo, status: 'READY' }]

    const projects = seam.projectGroups()
    expect(projects.map((project) => project.repo)).toEqual(
      expect.arrayContaining([registeredRepo, orphanRepo]),
    )
    const orphan = projects.find((project) => project.repo === orphanRepo)
    expect(orphan?.items).toMatchObject([
      { id: 'orphan-workflow', item_type: 'workflow', repo: orphanRepo },
    ])
  })

  it('项目集合以 repo 注册表为全集，没有任务的仓库也进入下拉与项目页', async () => {
    const activeRepo = 'https://github.com/jionpz/keel.git'
    const emptyRepo = 'https://github.com/jionpz/keel-demo-api.git'
    const repos = [
      {
        id: 'repo-active',
        repo: activeRepo,
        provider: 'github',
        default_branch: 'main',
        created_at: '2026-11-12T01:00:00Z',
      },
      {
        id: 'repo-empty',
        repo: emptyRepo,
        provider: 'github',
        default_branch: 'develop',
        created_at: '2026-11-13T01:00:00Z',
      },
    ]
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === '/api/tasks') {
        return jsonResponse({
          tasks: [
            {
              id: 'task-active',
              title: '有任务的项目',
              status: 'S-DEVELOPING',
              repo: activeRepo,
              updated_at: '2026-11-13T03:00:00Z',
            },
          ],
          repos,
        })
      }
      if (url === '/api/workflows') return jsonResponse({ workflows: [] })
      return new Promise<never>(() => {})
    })
    seam.state.mode = 'tasks'

    await seam.loadRecords(false)

    const projects = seam.projectGroups()
    expect(projects).toHaveLength(2)
    const empty = projects.find((project) => project.repo === emptyRepo)
    expect(empty).toMatchObject({
      items: [],
      counts: { all: 0, stage: 0, gate: 0, done: 0, bad: 0 },
      defaultBranch: 'develop',
    })
    const selectHtml = elements.get('repo-filter')?.innerHTML ?? ''
    expect(selectHtml).toContain('全部项目（2）')
    expect(selectHtml).toContain('keel-demo-api（0）')

    await seam.setMode('projects')
    const projectList = elements.get('project-list')?.innerHTML ?? ''
    expect(projectList).toContain('keel')
    expect(projectList).toContain('keel-demo-api')

    seam.state.selectedRepo = emptyRepo
    seam.renderProjectView()
    const detail = elements.get('detail')?.innerHTML ?? ''
    expect(detail).toContain('这个项目还没有任务')
    expect(detail).toContain('默认分支 develop')
    expect(detail).not.toContain('执行次数不可用')
  })

  it('任务页和项目页都按 managed ticket 展开，不把整个 workflow 伪装成一个任务', async () => {
    const workflow = {
      id: 'workflow-1',
      repo_id: 'repo-1',
      repo: 'https://github.com/jionpz/keel.git',
      repo_provider: 'github',
      request: '运行 #134 与 #135',
      status: 'READY',
      node_count: 2,
      run_count: 1,
      updated_at: '2026-11-13T15:11:15.000Z',
      tickets: [
        {
          node_key: 'repo-commit-policy',
          ticket_task_id: 'ticket-134',
          ticket_id: 'keel-134',
          external_issue: 'jionpz/keel#134',
          ticket_title: '按仓库配置提交身份与提交信息规范',
          ticket_status: 'RUNNING',
          current_stage: 'execute',
          run_count: 1,
          activity_at: '2026-11-13T15:11:15.000Z',
        },
        {
          node_key: 'pr-description',
          ticket_id: 'keel-135',
          external_issue: 'jionpz/keel#135',
          ticket_title: '生成可追溯的 PR 标题与正文',
          status: 'PENDING',
          run_count: 0,
          activity_at: '2026-11-13T13:08:00.000Z',
        },
      ],
    }
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === '/api/tasks') return jsonResponse({ tasks: [] })
      if (url === '/api/workflows') return jsonResponse({ workflows: [workflow] })
      return new Promise<never>(() => {})
    })
    seam.state.mode = 'tasks'

    await seam.loadRecords(false)

    const html = elements.get('task-list')?.innerHTML ?? ''
    expect(html).toContain('data-workflow-id="workflow-1"')
    expect(html).toContain('jionpz/keel#134 · 按仓库配置提交身份与提交信息规范')
    expect(html).toContain('运行中')
    expect(html).toContain('execute')
    expect(html).toContain('jionpz/keel#135 · 生成可追溯的 PR 标题与正文')
    expect(elements.get('mode-count-tasks')?.textContent).toBe('2')
    expect(elements.get('count')?.textContent).toBe('2 个任务')

    seam.state.statusCat = 'stage'
    seam.renderTasks()
    const runningOnly = elements.get('task-list')?.innerHTML ?? ''
    expect(runningOnly).toContain('jionpz/keel#134')
    expect(runningOnly).not.toContain('jionpz/keel#135')

    seam.state.statusCat = 'all'
    await seam.setMode('projects')
    const projectHtml = elements.get('detail')?.innerHTML ?? ''
    expect(projectHtml).toContain('2 个任务')
    expect(projectHtml).toContain('2 个工作流节点')
    expect(projectHtml).toContain('jionpz/keel#134')
    expect(projectHtml).toContain('jionpz/keel#135')
    expect((projectHtml.match(/查看工作流/g) ?? []).length).toBe(2)
    expect((projectHtml.match(/data-workflow-id="workflow-1"/g) ?? []).length).toBe(2)
    expect(projectHtml).not.toContain('data-task-id="ticket-134"')
    expect(projectHtml).not.toContain('托管工作流 · 托管工作流')
  })

  it('进入项目页时立即拉取托管工作流，不等待自动刷新', async () => {
    const repo = 'https://github.com/jionpz/keel.git'
    const calls: string[] = []
    const { seam, elements } = loadConsoleSeam((url) => {
      calls.push(url)
      if (url === '/api/tasks') return jsonResponse({ tasks: [] })
      if (url === '/api/workflows') {
        return jsonResponse({
          workflows: [
            {
              id: 'workflow-1',
              repo_id: 'repo-1',
              repo,
              repo_provider: 'github',
              request: '运行 #134 与 #135 的受管工作流',
              status: 'READY',
              node_count: 2,
              updated_at: '2026-11-13T11:26:09.800Z',
            },
          ],
        })
      }
      return new Promise<never>(() => {})
    })
    seam.state.mode = 'projects'
    seam.state.tasks = []
    seam.state.selectedRepo = null

    await seam.setMode('projects')

    expect(calls).toContain('/api/workflows')
    expect(calls).toContain('/api/tasks')
    expect(seam.state.selectedRepo).toBe(repo)
    const html = elements.get('project-list')?.innerHTML ?? ''
    expect(html).toContain('jionpz/keel')
    expect(html).toContain(repo)
  })

  it('按仓库地址合并，覆盖全部状态并按非终态统计活跃和人工待处理', () => {
    const { seam } = loadConsoleSeam()
    const statuses = ['S-DEVELOPING', 'S-QA', 'S-HUMAN_REVIEW', 'S-NEW', 'S-DONE', 'S-FAILED']
    const projects = seam.groupByRepo(
      statuses.map((status, index) => ({
        id: String(index),
        repo_id: String(index),
        repo: 'file:///tmp/demo',
        status,
        item_type: 'task',
      })),
    )
    expect(projects).toHaveLength(1)
    const html = seam.renderProjectProgress(projects[0] ?? {})
    expect(html).toContain('4 活跃 / 6 总，1 待处理')
    for (const color of ['--move', '--signal', '--good', '--bad']) {
      expect(html).toContain(`background:var(${color})`)
    }
    for (const status of statuses) expect(html).toContain(`title="${status}：1 个任务"`)
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(6)
  })

  it('空项目显示零计数，不产生无效的百分比或片段', () => {
    const { seam } = loadConsoleSeam()
    const html = seam.renderProjectProgress({
      items: [],
      counts: { stage: 0, gate: 0, all: 0 },
      needsYou: 0,
    })
    expect(html).toContain('0 活跃 / 0 总，0 待处理')
    expect(html).toContain('暂无任务')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('tabindex="0"')
  })
})

describe('主动驾驶控制', () => {
  it.each([
    ['auto', ['暂停', '接管'], ['恢复', '交回 Agent']],
    ['paused', ['恢复', '接管'], ['暂停', '交回 Agent']],
    ['human', ['交回 Agent'], ['暂停', '接管']],
  ])('按 %s 模式展示动作', (mode, present, absent) => {
    const { seam } = loadConsoleSeam()
    const html = seam.renderTaskControl({ id: TASK_ID, status: 'S-DEVELOPING', control_mode: mode })
    for (const label of present as string[]) expect(html).toContain(`>${label}</button>`)
    for (const label of absent as string[]) expect(html).not.toContain(`>${label}</button>`)
  })

  it('终态无按钮，人工交回确认内要求交接说明并转义', () => {
    const { seam } = loadConsoleSeam()
    for (const status of ['S-DONE', 'S-FAILED', 'S-ABANDONED', 'S-REJECTED']) {
      expect(seam.renderTaskControl({ status })).toBe('')
    }
    seam.state.controlRequest = { taskId: TASK_ID, mode: 'human', action: 'resume' }
    const task = { id: TASK_ID, status: 'S-DEVELOPING', control_mode: 'human' }
    expect(seam.renderTaskControl(task)).toContain('data-control-confirm disabled')
    seam.state.controlNote = '<script>alert(1)</script>'
    const html = seam.renderTaskControl(task)
    expect(html).toContain('data-control-confirm>确认')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('本次不标记任何阶段完成')
  })

  it('写入口沿用会话、同源、令牌和 JSON 检查，并校验动作', async () => {
    const { act, calls } = fakeActions()
    await withServer({ query: fakeQuery({}), act }, async (_base, api) => {
      expect(
        (await action(api, 'control', { action: 'pause' }, { 'x-keel-console': '' })).status,
      ).toBe(403)
      expect(
        (await action(api, 'control', { action: 'pause' }, { origin: 'https://example.com' }))
          .status,
      ).toBe(403)
      expect(
        (await action(api, 'control', { action: 'pause' }, { 'content-type': 'text/plain' }))
          .status,
      ).toBe(415)
      expect((await action(api, 'control', { action: 'delete' })).status).toBe(400)
      expect(
        (await action(api, 'control', { action: 'pause', expected_mode: 'other' })).status,
      ).toBe(400)
      expect(calls).toEqual([])
      const reply = await action(api, 'control', { action: 'pause', expected_mode: 'auto' })
      expect(reply.status).toBe(200)
      expect(calls).toEqual([`control ${TASK_ID} pause auto `])
    })
    await withServer(
      { query: fakeQuery({}), act },
      async (_base, api) => {
        expect((await action(api, 'control', { action: 'pause' })).status).toBe(401)
      },
      { anonymous: true },
    )
  })
})

describe('keel console 鉴权', () => {
  it('未登录访问页面 302 到 /login', async () => {
    await withServer(
      fakeQuery({}),
      async (base, _api, fetch) => {
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
      async (base, _api, fetch) => {
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
      async (base, _api, fetch) => {
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
      async (base, _api, fetch) => {
        const res = await loginRequest(fetch, base, 'wrong-password')
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
      async (base, _api, fetch) => {
        const res = await loginRequest(fetch, base, PASSWORD)
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
      async (base, _api, fetch) => {
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
      async (base, _api, fetch) => {
        for (let i = 0; i < 5; i += 1) {
          expect((await loginRequest(fetch, base, 'wrong')).status).toBe(401)
        }
        const limited = await loginRequest(fetch, base, 'wrong')
        expect(limited.status).toBe(429)
        expect(limited.headers.get('retry-after')).toBeTruthy()
        expect((await loginRequest(fetch, base, PASSWORD)).status).toBe(429)
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
      // 四个视图 + 底部状态栏是页面骨架的一部分，掉一个就是回归
      expect(html).toContain('data-mode="overview"')
      expect(html).toContain('data-mode="projects"')
      expect(html).toContain('data-mode="workflows"')
      expect(html).toContain('<span class="mode-label">工作流</span>')
      expect(html).toContain('id="workflow-list"')
      expect(html).toContain('id="workflow-projection"')
      expect(html).toContain('projection=jstack-managed-v1')
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
      expect(html).toContain("fetchJSON('/api/workflows')")
      expect(html).toContain("fetchJSON('/api/workflows/' + encodeURIComponent(id))")
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
        expect(html).toContain(`${token}:`)
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
      expect(html).toContain('@keyframes liveness-pulse')
      expect(html).toContain('prefers-reduced-motion: reduce')
      // 位置刻度：列表行上靠 10 段阶梯读「走到哪了」
      expect(html).toContain('class="ladder')
      // CTA 去掉箭头
      expect(html).not.toContain('去决策 →')
      expect(html).not.toContain('去回答 →')
      // 元信息用中文逗号成句，不用 `·` 拼接
      expect(html).not.toContain('去决策 · ')
    })
  })

  it('GET /api/tasks 返回任务列表', async () => {
    const tasks: Row[] = [
      { id: TASK_ID, title: 'demo', status: 'S-DONE', control_mode: 'auto', repo: 'file:///tmp/x' },
    ]
    const repos: Row[] = [
      {
        id: 'repo-empty',
        repo: 'file:///tmp/empty',
        provider: 'local',
        default_branch: 'main',
      },
    ]
    await withServer(fakeQuery({ tasks, repos }), async (_base, api) => {
      const res = await api('/api/tasks')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tasks: Row[]; repos: Row[] }
      expect((body as { projection?: string }).projection).toBe('legacy-v01')
      expect(body.tasks).toHaveLength(1)
      expect(body.tasks[0]?.title).toBe('demo')
      expect(body.repos).toEqual(repos)
    })
  })

  it('GET /api/workflows 返回 managed 投影与节点计数', async () => {
    const workflows: Row[] = [
      {
        id: TASK_ID,
        status: 'RUNNING',
        current_graph_version: 2,
        node_count: 3,
        archived_count: 1,
        waiting_human: 1,
      },
    ]
    await withServer(fakeQuery({ workflows }), async (_base, api) => {
      const res = await api('/api/workflows')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { projection: string; workflows: Row[] }
      expect(body.projection).toBe('jstack-managed-v1')
      expect(body.workflows[0]?.node_count).toBe(3)
    })
  })

  it('GET /api/workflows/:id 返回图、节点与证据，缺 workflow 时 404', async () => {
    const query = fakeQuery({
      workflow: [{ id: TASK_ID, status: 'READY', current_graph_version: 1 }],
      workflowNodes: [{ id: 'n1', node_key: 'ticket-1', status: 'ARCHIVED' }],
      workflowEvidence: [{ id: 'e1', stage: 'archive' }],
      workflowGraph: [{ version: 1, status: 'COMMITTED' }],
    })
    await withServer(query, async (_base, api) => {
      const res = await api(`/api/workflows/${TASK_ID}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        projection: string
        workflow: Row
        graph: Row
        nodes: Row[]
        evidence: Row[]
      }
      expect(body.projection).toBe('jstack-managed-v1')
      expect(body.workflow.id).toBe(TASK_ID)
      expect(body.graph.version).toBe(1)
      expect(body.nodes[0]?.status).toBe('ARCHIVED')
      expect(body.evidence[0]?.stage).toBe('archive')
    })
    await withServer(fakeQuery({ workflow: [] }), async (_base, api) => {
      const res = await api(`/api/workflows/${TASK_ID}`)
      expect(res.status).toBe(404)
    })
  })

  it('工作流侧栏通过 /api/workflows 加载，并显示 jstack 投影计数', async () => {
    const workflows: Row[] = [
      {
        id: TASK_ID,
        status: 'RUNNING',
        current_graph_version: 2,
        node_count: 3,
        archived_count: 1,
        waiting_human: 1,
        request: '实现工作流控制台视图',
        updated_at: '2026-11-10T12:34:00Z',
      },
    ]
    await withServer(fakeQuery({ workflows }), async (_base, api) => {
      const payload = await (await api('/api/workflows')).json()
      const calls: string[] = []
      const { seam, elements } = loadConsoleSeam((url) => {
        calls.push(url)
        if (url === '/api/tasks') return jsonResponse({ tasks: [] })
        if (url === '/api/workflows') return jsonResponse(payload)
        return new Promise<never>(() => {})
      })

      await expect(seam.loadRecords(false)).resolves.toBe(true)

      expect(calls).toContain('/api/workflows')
      const html = elements.get('workflow-list')?.innerHTML ?? ''
      expect(html).toContain(`data-workflow-id="${TASK_ID}"`)
      expect(html).toContain('1d891a16')
      expect(html).toContain('RUNNING')
      expect(html).toContain('图 v2')
      expect(html).toContain('3 个节点')
      expect(html).toContain('1 已归档')
      expect(html).toContain('1 等待人工')
      expect(html).toContain('实现工作流控制台视图')
      expect(html).toContain('更新 ')
    })
  })

  it('工作流详情只读渲染图、节点与证据，digest 只露前 12 位', async () => {
    const ticketTaskId = '9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a'
    const targetDigest = '0123456789abcdef'.repeat(4)
    const workflow: Row[] = [
      {
        id: TASK_ID,
        status: 'RUNNING',
        current_graph_version: 2,
        request: '实现工作流控制台视图',
        completion_target: 'branch_ready',
        baseline_commit: 'abcdef1234567',
        scope_paths: ['src/cli'],
        created_at: '2026-11-10T10:00:00Z',
        updated_at: '2026-11-10T12:34:00Z',
      },
    ]
    const workflowGraph: Row[] = [
      {
        version: 2,
        status: 'COMMITTED',
        plan_digest: 'f'.repeat(64),
        committed_at: '2026-11-10T11:00:00Z',
      },
    ]
    const workflowNodes: Row[] = [
      {
        id: 'node-1',
        node_key: 'ticket-a',
        ticket_id: 'T-101',
        ticket_size: 'S',
        status: 'WAITING_HUMAN',
        depends_on: ['ticket-root'],
        scope_paths: ['src/cli/console-page.ts'],
        acceptance: ['控制台可只读查看工作流'],
        ticket_task_id: ticketTaskId,
      },
    ]
    const workflowEvidence: Row[] = [
      {
        id: 'evidence-1',
        stage: 'execute',
        status: 'VALID',
        input_commit: 'abcdef1234567',
        target_digest: targetDigest,
      },
    ]
    await withServer(
      fakeQuery({ workflow, workflowGraph, workflowNodes, workflowEvidence }),
      async (_base, api) => {
        const detailPayload = await (await api(`/api/workflows/${TASK_ID}`)).json()
        const { seam, elements } = loadConsoleSeam((url) => {
          if (url === `/api/workflows/${TASK_ID}`) return jsonResponse(detailPayload)
          return new Promise<never>(() => {})
        })
        seam.state.mode = 'workflows'
        seam.state.selectedWorkflowId = TASK_ID
        seam.state.workflows = workflow

        await seam.selectWorkflow(TASK_ID)

        const html = elements.get('detail')?.innerHTML ?? ''
        expect(html).toContain('projection=jstack-managed-v1，只读')
        expect(html).toContain(TASK_ID)
        expect(html).toContain('graph.version')
        expect(html).toContain('COMMITTED')
        expect(html).toContain('ticket-a')
        expect(html).toContain('T-101')
        expect(html).toContain('WAITING_HUMAN')
        expect(html).toContain('ticket-root')
        expect(html).toContain('src/cli/console-page.ts')
        expect(html).toContain('控制台可只读查看工作流')
        expect(html).toContain(ticketTaskId)
        expect(html).toContain('execute')
        expect(html).toContain('VALID')
        expect(html).toContain('abcdef1234567')
        expect(html).toContain(targetDigest.slice(0, 12))
        expect(html).not.toContain(targetDigest)
        expect(html).not.toContain('data-act=')
        expect(html).not.toContain('data-write')
      },
    )
  })

  it('工作流 API 失败时返回诊断文案，不抛未处理异常', async () => {
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === '/api/tasks') return jsonResponse({ tasks: [] })
      return url === '/api/workflows'
        ? jsonResponse({ error: '数据库不可用', detail: 'connection refused' }, 503)
        : new Promise<never>(() => {})
    })

    await expect(seam.loadRecords(false)).resolves.toBe(false)

    const html = elements.get('workflow-list')?.innerHTML ?? ''
    expect(html).toContain('无法加载工作流')
    expect(html).toContain('/api/workflows')
    expect(html).toContain('HTTP 503')
    expect(html).toContain('legacy 任务视图不受影响')
  })

  it('详情轮询响应实际阶段、错误和进展变化，无当前遥测时不伪装活跃', async () => {
    const node = {
      ticket_id: 'T-134',
      status: 'RUNNING',
      ticket_status: 'RUNNING',
      current_stage: 'verify',
      latest_stage: 'verify',
      stage_status: 'RUNNING',
      stage_attempt: 2,
      run_count: 4,
      last_progress_at: null as string | null,
      ticket_error: null as string | null,
      activity_at: '2026-11-13T02:00:00Z',
    }
    const data = {
      workflow: { id: TASK_ID, status: 'RUNNING', updated_at: '2026-11-13T01:00:00Z' },
      nodes: [node],
    }
    const { seam, elements } = loadConsoleSeam((url) => {
      if (url === `/api/workflows/${TASK_ID}`) return jsonResponse(data)
      return new Promise<never>(() => {})
    })
    seam.state.mode = 'workflows'
    seam.state.selectedWorkflowId = TASK_ID
    await seam.loadWorkflowDetail(TASK_ID, false)
    expect(elements.get('detail')?.innerHTML).toContain('暂无进展信号')
    expect(elements.get('detail')?.innerHTML).toContain('当前阶段 verify')
    expect(elements.get('detail')?.innerHTML).toContain('4 次阶段执行')
    const detail = elements.get('detail')
    if (detail === undefined) throw new Error('缺少详情 DOM')
    detail.innerHTML = 'unchanged'
    await seam.loadWorkflowDetail(TASK_ID, true)
    expect(detail.innerHTML).toBe('unchanged')
    node.last_progress_at = '2026-11-13T02:01:00Z'
    await seam.loadWorkflowDetail(TASK_ID, true)
    expect(detail.innerHTML).toContain('最近进展 ')
    expect(detail.innerHTML).not.toContain('暂无进展信号')
    expect(seam.state.workflowDetail).toMatchObject({
      nodes: [{ last_progress_at: node.last_progress_at }],
    })
    node.current_stage = 'review'
    node.ticket_status = 'PAUSED'
    node.ticket_error = '<停止原因>'
    await seam.loadWorkflowDetail(TASK_ID, true)
    expect(detail.innerHTML).toContain('当前阶段 review')
    expect(detail.innerHTML).toContain('阻塞原因：&lt;停止原因&gt;')
    expect(detail.innerHTML).not.toContain('最近进展 ')
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
      async (base, _api, fetch) => {
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
    expect(seam.projectGroupOf({ status: 'S-HUMAN_REVIEW', item_type: 'task' })).toBe('needs')
    expect(seam.projectGroupOf({ status: 'S-NEED_CLARIFICATION', item_type: 'task' })).toBe('needs')
    expect(seam.projectGroupOf({ status: 'S-RFC_READY', item_type: 'task' })).toBe('waiting')
    expect(seam.projectGroupOf({ status: 'S-NEW', item_type: 'task' })).toBe('waiting')
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
