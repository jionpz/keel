/**
 * 项目根与本地目录的路径规范化。
 *
 * 两个问题都在这里解决：
 *
 * 1. **项目根不能依赖 cwd**：默认 `.keel` 是相对路径，不同命令从不同目录启动
 *    会指向两个项目根，git 锁、worktree、仓库副本全部对不上。
 * 2. **一个目录只有一个规范名**：`/repo`、`/repo/`、`/repo/./`、相对路径、
 *    符号链接在字符串层面互不相等，但它们是同一个目录。绑定唯一性必须建立在
 *    同一字符串上，否则同一工作树会被两个 repo 认领。
 *
 * 事实来源：.trellis/tasks/10-27-local-project-binding/design.md §3。
 */

import { execFile } from 'node:child_process'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { err, ok, type Result } from '../contracts/errors.js'
import { normalizeRemoteUrl } from './remote-url.js'
import { workspaceError } from './workspace-error.js'

const exec = promisify(execFile)

/**
 * 解析项目根为绝对路径。
 *
 * 相对 `KEEL_HOME` 按**进程启动时的 cwd** 解析一次；目录不存在则创建。
 * 返回 `realpath` 后的结果，保证同一物理目录只有一个名字。
 */
export function resolveKeelHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const abs = resolve(cwd, env.KEEL_HOME ?? '.keel')
  mkdirSync(abs, { recursive: true })
  return realpathSync(abs)
}

/**
 * 把用户给的目录规范化：`resolve` → 必须是已存在目录 → `realpath`。
 *
 * `realpath` 同时消掉尾斜杠、`.`/`..`、重复分隔符与符号链接。
 * 目录不存在时**不创建** —— 绑定一个不存在的路径只会把错误推迟到开工时。
 */
export function canonicalizeDir(input: string, cwd: string = process.cwd()): Result<string> {
  const abs = resolve(cwd, input)
  let isDir = false
  try {
    isDir = statSync(abs).isDirectory()
  } catch {
    return err(
      workspaceError('local_path_missing', {
        path: abs,
        hint: 'keel register-repo <remoteUrl> --local-path <dir>',
      }),
    )
  }
  if (!isDir) {
    return err(workspaceError('local_path_missing', { path: abs, detail: '不是目录' }))
  }
  try {
    return ok(realpathSync(abs))
  } catch (e) {
    return err(workspaceError('local_path_missing', { path: abs, detail: msg(e) }))
  }
}

export interface AttachedDir {
  /** 规范化后的绝对路径 */
  readonly path: string
  /** 该目录 origin 的归一化 URL */
  readonly origin: string
}

/**
 * 校验一个目录可以作为 attached 绑定：
 * 存在、是 git 工作树、origin 与注册的 remote 归一化后一致。
 *
 * 校验只读：不 fetch、不 checkout，也不修改用户仓库。
 */
export async function validateAttachedDir(
  input: string,
  remoteUrl: string,
  cwd: string = process.cwd(),
): Promise<Result<AttachedDir>> {
  const canonical = canonicalizeDir(input, cwd)
  if (!canonical.ok) return canonical

  const dir = canonical.value
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.value.trim() !== 'true') {
    return err(workspaceError('not_a_git_worktree', { path: dir }))
  }

  const originResult = await git(dir, ['remote', 'get-url', 'origin'])
  if (!originResult.ok) {
    return err(
      workspaceError('origin_mismatch', {
        expected: normalizeRemoteUrl(remoteUrl),
        actual: '(none)',
        path: dir,
      }),
    )
  }

  const expected = normalizeRemoteUrl(remoteUrl)
  const actual = normalizeRemoteUrl(originResult.value.trim())
  if (expected !== actual) {
    return err(workspaceError('origin_mismatch', { expected, actual, path: dir }))
  }

  return ok({ path: dir, origin: actual })
}

async function git(cwd: string, args: readonly string[]): Promise<Result<string>> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args])
    return ok(stdout)
  } catch (e) {
    return err(workspaceError('not_a_git_worktree', { path: cwd, detail: msg(e) }))
  }
}

export function msg(e: unknown): string {
  if (e instanceof Error) {
    const withStderr = e as Error & { stderr?: string }
    return withStderr.stderr?.trim() || e.message
  }
  return String(e)
}
