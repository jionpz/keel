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
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { err, ok, type Result } from '../contracts/errors.js'
import { normalizeRemoteUrl } from './remote-url.js'
import { workspaceError } from './workspace-error.js'

const exec = promisify(execFile)

/**
 * 解析项目根为绝对路径。
 *
 * 优先级：
 *   1. 显式 `KEEL_HOME`（按 cwd 解析；保持既有语义）
 *   2. 从 cwd 向上查找最近的已有 `.keel` 目录
 *   3. 从 cwd 向上查找最近的 `.git` **目录**，在其所在层创建 `.keel`
 *   4. 都没有 → `<cwd>/.keel`
 *
 * 为什么向上找：默认 `.keel` 如果永远相对 cwd，从 `src/cli` 和仓库根启动
 * 会得到两个项目根，git 锁、worktree、仓库副本全部对不上——同一份代码
 * 变成两个世界。项目树内任意子目录启动必须命中同一个根。
 *
 * `.git` 只认目录：worktree / submodule 的 `.git` 是文件，指向别处的
 * 公共 git 目录；把它们当成项目根会落到一个没有仓库内容的上层目录。
 *
 * 返回 `realpath` 后的结果，保证同一物理目录只有一个名字。
 */
export function resolveKeelHome(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.KEEL_HOME
  if (explicit !== undefined && explicit !== '') return ensureDir(resolve(cwd, explicit))
  return ensureDir(findProjectHome(cwd))
}

function findProjectHome(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    const keel = join(dir, '.keel')
    if (isDirectory(keel)) return keel
    if (isDirectory(join(dir, '.git'))) return keel
    const parent = dirname(dir)
    if (parent === dir) return join(start, '.keel')
    dir = parent
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function ensureDir(abs: string): string {
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
