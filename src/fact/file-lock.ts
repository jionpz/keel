/**
 * 文件锁：用原子 `mkdir` 串行化同一个 git 目录上的操作。
 *
 * 为什么需要：`ensureBareRepo` 原本是「存在就复用，否则 clone」。两个 run 同时
 * 启动时，第二个会在第一个 clone 到一半时看到目录已存在，于是把一个残缺仓库
 * 当成可用的；fetch 与 worktree add 也会撞 `.git/index.lock` 或 ref 锁。
 *
 * 为什么不用 `proper-lockfile`：锁的语义只有「mkdir 成功即持有」，加一个依赖
 * 换不来更多保证。
 *
 * 为什么不自动破锁：锁目录里的 `owner.json` 只用于诊断。进程卡在慢 fetch 上时
 * 自动删除会让两个进程同时持锁——那比等 30 秒更糟。超时后由人确认再删。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { err, type Result } from '../contracts/errors.js'
import { workspaceError } from './workspace-error.js'

export interface FileLockOptions {
  /** 等锁上限，默认 30s */
  readonly timeoutMs?: number
  /** 轮询间隔，默认 50ms */
  readonly pollMs?: number
  /** 超过这个时长只作为「疑似陈旧」写进错误，不自动破锁 */
  readonly staleMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

const DEFAULTS = {
  timeoutMs: 30_000,
  pollMs: 50,
  staleMs: 10 * 60_000,
} as const

/**
 * 在 `lockDir` 上持有排他锁执行 `fn`。
 *
 * `fn` 返回 Result；无论返回还是抛异常，锁都会在 finally 里释放。
 */
export async function withFileLock<T>(
  lockDir: string,
  op: string,
  fn: () => Promise<Result<T>>,
  opts: FileLockOptions = {},
): Promise<Result<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs
  const staleMs = opts.staleMs ?? DEFAULTS.staleMs
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now

  const startedAt = now()
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (e) {
      if (!isExists(e)) {
        return err(workspaceError('lock_failed', { lock: lockDir, op, detail: msg(e) }))
      }
      const waited = now() - startedAt
      if (waited >= timeoutMs) {
        return err(
          workspaceError('lock_timeout', {
            lock: lockDir,
            op,
            waited_ms: waited,
            holder: describeHolder(lockDir, staleMs, now),
          }),
        )
      }
      await sleep(pollMs)
    }
  }

  try {
    writeOwner(lockDir, op, new Date(now()).toISOString())
    return await fn()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

interface OwnerInfo {
  readonly pid?: number
  readonly host?: string
  readonly started_at?: string
  readonly op?: string
}

function writeOwner(lockDir: string, op: string, startedAt: string): void {
  // 诊断信息写不进去不影响持锁本身
  try {
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), started_at: startedAt, op }),
    )
  } catch {
    // ignore
  }
}

function readOwner(lockDir: string): OwnerInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as OwnerInfo
  } catch {
    return undefined
  }
}

/** 只描述，不判断、不清理 —— 清理会引入双重持锁窗口 */
function describeHolder(lockDir: string, staleMs: number, now: () => number): string {
  const owner = readOwner(lockDir)
  if (owner === undefined) return 'unknown'
  const age = owner.started_at === undefined ? undefined : now() - Date.parse(owner.started_at)
  const stale = age !== undefined && age > staleMs ? ', suspected stale' : ''
  return `pid=${owner.pid ?? '?'} host=${owner.host ?? '?'} op=${owner.op ?? '?'}${stale}`
}

function isExists(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'EEXIST'
  )
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const withStderr = e as Error & { stderr?: string }
    return withStderr.stderr?.trim() || e.message
  }
  return String(e)
}

/** 测试与诊断用：读锁当前持有者，不改变状态 */
export { readOwner }
