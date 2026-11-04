/**
 * `keel unlock` —— 清理 SIGKILL 留下的 per-repo 文件锁。
 *
 * 为什么需要显式入口：锁是 `mkdir` 的原子性，持有者进程被 `kill -9` 后
 * 锁目录会一直存在，poller 每次都在 `lock_timeout` 上等待（默认 30s），
 * 而错误里只有 pid / host，运维必须自己猜锁在哪、能不能删。
 *
 * 为什么不自动破锁：`mkdir` 锁无法无竞争地判断「持有者已死」——
 * 进程可能只是卡在慢 fetch 上。自动删除会让两个进程同时持锁，
 * 那比等 30 秒更糟。所以这里要求人确认，且必须显式 `--force`。
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type OwnerInfo, readOwner } from '../fact/file-lock.js'
import { resolveKeelHome } from '../fact/project-root.js'

export const UNLOCK_USAGE = '用法: keel unlock <repoId> [--force]'

export type UnlockResult =
  | { readonly status: 'absent'; readonly lock: string }
  | { readonly status: 'held'; readonly lock: string; readonly holder: OwnerInfo | undefined }
  | { readonly status: 'unlocked'; readonly lock: string; readonly holder: OwnerInfo | undefined }
  | { readonly status: 'failed'; readonly lock: string; readonly reason: string }
  | { readonly status: 'invalid'; readonly reason: string }

export interface UnlockOptions {
  /** 项目根；缺省按 `resolveKeelHome` 解析。测试注入临时目录 */
  readonly root?: string
  /** 只有显式 true 才删除锁目录 */
  readonly force?: boolean
}

/**
 * repoId 直接参与文件名（`repo-<id>.lock`），必须挡掉路径分隔符与 `..`。
 * 仓库 id 由 Keel 生成（UUID），限制为安全字符不会误伤真实数据。
 */
const REPO_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function lockPathFor(root: string, repoId: string): string {
  return join(root, 'locks', `repo-${repoId}.lock`)
}

export function unlockRepo(repoId: string, opts: UnlockOptions = {}): UnlockResult {
  if (!REPO_ID_PATTERN.test(repoId)) {
    return {
      status: 'invalid',
      reason: `repoId 只能包含字母、数字、下划线与连字符：${JSON.stringify(repoId)}`,
    }
  }

  const root = opts.root ?? resolveKeelHome()
  const lock = lockPathFor(root, repoId)
  if (!existsSync(lock)) return { status: 'absent', lock }

  const holder = readOwner(lock)
  if (opts.force !== true) return { status: 'held', lock, holder }

  try {
    rmSync(lock, { recursive: true, force: true })
    return { status: 'unlocked', lock, holder }
  } catch (e) {
    return { status: 'failed', lock, reason: msg(e) }
  }
}

/** 人读的持有者摘要；与 file-lock 的 lock_timeout 文案保持同一套字段 */
function describeHolder(owner: OwnerInfo | undefined): string {
  if (owner === undefined) return 'unknown（锁目录里没有 owner.json）'
  return [
    `pid=${owner.pid ?? '?'}`,
    `host=${owner.host ?? '?'}`,
    `op=${owner.op ?? '?'}`,
    `started_at=${owner.started_at ?? '?'}`,
  ].join(' ')
}

export function unlockMain(argv: readonly string[]): void {
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--force')
  if (unknown.length > 0) {
    console.error(`未知选项: ${unknown.join(' ')}`)
    console.error(UNLOCK_USAGE)
    process.exitCode = 2
    return
  }

  const repoId = argv.find((a) => !a.startsWith('-'))
  if (repoId === undefined) {
    console.error(UNLOCK_USAGE)
    process.exitCode = 2
    return
  }

  const result = unlockRepo(repoId, { force: argv.includes('--force') })
  switch (result.status) {
    case 'invalid':
      console.error(result.reason)
      process.exitCode = 2
      return
    case 'absent':
      console.log(`无锁：${result.lock}`)
      return
    case 'held':
      console.error(`锁被持有：${result.lock}`)
      console.error(`持有者：${describeHolder(result.holder)}`)
      console.error('确认该进程已不在运行后，再用 --force 删除；未确认时不要破锁。')
      process.exitCode = 1
      return
    case 'unlocked':
      console.log(`已删除锁：${result.lock}`)
      if (result.holder !== undefined) console.log(`原持有者：${describeHolder(result.holder)}`)
      return
    case 'failed':
      console.error(`删除锁失败：${result.lock}`)
      console.error(result.reason)
      process.exitCode = 1
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
