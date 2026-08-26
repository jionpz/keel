/**
 * O4 · 一条命令导出某 Task 的完整时间线。
 *
 * 要求来源：docs/08-cross-cutting.md §2.5 —— O4「一条命令能导出某 Task 的完整时间线」。
 * 数据源是**事件流本身**（ArtifactStore.readEvents），不是日志检索：
 * 「这个 Task 到底发生了什么」的答案必须全部来自 Fact Plane（§2.2）。
 *
 * 用法：
 *   pnpm run timeline -- <task_id>
 *
 * 失败纪律（.trellis/spec/backend/error-handling.md）：
 *   - 缺参数 / 非 UUID → exit 1 + 用法说明；
 *   - task 不存在 → exit 1（「0 条事件」与「查错了 task」必须可区分，防假绿）；
 *   - 数据库连不上 → exit 1 + 怎么修，不静默输出空时间线。
 */

import { PgArtifactStore } from '../src/fact/artifact-store.js'
import { asRole, closePool, connectionString } from '../src/fact/db.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 每页读取条数。分页读完为止 —— 「完整时间线」不允许静默截断 */
const PAGE = 1000

/** payload 摘要的最大长度。完整内容可按 seq 回数据库取，摘要只为可读 */
const SUMMARY_MAX = 200

function usage(): void {
  console.error('用法：pnpm run timeline -- <task_id>')
  console.error('  task_id 必须是 UUID，例如 pnpm run timeline -- 3f0e…-…')
}

function summarize(payload: unknown): string {
  const s = JSON.stringify(payload)
  if (s === undefined) return '{}'
  return s.length <= SUMMARY_MAX ? s : `${s.slice(0, SUMMARY_MAX)}…(${s.length} chars)`
}

async function main(): Promise<void> {
  // pnpm 会把 `pnpm run timeline -- <id>` 里的 `--` 原样传下来，跳过它
  const taskId = process.argv.slice(2).find((a) => a !== '--')
  if (taskId === undefined || !UUID_RE.test(taskId)) {
    usage()
    process.exit(1)
  }

  // 先确认 task 存在 —— 否则「0 条事件」会把打错的 id 伪装成空时间线
  let exists: boolean
  try {
    const r = await asRole('keel_control', (c) =>
      c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
    )
    exists = r.rows.length > 0
    if (exists) {
      console.log(`# task ${taskId}（当前状态：${r.rows[0]?.status}）`)
    }
  } catch (e) {
    console.error(`✗ 数据库不可用：${e instanceof Error ? e.message : String(e)}`)
    console.error(`  当前连接串：${connectionString()}`)
    console.error('  设置 KEEL_DATABASE_URL 指向已迁移的库，例如 postgres://localhost/keel_dev')
    process.exit(1)
  }
  if (!exists) {
    console.error(`✗ 找不到 task ${taskId} —— 不输出空时间线冒充「没发生过事」`)
    process.exit(1)
  }

  const store = new PgArtifactStore()
  let from = 0
  let total = 0

  for (;;) {
    const page = await store.readEvents(taskId, from, PAGE)
    if (!page.ok) {
      console.error(`✗ 读事件失败：${page.error.detail}`)
      process.exit(1)
    }
    for (const ev of page.value) {
      const run = ev.run_id === null || ev.run_id === undefined ? '-' : ev.run_id.slice(0, 8)
      console.log(
        `${String(ev.seq).padStart(6)}  ${ev.occurred_at}  ${ev.type.padEnd(20)}  run=${run.padEnd(8)}  ${summarize(ev.payload)}`,
      )
    }
    total += page.value.length
    if (page.value.length < PAGE) break
    const last = page.value.at(-1)
    if (last === undefined) break
    from = last.seq + 1
  }

  console.log(`# 共 ${total} 条事件`)
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(`✗ 时间线导出失败：${e instanceof Error ? e.message : String(e)}`)
    await closePool().catch(() => undefined)
    process.exit(1)
  })
