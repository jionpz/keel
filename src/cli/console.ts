/**
 * keel console —— 只读 Web 控制台。
 *
 * 定位（docs/09-roadmap.md）：UI 是 Fact Plane 的**消费者**，不是被验证的东西。
 * 因此本文件：
 *   - 只有 SELECT，没有任何写入路径；
 *   - 以 `keel_control` 角色访问（该角色对事实表只有 SELECT / INSERT，控制台只用 SELECT）；
 *   - 只绑定 127.0.0.1，不提供鉴权 —— 它是本地观测面，不是服务端产品。
 *
 * 用法：
 *   pnpm run console            # 默认 http://127.0.0.1:4321
 *   KEEL_CONSOLE_PORT=4322 pnpm run console
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { TASK_TRANSITIONS } from '../control/transition/table.js'
import { asRole, closePool, connectionString } from '../fact/db.js'
import { GATE_STATUSES, STAGE_STATUSES, TERMINAL_STATUSES } from '../shared/ids.js'
import { CONSOLE_HTML } from './console-page.js'

const DEFAULT_PORT = 4321
const HOST = '127.0.0.1'
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

export type Row = Record<string, unknown>
export type QueryFn = (sql: string, params: readonly unknown[]) => Promise<readonly Row[]>

export interface ConsoleDeps {
  readonly query: QueryFn
}

/** 以 keel_control 角色执行只读查询 —— 与 CLI 共用同一套连接与角色解析。 */
const controlQuery: QueryFn = async (sql, params) =>
  asRole('keel_control', async (c) => (await c.query(sql, params as unknown[])).rows)

function metaPayload() {
  return {
    statuses: {
      stage: STAGE_STATUSES,
      gate: GATE_STATUSES,
      terminal: TERMINAL_STATUSES,
    },
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendText(res: ServerResponse, status: number, text: string, type: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 路由 + 处理。抽成纯函数便于测试：注入假的 query，不依赖真实数据库。
 */
export function createConsoleHandler(
  deps: ConsoleDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: '只读控制台：只接受 GET' })
      return
    }

    const url = new URL(req.url ?? '/', `http://${HOST}`)
    const path = url.pathname

    if (path === '/' || path === '/index.html') {
      sendText(res, 200, CONSOLE_HTML, 'text/html; charset=utf-8')
      return
    }

    if (path === '/api/meta') {
      sendJson(res, 200, metaPayload())
      return
    }

    if (path === '/healthz') {
      try {
        await deps.query('SELECT 1', [])
        sendJson(res, 200, { ok: true })
      } catch (e) {
        sendJson(res, 503, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          connection: connectionString(),
        })
      }
      return
    }

    if (path === '/api/tasks') {
      try {
        const rows = await deps.query(
          `SELECT t.id, t.title, t.status, t.control_mode, t.created_at, t.updated_at,
                  t.terminal_at, r.remote_url AS repo
           FROM task t JOIN repo r ON r.id = t.repo_id
           ORDER BY t.updated_at DESC`,
          [],
        )
        sendJson(res, 200, { tasks: rows })
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
        sendJson(res, 200, detail)
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

async function loadTaskDetail(query: QueryFn, id: string): Promise<unknown | undefined> {
  const tasks = await query(
    `SELECT t.id, t.title, t.status, t.control_mode, t.repo_id, t.base_branch, t.work_branch,
            t.risk, t.complexity, t.created_at, t.updated_at, t.terminal_at,
            r.remote_url AS repo
     FROM task t JOIN repo r ON r.id = t.repo_id
     WHERE t.id = $1`,
    [id],
  )
  const task = tasks[0]
  if (task === undefined) return undefined

  const runs = await query(
    `SELECT stage, role, attempt, status, harness_id, harness_tier,
            started_at, ended_at, error_kind, error_detail
     FROM run WHERE task_id = $1
     ORDER BY started_at NULLS LAST, attempt`,
    [id],
  )

  const events = await query(
    `SELECT seq, run_id, type, payload, occurred_at
     FROM event WHERE task_id = $1 ORDER BY seq`,
    [id],
  )

  const artifacts = await query(
    `SELECT DISTINCT ON (kind, key) kind, key, version, committed_at, body
     FROM artifact WHERE task_id = $1
     ORDER BY kind, key, version DESC`,
    [id],
  )

  return { task, runs, events, artifacts }
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

/** 启动控制台。返回 listen 完成后的 Server，便于测试与优雅关闭。 */
export function startConsole(
  opts: { readonly port?: number; readonly query?: QueryFn } = {},
): Promise<Server> {
  const deps: ConsoleDeps = { query: opts.query ?? controlQuery }
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
    server.listen(port, HOST, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

export async function consoleMain(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`用法: keel console

只读 Web 控制台，默认 http://${HOST}:${DEFAULT_PORT}
  KEEL_CONSOLE_PORT  端口（默认 ${DEFAULT_PORT}）
  KEEL_DATABASE_URL  数据库连接串（与 CLI 共用）`)
    return
  }

  const server = await startConsole()
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : DEFAULT_PORT
  console.log(`keel console: http://${HOST}:${port}`)
  console.log(`数据库: ${connectionString()}`)
  console.log('只读。Ctrl-C 退出。')

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
