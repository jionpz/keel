import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { sha256Text } from '../../shared/canonical-json.js'

const run = promisify(execFile)

export interface TicketWorktreeState {
  readonly path: string
  readonly head: string
  readonly branch: string
  readonly clean: boolean
}

async function git(path: string, args: readonly string[]): Promise<string> {
  const result = await run('git', ['-C', path, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
  })
  return result.stdout.trim()
}

export async function inspectTicketWorktree(path: string): Promise<Result<TicketWorktreeState>> {
  if (!path.startsWith('/'))
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 必须是绝对路径'))
  const link = await lstat(path).catch(() => null)
  if (link === null) return err(makeError('WORKSPACE_ERROR', 'ticket worktree 不存在'))
  if (link.isSymbolicLink())
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 不能是符号链接'))
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 无法解析真实路径'))
  }
  let topLevel: string
  let head: string
  let branch: string
  let status: string
  try {
    topLevel = await git(canonical, ['rev-parse', '--show-toplevel'])
    head = await git(canonical, ['rev-parse', 'HEAD'])
    branch = await git(canonical, ['rev-parse', '--abbrev-ref', 'HEAD'])
    status = await git(canonical, ['status', '--porcelain', '--untracked-files=normal'])
  } catch {
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 必须是可读的 git 顶层'))
  }
  if (topLevel !== canonical)
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 必须是独立 git 顶层'))
  if (!/^[a-f0-9]{40}$/.test(head))
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree HEAD 不是完整 commit SHA'))
  return ok({ path: canonical, head, branch, clean: status === '' })
}

export async function commitExists(path: string, commit: string): Promise<boolean> {
  return (await resolveCommit(path, commit)) !== null
}

export async function resolveCommit(path: string, commit: string): Promise<string | null> {
  if (!/^[a-f0-9]{7,40}$/.test(commit)) return null
  try {
    const resolved = await git(path, ['rev-parse', '--verify', `${commit}^{commit}`])
    return /^[a-f0-9]{40}$/.test(resolved) ? resolved : null
  } catch {
    return null
  }
}

export async function isAncestor(
  path: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (!(await commitExists(path, ancestor)) || !(await commitExists(path, descendant))) return false
  try {
    await git(path, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

export async function branchExists(path: string, branch: string): Promise<boolean> {
  try {
    const resolved = await git(path, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return /^[a-f0-9]{40}$/.test(resolved)
  } catch {
    return false
  }
}

export async function addWorktree(
  repoPath: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  if (await branchExists(repoPath, branch)) {
    await git(repoPath, ['worktree', 'add', path, branch])
    return
  }
  await git(repoPath, ['worktree', 'add', '-b', branch, path, base])
}

export async function diffDigest(
  path: string,
  baseline: string,
  head: string,
): Promise<Result<string>> {
  if (!(await commitExists(path, baseline)) || !(await commitExists(path, head)))
    return err(makeError('WORKSPACE_ERROR', 'diff 基线或目标 commit 不存在'))
  try {
    const output = await run('git', ['-C', path, 'diff', '--binary', `${baseline}..${head}`], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000,
    })
    return ok(sha256Text(output.stdout))
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法读取 ticket diff'))
  }
}

export async function changedFiles(
  path: string,
  baseline: string,
  head: string,
): Promise<Result<readonly string[]>> {
  if (!(await commitExists(path, baseline)) || !(await commitExists(path, head)))
    return err(makeError('WORKSPACE_ERROR', 'changed-files 基线或目标 commit 不存在'))
  try {
    const output = await git(path, ['diff', '--name-only', '-z', `${baseline}..${head}`])
    return ok([...new Set(output.split('\0'))].filter((entry) => entry !== '').sort())
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法读取 ticket changed files'))
  }
}
