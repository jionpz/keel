/**
 * keel console —— 受口令保护的 Web 控制台。
 *
 * 定位（docs/09-roadmap.md）：UI 是 Fact Plane 的**消费者**，不是被验证的东西。
 * 因此本文件：
 *   - 读路径只有 SELECT，以 `keel_control` 角色访问；
 *   - 人工闸门与驾驶控制走 `POST /api/tasks/:id/decide|answer|control`。它不是
 *     「控制台自己改状态」—— 它转调 `decide.ts` 的 `decideTask` / `answerTask`，
 *     驾驶控制转调 `controlTask`，与 CLI 共用控制表和事务；
 *   - **鉴权**：除 `/login`、`POST /api/login`、`/healthz` 外，所有路由先过会话闸门。
 *     会话是进程内存态（HttpOnly + SameSite=Strict Cookie），重启即失效；
 *   - **写端点**在会话之外仍要求：Host 合法（绑回环时必须回环）、Origin 与 Host
 *     同源（浏览器带时）、`Content-Type: application/json`、`X-Keel-Console`
 *     等于本次进程随机令牌。这条防线不因登录而取消。
 *
 * 用法：
 *   pnpm run console                                     # 默认 http://127.0.0.1:4321
 *   KEEL_CONSOLE_PASSWORD=… pnpm run console             # 固定口令
 *   KEEL_CONSOLE_HOST=0.0.0.0 KEEL_CONSOLE_PASSWORD=… pnpm run console   # 对外监听
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { controlTask } from '../control/task-control.js'
import { CONTROL_ACTIONS, type ControlAction } from '../control/transition/control-mode.js'
import { TASK_TRANSITIONS } from '../control/transition/table.js'
import { asRole, closePool, connectionString } from '../fact/db.js'
import {
  CONTROL_MODES,
  type ControlMode,
  GATE_STATUSES,
  STAGE_STATUSES,
  TERMINAL_STATUSES,
} from '../shared/ids.js'
import { type AuthOptions, ConsoleAuth, resolveConsoleAuth } from './console-auth.js'
import { CONSOLE_LOGIN_HTML } from './console-login-page.js'
import { CONSOLE_HTML, CONSOLE_TOKEN_PLACEHOLDER } from './console-page.js'
import { answerTask, DECISIONS, type Decision, decideTask } from './decide.js'

const DEFAULT_PORT = 4321
const DEFAULT_HOST = '127.0.0.1'
/** 只用来解析相对 URL；与监听地址无关。 */
const URL_BASE = 'http://127.0.0.1'

/** 列表与详情共用节点读模型；ticket 与决策进展不必等待 workflow 再次同步。 */
const WORKFLOW_NODE_SELECT = `
  SELECT n.*, t.status AS ticket_status, t.current_stage,
         t.last_error AS ticket_error, d.status AS decision_status,
         d.question AS decision_question,
         COALESCE(s.run_count, 0)::int AS run_count,
         s.stage AS latest_stage, s.status AS stage_status,
         s.attempt AS stage_attempt, s.error AS stage_error,
         s.started_at AS stage_started_at, s.ended_at AS stage_ended_at,
         p.payload->>'observedAt' AS last_progress_at,
         GREATEST(n.updated_at, t.updated_at, d.updated_at,
                  s.started_at, s.ended_at, p.occurred_at) AS activity_at
  FROM managed_workflow_node n
  LEFT JOIN managed_ticket_task t ON t.id = n.ticket_task_id
  LEFT JOIN managed_decision_request d
    ON d.id = t.pending_decision_id AND d.revision = t.pending_decision_revision
  LEFT JOIN LATERAL (
    SELECT count(*) OVER () AS run_count, id, stage, status, attempt, error, started_at, ended_at
    FROM managed_ticket_stage
    WHERE task_id = t.id
    ORDER BY started_at DESC, attempt DESC, id
    LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT payload, occurred_at
    FROM managed_ticket_event
    WHERE task_id = t.id AND type = 'ManagedTicketProgress'
      AND t.status = 'RUNNING' AND s.status = 'RUNNING' AND s.stage = t.current_stage
      AND payload->>'stageId' = s.id::text
    ORDER BY seq DESC
    LIMIT 1
  ) p ON true`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 主路径（展示用）：docs/04-state-machine.md §1 的正常闭环。
 * 这不是状态机的定义处 —— 转移表在 `src/control/transition/table.ts`，
 * 页面里的「可能的下一次转移」直接来自那张表。
 */
const MAIN_PATH = [
  'S-NEW',
  'S-PM_ANALYZING',
  'S-BRAINSTORM',
  'S-RFC_DRAFT',
  'S-RFC_READY',
  'S-DEVELOPING',
  'S-QA',
  'S-REVIEW',
  'S-PR_OPEN',
  'S-DONE',
] as const

/**
 * 术语的人话层：状态与转移事件的短中文名。
 *
 * 只用于 console 呈现 —— 状态集合本身仍由 `src/shared/ids.ts` 与转移表定义，
 * 这里不新增语义，只给每个机器码配一个可读标签。UI 通过 `/api/meta` 消费，
 * 不在页面里硬编码第二份状态列表。
 */
const STATUS_LABELS: Record<string, string> = {
  'S-NEW': '新建',
  'S-NEED_CLARIFICATION': '待澄清',
  'S-PM_ANALYZING': 'PM 分析',
  'S-BRAINSTORM': '方案讨论',
  'S-RFC_DRAFT': 'RFC 起草',
  'S-RFC_READY': 'RFC 就绪',
  'S-DEVELOPING': '开发中',
  'S-QA': '质量验证',
  'S-REVIEW': '评审',
  'S-PR_OPEN': 'PR 待合并',
  'S-HUMAN_REVIEW': '人工介入',
  'S-DONE': '已完成',
  'S-REJECTED': '已驳回',
  'S-ABANDONED': '已放弃',
  'S-FAILED': '已失败',
}

const EVENT_LABELS: Record<string, string> = {
  FeedbackTriaged: '需求立案',
  Dispatch: '派发执行',
  RunSucceeded: 'Run 成功',
  RunFailed: 'Run 失败',
  RunTimeout: 'Run 超时',
  ArtifactCommitted: '产物提交',
  HumanApproved: '人工批准',
  HumanRejected: '人工驳回',
  HumanRequestedRework: '要求返工',
  HumanDecision: '人工裁决',
  PolicyEvaluated: '策略裁决',
  CIFailed: 'CI 失败',
  CIPassed: 'CI 通过',
  PRMerged: 'PR 合并',
  PRClosed: 'PR 关闭',
  ClarificationReceived: '补充澄清',
  Cancelled: '取消',
  CapabilityRequested: '能力请求',
  TimerFired: '定时触发',
  UnrecoverableError: '不可恢复错误',
}

/**
 * 概览统计：近 14 天按天聚合 + 全量累计。
 *
 * 口径（与 `keel status` 一致，只读聚合）：
 *  - 运行次数 = run.started_at 落在当天的 Run（含成功 / 失败 / 取消）；
 *  - 完成任务 = terminal_at 落在当天且状态为 S-DONE；
 *  - 问题闭环 = 当天完成、且挂了 feedback 的任务所关联的去重 feedback 数；
 *  - 成本 = 当天启动的 Run 的成本合计（unavailable 记 0，不臆造）。
 * 日期边界用数据库会话时区（当前 Asia/Shanghai）的 00:00，不做二次换算。
 */
const STATS_DAYS_SQL = `
  WITH days AS (
    SELECT generate_series(date_trunc('day', now()) - interval '13 days',
                           date_trunc('day', now()), interval '1 day') AS day
  )
  SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
         COALESCE(r.runs, 0)::int AS runs,
         COALESCE(r.ok, 0)::int AS runs_ok,
         COALESCE(r.failed, 0)::int AS runs_failed,
         COALESCE(r.cost, 0)::text AS cost_usd,
         COALESCE(t.done, 0)::int AS tasks_done,
         COALESCE(t.failed, 0)::int AS tasks_failed,
         COALESCE(f.solved, 0)::int AS issues_solved
  FROM days d
  LEFT JOIN LATERAL (
    SELECT count(*) AS runs,
           count(*) FILTER (WHERE status = 'SUCCEEDED') AS ok,
           count(*) FILTER (WHERE status IN ('FAILED', 'TIMEOUT')) AS failed,
           SUM(COALESCE(cost_usd, 0)) AS cost
    FROM run WHERE started_at >= d.day AND started_at < d.day + interval '1 day'
  ) r ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE status = 'S-DONE') AS done,
           count(*) FILTER (WHERE status IN ('S-FAILED', 'S-REJECTED', 'S-ABANDONED')) AS failed
    FROM task WHERE terminal_at >= d.day AND terminal_at < d.day + interval '1 day'
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT tf.feedback_id) AS solved
    FROM task_feedback tf JOIN task tk ON tk.id = tf.task_id
    WHERE tk.status = 'S-DONE'
      AND tk.terminal_at >= d.day AND tk.terminal_at < d.day + interval '1 day'
  ) f ON true
  ORDER BY d.day`

const STATS_TOTALS_SQL = `
  SELECT (SELECT count(*) FROM task)::int AS tasks,
         (SELECT count(*) FROM task WHERE status = 'S-DONE')::int AS tasks_done,
         (SELECT count(*) FROM run)::int AS runs,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM run)::text AS cost_usd`

export type Row = Record<string, unknown>
export type QueryFn = (sql: string, params: readonly unknown[]) => Promise<readonly Row[]>

/** 写端点的回复。控制台不解释业务语义，只把 decide.ts 的结果翻译成 HTTP。 */
export interface ActionReply {
  readonly status: number
  readonly body: unknown
}

/**
 * 人工闸门的写入口。
 *
 * 抽成接口只为测试注入 —— 生产实现就是 `decideTask` / `answerTask` 的薄包装，
 * 不在这里复制任何状态机逻辑。
 */
export interface ConsoleActions {
  decide(taskId: string, decision: Decision, note: string | undefined): Promise<ActionReply>
  answer(taskId: string, text: string): Promise<ActionReply>
  control(
    taskId: string,
    action: ControlAction,
    expectedMode: ControlMode | undefined,
    note: string | undefined,
  ): Promise<ActionReply>
}

export interface ConsoleDeps {
  readonly query: QueryFn
  /** 省略时用真实 decide / answer（会连库、会建分支） */
  readonly act?: ConsoleActions
  /** 页面令牌。省略时每次进程启动随机生成；测试注入固定值。 */
  readonly token?: string
  /**
   * 登录口令。**必填**：不存在「无鉴权」的默认路径，测试也必须显式给口令。
   * 其余选项（会话时长、限流窗口、时钟）见 `console-auth.ts`。
   */
  readonly auth: AuthOptions
  /** 实际监听地址。决定写端点是否强制 Host 回环；默认 127.0.0.1。 */
  readonly boundHost?: string
  /** 经 HTTPS 反代时给会话 Cookie 加 Secure。 */
  readonly secureCookie?: boolean
}

/** 以 keel_control 角色执行只读查询 —— 与 CLI 共用同一套连接与角色解析。 */
const controlQuery: QueryFn = async (sql, params) =>
  asRole('keel_control', async (c) => (await c.query(sql, params as unknown[])).rows)

/** 错误码 → HTTP 状态。没列出的按 400 处理，绝不把业务失败伪装成 200。 */
const ACTION_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  CAPABILITY_UNSUPPORTED: 400,
}

const defaultActions: ConsoleActions = {
  async control(taskId, action, expectedMode, note) {
    const result = await controlTask(taskId, action, new Date().toISOString(), {
      ...(expectedMode === undefined ? {} : { expectedMode }),
      ...(note === undefined ? {} : { note }),
    })
    if (!result.ok) {
      return {
        status: ACTION_STATUS[result.error.kind] ?? 400,
        body: { ok: false, kind: result.error.kind, error: result.error.detail },
      }
    }
    return { status: 200, body: { ok: true, ...result.value } }
  },
  async decide(taskId, decision, note) {
    const r = await decideTask(taskId, decision, note === undefined ? {} : { note })
    if (!r.ok) {
      return {
        status: ACTION_STATUS[r.error.kind] ?? 400,
        body: { ok: false, kind: r.error.kind, error: r.error.detail },
      }
    }
    return { status: 200, body: { ok: true, ...r.value } }
  },
  async answer(taskId, text) {
    const r = await answerTask(taskId, text)
    if (!r.ok) {
      return {
        status: ACTION_STATUS[r.error.kind] ?? 400,
        body: { ok: false, kind: r.error.kind, error: r.error.detail },
      }
    }
    return { status: 200, body: { ok: true, ...r.value } }
  },
}

function metaPayload() {
  return {
    statuses: {
      stage: STAGE_STATUSES,
      gate: GATE_STATUSES,
      terminal: TERMINAL_STATUSES,
    },
    statusLabels: STATUS_LABELS,
    eventLabels: EVENT_LABELS,
    mainPath: MAIN_PATH,
    transitions: TASK_TRANSITIONS.map((t) => ({
      id: t.id,
      from: t.from,
      to: t.to,
      on: t.on,
      guardText: t.guardText,
    })),
  }
}

/**
 * 页面与 API 统一的安全响应头。
 *
 * CSP 只放行本页真正需要的东西：内联样式 / 脚本（单文件页面的前提）、
 * 同源 fetch、内联 SVG；其余一律拒绝。页面里没有任何外部资源。
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendText(res: ServerResponse, status: number, text: string, type: string): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 未登录访问页面时统一回登录页；不做 401 空白页。 */
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    location,
    'cache-control': 'no-store',
  })
  res.end()
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MAX_BODY = 64 * 1024

function isLoopback(value: string | undefined, withScheme: boolean): boolean {
  if (value === undefined || value === '') return false
  try {
    return LOOPBACK.has(new URL(withScheme ? value : `http://${value}`).hostname)
  } catch {
    return false
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host)
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  if (host === undefined || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 写端点的 CSRF 校验。会话之外仍要全部通过：
 *
 *  1. 绑定回环时，`Host` 必须是回环地址 —— 挡 DNS rebinding（攻击者域名解析到
 *     127.0.0.1 时，浏览器发出的 Host 仍是攻击者域名）；
 *  2. `Origin`（浏览器一定带）必须与 `Host` 同源 —— 绑非回环时同样成立；
 *  3. `Content-Type: application/json` —— 跨源简单请求发不出这个值，
 *     必须走 preflight，而我们对 OPTIONS 一律不回 CORS 头；
 *  4. `X-Keel-Console` 等于本次进程随机令牌 —— 自定义头同样要求 preflight。
 *
 * 登录后会话 Cookie 已是 SameSite=Strict；这四道是纵深防御，不是替代品。
 * 新增写端点时不要放宽其中任何一条。
 */
function writeRejection(
  req: IncomingMessage,
  token: string,
  boundHost: string,
): { status: number; error: string } | undefined {
  const host = headerValue(req, 'host')
  if (isLoopbackHost(boundHost) && !isLoopback(host, false)) {
    return { status: 403, error: 'Host 不是本机回环地址' }
  }
  const origin = headerValue(req, 'origin')
  if (origin !== undefined && origin !== '' && !sameOrigin(origin, host)) {
    return { status: 403, error: 'Origin 与 Host 不同源' }
  }
  const ctype = headerValue(req, 'content-type') ?? ''
  if (!ctype.toLowerCase().startsWith('application/json')) {
    return { status: 415, error: '写请求必须是 application/json' }
  }
  if (headerValue(req, 'x-keel-console') !== token) {
    return { status: 403, error: '缺少或错误的本机令牌' }
  }
  return undefined
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error(`请求体超过 ${MAX_BODY} 字节`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseBody(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** 只接受字符串；缺失返回 undefined，给错类型直接判非法，不做隐式转换 */
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return undefined
  return value.trim().slice(0, max)
}

/**
 * 路由 + 处理。抽成纯函数便于测试：注入假的 query，不依赖真实数据库。
 */
export function createConsoleHandler(
  deps: ConsoleDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const token = deps.token ?? randomBytes(16).toString('hex')
  const page = CONSOLE_HTML.replace(CONSOLE_TOKEN_PLACEHOLDER, token)
  const loginPage = CONSOLE_LOGIN_HTML.replace(CONSOLE_TOKEN_PLACEHOLDER, token)
  const act = deps.act ?? defaultActions
  const auth = new ConsoleAuth(deps.auth)
  const boundHost = deps.boundHost ?? DEFAULT_HOST
  const secureCookie = deps.secureCookie ?? false

  return async (req, res) => {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', URL_BASE)
    const path = url.pathname
    const cookie = headerValue(req, 'cookie')
    const authenticated = auth.isValid(cookie)

    // ── 公开路径 ────────────────────────────────────────────────────────
    // 登录页、登录提交、退出、探活。其余一切先过会话闸门。
    if (path === '/login') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: '该端点只接受 GET' })
        return
      }
      if (authenticated) {
        redirect(res, '/')
        return
      }
      sendText(res, 200, loginPage, 'text/html; charset=utf-8')
      return
    }

    if (path === '/api/login') {
      await handleLogin(auth, token, boundHost, secureCookie, req, res, method)
      return
    }

    // 退出是幂等的：即使会话已过期，也要把浏览器里的旧 Cookie 清掉。
    if (path === '/api/logout') {
      await handleLogout(auth, token, boundHost, secureCookie, req, res, method)
      return
    }

    if (path === '/healthz') {
      try {
        await deps.query('SELECT 1', [])
        sendJson(res, 200, { ok: true })
      } catch (e) {
        // 匿名探活只回答「活着吗」；错误详情与连接串仅登录后可见。
        sendJson(
          res,
          503,
          authenticated
            ? { ok: false, error: message(e), connection: connectionString() }
            : { ok: false },
        )
      }
      return
    }

    // ── 会话闸门 ────────────────────────────────────────────────────────
    if (!authenticated) {
      if (path.startsWith('/api/')) {
        sendJson(res, 401, { ok: false, error: '未登录', detail: '请先登录控制台' })
      } else {
        redirect(res, '/login')
      }
      return
    }

    const action = /^\/api\/tasks\/([^/]+)\/(decide|answer|control)$/.exec(path)
    if (action !== null) {
      await handleAction(act, token, boundHost, req, res, method, action[1] ?? '', action[2] ?? '')
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: '只接受 GET；写操作仅有 /api/tasks/:id/decide|answer|control' })
      return
    }

    if (path === '/' || path === '/index.html') {
      sendText(res, 200, page, 'text/html; charset=utf-8')
      return
    }

    if (path === '/api/meta') {
      sendJson(res, 200, metaPayload())
      return
    }

    if (path === '/api/stats') {
      try {
        const [days, totals] = await Promise.all([
          deps.query(STATS_DAYS_SQL, []),
          deps.query(STATS_TOTALS_SQL, []),
        ])
        sendJson(res, 200, {
          days,
          totals: totals[0] ?? { tasks: 0, tasks_done: 0, runs: 0, cost_usd: '0' },
          generated_at: new Date().toISOString(),
        })
      } catch (e) {
        sendJson(res, 503, {
          error: '数据库不可用',
          detail: message(e),
          connection: connectionString(),
        })
      }
      return
    }

    if (path === '/api/workflows') {
      try {
        const rows = await deps.query(
          `SELECT w.id, w.repo_id, r.remote_url AS repo, r.provider AS repo_provider,
                  w.status, w.current_graph_version,
                  w.request, w.scope_paths, w.external_issue, w.completion_target,
                  w.package_digest, w.baseline_commit, w.last_error,
                  w.created_at, w.updated_at,
                  GREATEST(w.updated_at, n.activity_at) AS activity_at,
                  COALESCE(n.node_count, 0)::int AS node_count,
                  COALESCE(n.archived_count, 0)::int AS archived_count,
                  COALESCE(n.waiting_human, 0)::int AS waiting_human,
                  COALESCE(n.failed_count, 0)::int AS failed_count,
                  COALESCE(n.run_count, 0)::int AS run_count,
                  COALESCE(n.tickets, '[]'::jsonb) AS tickets
           FROM managed_workflow w
           JOIN repo r ON r.id = w.repo_id
           LEFT JOIN LATERAL (
             SELECT count(*) AS node_count,
                    count(*) FILTER (WHERE status = 'ARCHIVED') AS archived_count,
                    count(*) FILTER (WHERE COALESCE(
                      decision_status = 'WAITING_HUMAN',
                      COALESCE(ticket_status, status) = 'WAITING_HUMAN'
                    )) AS waiting_human,
                    count(*) FILTER (WHERE COALESCE(ticket_status, status) = 'FAILED') AS failed_count,
                    sum(run_count) AS run_count,
                    max(activity_at) AS activity_at,
                    jsonb_agg(to_jsonb(nodes) ORDER BY node_key) AS tickets
             FROM (${WORKFLOW_NODE_SELECT}
               WHERE n.workflow_id = w.id AND n.graph_version = w.current_graph_version
             ) nodes
           ) n ON true
           ORDER BY activity_at DESC, w.id`,
          [],
        )
        sendJson(res, 200, { projection: 'jstack-managed-v1', workflows: rows })
      } catch (e) {
        sendJson(res, 503, {
          error: '数据库不可用',
          detail: message(e),
          connection: connectionString(),
        })
      }
      return
    }

    const workflowMatch = /^\/api\/workflows\/([^/]+)$/.exec(path)
    if (workflowMatch !== null) {
      const id = decodeURIComponent(workflowMatch[1] ?? '')
      if (!UUID_RE.test(id)) {
        sendJson(res, 404, { error: 'workflow not found', detail: `不是合法的 workflow id：${id}` })
        return
      }
      try {
        const [workflow, nodes, evidence, graph] = await Promise.all([
          deps.query('SELECT * FROM managed_workflow WHERE id = $1', [id]),
          deps.query(
            `SELECT to_jsonb(nodes) AS node FROM (${WORKFLOW_NODE_SELECT}
             WHERE n.workflow_id = $1
               AND n.graph_version = (SELECT current_graph_version FROM managed_workflow WHERE id = $1)
             ORDER BY n.node_key) nodes`,
            [id],
          ),
          deps.query(
            'SELECT * FROM managed_workflow_evidence WHERE workflow_id = $1 ORDER BY created_at DESC',
            [id],
          ),
          deps.query(
            `SELECT * FROM managed_workflow_graph
             WHERE workflow_id = $1
               AND version = (SELECT current_graph_version FROM managed_workflow WHERE id = $1)`,
            [id],
          ),
        ])
        if (workflow[0] === undefined) {
          sendJson(res, 404, { error: 'workflow not found', detail: `找不到 workflow ${id}` })
          return
        }
        sendJson(res, 200, {
          projection: 'jstack-managed-v1',
          workflow: workflow[0],
          graph: graph[0] ?? null,
          nodes: nodes.map((row) => row.node),
          evidence,
        })
      } catch (e) {
        sendJson(res, 503, {
          error: '数据库不可用',
          detail: message(e),
          connection: connectionString(),
        })
      }
      return
    }

    if (path === '/api/tasks') {
      try {
        const rows = await deps.query(
          `SELECT t.id, t.title, t.status, t.control_mode, t.risk, t.complexity,
                  t.work_branch, t.base_branch, t.budget_usd,
                  t.created_at, t.updated_at, t.terminal_at,
                  r.id AS repo_id, r.remote_url AS repo, r.provider AS repo_provider,
                  COALESCE(rs.run_count, 0)::int AS run_count,
                  COALESCE(rs.total_cost_usd, 0)::text AS total_cost_usd,
                  COALESCE(rs.total_tokens, 0)::text AS total_tokens,
                  COALESCE(es.event_count, 0)::int AS event_count
           FROM task t JOIN repo r ON r.id = t.repo_id
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS run_count,
                    SUM(COALESCE(run.cost_usd, 0)) AS total_cost_usd,
                    SUM(COALESCE(run.tokens_in, 0) + COALESCE(run.tokens_out, 0)) AS total_tokens
             FROM run WHERE run.task_id = t.id
           ) rs ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS event_count
             FROM event WHERE event.task_id = t.id
           ) es ON true
           ORDER BY t.updated_at DESC`,
          [],
        )
        sendJson(res, 200, { projection: 'legacy-v01', tasks: rows })
      } catch (e) {
        sendJson(res, 503, {
          error: '数据库不可用',
          detail: message(e),
          connection: connectionString(),
        })
      }
      return
    }

    const match = /^\/api\/tasks\/([^/]+)$/.exec(path)
    if (match !== null) {
      const id = decodeURIComponent(match[1] ?? '')
      if (!UUID_RE.test(id)) {
        sendJson(res, 404, { error: 'task not found', detail: `不是合法的 task id：${id}` })
        return
      }
      try {
        const detail = await loadTaskDetail(deps.query, id)
        if (detail === undefined) {
          sendJson(res, 404, { error: 'task not found', detail: `找不到 task ${id}` })
          return
        }
        sendJson(res, 200, { projection: 'legacy-v01', ...(detail as Record<string, unknown>) })
      } catch (e) {
        sendJson(res, 503, {
          error: '数据库不可用',
          detail: message(e),
          connection: connectionString(),
        })
      }
      return
    }

    sendJson(res, 404, { error: 'not found', detail: `没有这个路径：${path}` })
  }
}

/**
 * 登录提交。错误文案刻意统一：不区分「口令错误」和「用户不存在」这类不存在的差异，
 * 也不回显任何口令内容。
 */
async function handleLogin(
  auth: ConsoleAuth,
  token: string,
  boundHost: string,
  secureCookie: boolean,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '该端点只接受 POST' })
    return
  }

  const rejected = writeRejection(req, token, boundHost)
  if (rejected !== undefined) {
    sendJson(res, rejected.status, { ok: false, error: rejected.error })
    return
  }

  let payload: Record<string, unknown> | undefined
  try {
    payload = parseBody(await readBody(req))
  } catch (e) {
    if (!res.headersSent) sendJson(res, 413, { ok: false, error: message(e) })
    return
  }
  if (payload === undefined) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
    return
  }
  if (typeof payload.password !== 'string' || payload.password === '') {
    sendJson(res, 400, { ok: false, error: 'password 不能为空' })
    return
  }
  if (payload.remember !== undefined && typeof payload.remember !== 'boolean') {
    sendJson(res, 400, { ok: false, error: 'remember 必须是布尔值' })
    return
  }

  const ip = req.socket.remoteAddress ?? 'unknown'
  const outcome = auth.login(payload.password, ip, payload.remember === true)
  if (!outcome.ok) {
    if (outcome.reason === 'rate-limited') {
      res.setHeader('retry-after', String(outcome.retryAfterSec))
      sendJson(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' })
      return
    }
    sendJson(res, 401, { ok: false, error: '口令不正确' })
    return
  }

  res.setHeader('set-cookie', auth.sessionCookie(outcome.token, outcome.maxAgeSec, secureCookie))
  sendJson(res, 200, { ok: true })
}

/** 退出：删服务端会话 + 清 Cookie。重复调用、会话已过期都返回 200。 */
async function handleLogout(
  auth: ConsoleAuth,
  token: string,
  boundHost: string,
  secureCookie: boolean,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '该端点只接受 POST' })
    return
  }

  const rejected = writeRejection(req, token, boundHost)
  if (rejected !== undefined) {
    sendJson(res, rejected.status, { ok: false, error: rejected.error })
    return
  }

  auth.logout(headerValue(req, 'cookie'))
  res.setHeader('set-cookie', auth.clearCookie(secureCookie))
  sendJson(res, 200, { ok: true })
}

async function handleAction(
  act: ConsoleActions,
  token: string,
  boundHost: string,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rawId: string,
  verb: string,
): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '该端点只接受 POST' })
    return
  }

  const id = decodeURIComponent(rawId)
  if (!UUID_RE.test(id)) {
    sendJson(res, 404, { ok: false, error: 'task not found', detail: `不是合法的 task id：${id}` })
    return
  }

  const rejected = writeRejection(req, token, boundHost)
  if (rejected !== undefined) {
    sendJson(res, rejected.status, { ok: false, error: rejected.error })
    return
  }

  let payload: Record<string, unknown> | undefined
  try {
    payload = parseBody(await readBody(req))
  } catch (e) {
    if (!res.headersSent) sendJson(res, 413, { ok: false, error: message(e) })
    return
  }
  if (payload === undefined) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
    return
  }

  try {
    if (verb === 'control') {
      if (
        typeof payload.action !== 'string' ||
        !(CONTROL_ACTIONS as readonly string[]).includes(payload.action)
      ) {
        sendJson(res, 400, { ok: false, error: `action 必须是 ${CONTROL_ACTIONS.join(' / ')}` })
        return
      }
      if (
        payload.expected_mode !== undefined &&
        (typeof payload.expected_mode !== 'string' ||
          !(CONTROL_MODES as readonly string[]).includes(payload.expected_mode))
      ) {
        sendJson(res, 400, { ok: false, error: 'expected_mode 必须是 auto / paused / human' })
        return
      }
      if (
        payload.note !== undefined &&
        (typeof payload.note !== 'string' || payload.note.length > 8000)
      ) {
        sendJson(res, 400, { ok: false, error: 'note 必须是最多 8000 字的字符串' })
        return
      }
      const reply = await act.control(
        id,
        payload.action as ControlAction,
        payload.expected_mode as ControlMode | undefined,
        payload.note as string | undefined,
      )
      sendJson(res, reply.status, reply.body)
      return
    }
    if (verb === 'decide') {
      const decision = payload.decision
      if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
        sendJson(res, 400, { ok: false, error: `decision 必须是 ${DECISIONS.join(' / ')}` })
        return
      }
      if (payload.note !== undefined && typeof payload.note !== 'string') {
        sendJson(res, 400, { ok: false, error: 'note 必须是字符串' })
        return
      }
      const note = optionalText(payload.note, 2000)
      const reply = await act.decide(id, decision as Decision, note === '' ? undefined : note)
      sendJson(res, reply.status, reply.body)
      return
    }

    if (typeof payload.text !== 'string' || payload.text.trim() === '') {
      sendJson(res, 400, { ok: false, error: 'text 不能为空' })
      return
    }
    const reply = await act.answer(id, payload.text.trim().slice(0, 8000))
    sendJson(res, reply.status, reply.body)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: message(e) })
  }
}

async function loadTaskDetail(query: QueryFn, id: string): Promise<unknown | undefined> {
  const tasks = await query(
    `SELECT t.id, t.title, t.status, t.control_mode, t.repo_id, t.base_branch, t.work_branch,
            t.risk, t.complexity, t.budget_usd, t.current_run_id,
            t.created_at, t.updated_at, t.terminal_at,
            r.remote_url AS repo, r.provider AS repo_provider
     FROM task t JOIN repo r ON r.id = t.repo_id
     WHERE t.id = $1`,
    [id],
  )
  const task = tasks[0]
  if (task === undefined) return undefined

  const runs = await query(
    `SELECT r.id, r.stage, r.role, r.attempt, r.status, r.harness_id, r.harness_tier, r.session_ref,
            r.started_at, r.ended_at, r.error_kind, r.error_detail,
            r.tokens_in, r.tokens_out, r.cost_usd, r.cost_basis,
            CASE WHEN l.run_id IS NOT NULL THEN json_build_object(
              'last_progress_at', l.last_progress_at,
              'silence_threshold_ms', l.silence_ms,
              'owner_heartbeat_at', l.owner_heartbeat_at
            ) ELSE NULL END AS liveness
     FROM run r
     LEFT JOIN run_liveness l ON l.run_id = r.id AND r.status = 'RUNNING'
     WHERE r.task_id = $1
     ORDER BY r.started_at NULLS LAST, r.attempt`,
    [id],
  )

  const events = await query(
    `SELECT seq, run_id, type, payload, trace_id, span_id, occurred_at
     FROM event WHERE task_id = $1 ORDER BY seq`,
    [id],
  )

  const artifacts = await query(
    `SELECT id, kind, key, version, schema_version, produced_by_run,
            committed_at, committed_at_seq, superseded_by, body
     FROM artifact WHERE task_id = $1
     ORDER BY kind, key, version DESC`,
    [id],
  )

  const feedbacks = await query(
    `SELECT f.id, f.source, f.external_ref, f.body, f.received_at
     FROM task_feedback tf JOIN feedback f ON f.id = tf.feedback_id
     WHERE tf.task_id = $1
     ORDER BY f.received_at`,
    [id],
  )

  const timers = await query(
    `SELECT id, run_id, kind, due_at, state, fired_at, created_at, updated_at
     FROM timer WHERE task_id = $1
     ORDER BY created_at`,
    [id],
  )

  return { task, runs, events, artifacts, feedbacks, timers }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`KEEL_CONSOLE_PORT 不是合法端口：${raw}`)
  }
  return n
}

function parseHost(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_HOST
  const host = raw.trim()
  if (host === '' || host.includes('/') || host.includes('://') || /\s/.test(host)) {
    throw new Error(`KEEL_CONSOLE_HOST 不是合法主机：${raw}`)
  }
  return host
}

function secureCookieFromEnv(env: NodeJS.ProcessEnv): boolean {
  const raw = env.KEEL_CONSOLE_SECURE_COOKIE
  return raw === '1' || raw === 'true'
}

export interface StartConsoleOptions {
  readonly port?: number
  readonly host?: string
  readonly query?: QueryFn
  readonly auth?: AuthOptions
  readonly secureCookie?: boolean
}

/** 启动控制台。返回 listen 完成后的 Server，便于测试与优雅关闭。 */
export function startConsole(opts: StartConsoleOptions = {}): Promise<Server> {
  const host = opts.host ?? parseHost(process.env.KEEL_CONSOLE_HOST)
  const resolved = resolveConsoleAuth(process.env)
  const deps: ConsoleDeps = {
    query: opts.query ?? controlQuery,
    auth: opts.auth ?? { password: resolved.password },
    boundHost: host,
    secureCookie: opts.secureCookie ?? secureCookieFromEnv(process.env),
  }
  const handler = createConsoleHandler(deps)
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: message(e) })
      else res.end()
    })
  })

  const port = opts.port ?? parsePort(process.env.KEEL_CONSOLE_PORT)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

export async function consoleMain(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`用法: keel console

Web 控制台，默认 http://${DEFAULT_HOST}:${DEFAULT_PORT}
  KEEL_CONSOLE_PORT           端口（默认 ${DEFAULT_PORT}）
  KEEL_CONSOLE_HOST           监听地址（默认 ${DEFAULT_HOST}；0.0.0.0 对外）
  KEEL_CONSOLE_PASSWORD       访问口令；未设置时每次启动随机生成并打印
  KEEL_CONSOLE_SECURE_COOKIE  设为 1 时会话 Cookie 加 Secure（反代 HTTPS）
  KEEL_DATABASE_URL           数据库连接串（与 CLI 共用）

读：全部事实只走 SELECT。
写：POST /api/tasks/:id/decide|answer|control，
    与 CLI 共用人工闸门 driver 或驾驶模式控制事务。
鉴权：除 /login、POST /api/login、POST /api/logout、/healthz 外都需要登录。`)
    return
  }

  const host = parseHost(process.env.KEEL_CONSOLE_HOST)
  const resolved = resolveConsoleAuth(process.env)
  const server = await startConsole({ host, auth: { password: resolved.password } })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : DEFAULT_PORT

  if (host === '0.0.0.0' || host === '::') {
    console.log(`keel console: http://${DEFAULT_HOST}:${port}（监听 ${host}:${port}）`)
  } else {
    console.log(`keel console: http://${host}:${port}`)
  }
  if (resolved.source === 'generated') {
    console.log(
      `访问口令: ${resolved.password}  （本次进程随机生成；设置 KEEL_CONSOLE_PASSWORD 可固定）`,
    )
  } else {
    console.log('访问口令: 由 KEEL_CONSOLE_PASSWORD 提供')
  }
  if (!isLoopbackHost(host)) {
    console.log(`⚠ 正在监听非回环地址 ${host}；请确认网络边界，建议由反向代理终止 TLS。`)
  }
  console.log(`数据库: ${connectionString()}`)
  console.log('读取全量事实；人工闸门的批准 / 驳回 / 返工 / 澄清可在页面上直接提交。')
  console.log('Ctrl-C 退出。')

  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在关闭…`)
    server.close(() => {
      void closePool()
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

const invokedDirectly =
  process.argv[1]?.endsWith('console.ts') === true ||
  process.argv[1]?.endsWith('console.js') === true

if (invokedDirectly) {
  consoleMain(process.argv.slice(2)).catch(async (e) => {
    console.error(`keel console: ${message(e)}`)
    await closePool().catch(() => undefined)
    process.exitCode = 1
  })
}
