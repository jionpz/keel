/**
 * keel status —— 查 task / run / 事件摘要(issue #27)。
 *
 * 末尾追加**工作区绑定与基线**：一个 task 到底绑在哪个项目、PR 从哪个
 * commit 长出来，必须能一条命令答出来，否则「本地项目绑定」对用户是隐形的。
 * 既有 task / run / events 的输出格式保持不变。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { asOwner } from '../fact/db.js'
import { canonicalizeDir } from '../fact/project-root.js'
import { parseArgs } from './argv.js'

const exec = promisify(execFile)

export async function statusMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel status <taskId> [--events N]

查 task 状态 / run 明细 / 最近事件(N 缺省 20)。`)
    return
  }
  const taskId = positionals[0]
  if (taskId === undefined) return
  const eventsN =
    typeof flags.events === 'number'
      ? flags.events
      : typeof flags.events === 'string'
        ? Number(flags.events)
        : 20

  const task = await asOwner((c) =>
    c.query<{
      status: string
      control_mode: string
      created_at: string
      updated_at: string
      terminal_at: string | null
    }>(
      `SELECT status, control_mode, created_at, updated_at, terminal_at
       FROM task WHERE id = $1`,
      [taskId],
    ),
  )
  const row = task.rows[0]
  if (row === undefined) {
    console.error(`status: 找不到 task ${taskId}`)
    process.exitCode = 1
    return
  }
  console.log(`task ${taskId}: ${row.status} [${row.control_mode}]`)
  console.log(
    `  created=${row.created_at} updated=${row.updated_at} terminal_at=${row.terminal_at ?? '(未终态)'}`,
  )

  const runs = await asOwner((c) =>
    c.query<{ stage: string; attempt: number; status: string; error_kind: string | null }>(
      `SELECT stage, attempt, status, error_kind FROM run WHERE task_id = $1 ORDER BY attempt`,
      [taskId],
    ),
  )
  if (runs.rows.length > 0) {
    console.log('runs:')
    for (const r of runs.rows) {
      console.log(
        `  ${r.stage} #${r.attempt}: ${r.status}${r.error_kind !== null ? ` (${r.error_kind})` : ''}`,
      )
    }
  }

  const events = await asOwner((c) =>
    c.query<{ seq: string; type: string; payload: Record<string, unknown> }>(
      `SELECT seq, type, payload FROM event WHERE task_id = $1 ORDER BY seq DESC LIMIT $2`,
      [taskId, eventsN],
    ),
  )
  if (events.rows.length > 0) {
    console.log(`events (最近 ${events.rows.length}):`)
    for (const e of [...events.rows].reverse()) {
      const payload = JSON.stringify(e.payload).slice(0, 80)
      console.log(`  #${e.seq} ${e.type} ${payload}`)
    }
  }

  await printWorkspace(taskId)
}

/**
 * 工作区绑定 + 基线 + 本地状态。
 *
 * 只读：attached 模式会跑 `git status` / `git rev-list`，但绝不写用户工作树。
 * 输出只含路径、commit、计数 —— 不带 remote URL 的凭据部分（URL 本身可能含 token，
 * 所以这里根本不打印 remote_url）。
 */
async function printWorkspace(taskId: string): Promise<void> {
  const repo = await asOwner((c) =>
    c.query<{ id: string; default_branch: string; local_path: string | null }>(
      `SELECT r.id, r.default_branch, r.local_path
       FROM repo r JOIN task t ON t.repo_id = r.id WHERE t.id = $1`,
      [taskId],
    ),
  )
  const r = repo.rows[0]
  if (r === undefined) return

  console.log('workspace:')
  console.log(`  repo ${r.id} (${r.local_path === null ? 'managed' : 'attached'})`)

  if (r.local_path !== null) {
    const canonical = canonicalizeDir(r.local_path)
    console.log(
      canonical.ok
        ? `  local_path ${canonical.value}`
        : `  local_path ${r.local_path} (unresolved)`,
    )
  }

  const base = await asOwner((c) =>
    c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM event
       WHERE task_id = $1 AND type = 'SideEffectApplied' AND payload->>'kind' = 'CreateBranch'
       ORDER BY seq DESC LIMIT 1`,
      [taskId],
    ),
  )
  const ev = base.rows[0]?.payload
  if (ev === undefined) {
    console.log('  base (尚无建分支记录)')
  } else if (typeof ev.base_sha === 'string') {
    console.log(
      `  base ${String(ev.base_ref ?? '(unknown)')}@${ev.base_sha}` +
        ` fetched=${String(ev.fetched_at ?? '(unknown)')}` +
        `${ev.reused === true ? ' (reused)' : ''}`,
    )
  } else {
    // 老 task：本功能之前建的分支，没有基线证据 —— 如实标注，不编造
    console.log(`  base ${String(ev.base_ref ?? '(unknown)')}@(无基线证据)`)
  }

  if (r.local_path !== null) {
    console.log(`  local ${await localState(r.local_path, r.default_branch)}`)
  }
}

/** attached 模式才计算：改动与相对基线的偏离。失败只报 unavailable，不抛 */
async function localState(path: string, defaultBranch: string): Promise<string> {
  try {
    const dirty = (await exec('git', ['-C', path, 'status', '--porcelain'])).stdout.trim()
    let diverged = 'unknown'
    try {
      const counts = (
        await exec('git', [
          '-C',
          path,
          'rev-list',
          '--left-right',
          '--count',
          `HEAD...refs/remotes/origin/${defaultBranch}`,
        ])
      ).stdout.trim()
      const [ahead, behind] = counts.split(/\s+/)
      diverged = `ahead ${ahead ?? '?'} / behind ${behind ?? '?'}`
    } catch {
      // 没有 origin/<branch>（本地仓库、未 fetch）不是错误，只是算不出来
    }
    return `dirty=${dirty === '' ? 'no' : 'yes'} diverged=${diverged}`
  } catch {
    return 'unavailable'
  }
}
