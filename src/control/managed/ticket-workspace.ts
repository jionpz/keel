import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { sha256Text } from '../../shared/canonical-json.js'
import { assertPrivateGitDirectory } from '../../shared/private-git.js'
import { withTrustedGitDirectory } from '../../shared/trusted-git.js'

const run = promisify(execFile)

// 宿主只读检查不得执行由不可信工作区配置的监控器、hooks 或 diff 驱动。
const SAFE_GIT_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'] as const

export interface TicketWorktreeState {
  readonly path: string
  readonly head: string
  readonly branch: string
  readonly clean: boolean
}

async function git(path: string, args: readonly string[]): Promise<string> {
  const result = await run('git', [...SAFE_GIT_ARGS, '-C', path, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000,
  })
  return args.includes('-z') ? result.stdout : result.stdout.trim()
}

export async function inspectTicketWorktree(path: string): Promise<Result<TicketWorktreeState>> {
  return inspectGitWorktree(path, true)
}

/** 控制层只读源仓库；它不会成为执行器的可写 workspace。 */
export async function inspectRepositorySource(path: string): Promise<Result<TicketWorktreeState>> {
  return inspectGitWorktree(path, false)
}

async function inspectGitWorktree(
  path: string,
  privateGit: boolean,
): Promise<Result<TicketWorktreeState>> {
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
    if (privateGit) await assertPrivateGitDirectory(canonical)
    topLevel = await git(canonical, ['rev-parse', '--show-toplevel'])
    head = await git(canonical, ['rev-parse', 'HEAD'])
    branch = await git(canonical, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (privateGit) {
      const entries = await git(canonical, ['ls-files', '-v', '-z'])
      if (entries.split('\0').some((entry) => /^[a-zS] /.test(entry)))
        return err(
          makeError('WORKSPACE_ERROR', 'ticket worktree 的 index 不能使用隐藏工作区修改的标记'),
        )
    }
    status = await git(canonical, ['status', '--porcelain', '--untracked-files=normal'])
  } catch (error) {
    return err(
      makeError(
        'WORKSPACE_ERROR',
        `ticket workspace 必须是私有 git 顶层：${error instanceof Error ? error.message : String(error)}`,
      ),
    )
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

export async function createTicketRepository(
  repoPath: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  // --no-local 走 Git 对象传输，不复制源仓库的硬链接、alternates、配置或 hooks。
  await withTrustedGitDirectory((gitDir) =>
    git(gitDir, ['clone', '--no-local', '--no-checkout', '--', repoPath, path]),
  )
  await git(path, ['checkout', '-b', branch, base])
  await git(path, ['config', 'user.name', 'Keel Managed Executor'])
  await git(path, ['config', 'user.email', 'keel-managed@invalid'])
  await git(path, ['config', 'commit.gpgsign', 'false'])
}

export async function diffDigest(
  path: string,
  baseline: string,
  head: string,
): Promise<Result<string>> {
  if (!(await commitExists(path, baseline)) || !(await commitExists(path, head)))
    return err(makeError('WORKSPACE_ERROR', 'diff 基线或目标 commit 不存在'))
  try {
    const output = await run(
      'git',
      [
        ...SAFE_GIT_ARGS,
        '-C',
        path,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        `${baseline}..${head}`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_OPTIONAL_LOCKS: '0',
        },
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15000,
      },
    )
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
    const output = await git(path, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '--no-renames',
      '-z',
      `${baseline}..${head}`,
    ])
    return ok([...new Set(output.split('\0'))].filter((entry) => entry !== '').sort())
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法读取 ticket changed files'))
  }
}

/**
 * 读取 baseline 到当前工作树的全部改动路径。
 *
 * `git diff <baseline>` 能看见已提交、已暂存和未暂存的 tracked 文件；
 * 未跟踪文件必须另查 `git ls-files`。超时恢复的 scope 门禁要检查真实现场，
 * 不能只看最后一个 commit，否则新建 WIP 文件会绕过 `scope_paths`。
 */
export async function workingTreeChangedFiles(
  path: string,
  baseline: string,
): Promise<Result<readonly string[]>> {
  if (!(await commitExists(path, baseline)))
    return err(makeError('WORKSPACE_ERROR', 'working-tree changed-files 基线不存在'))
  try {
    const [tracked, untracked] = await Promise.all([
      git(path, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '--no-renames',
        '-z',
        baseline,
        '--',
      ]),
      git(path, ['ls-files', '--others', '--exclude-standard', '-z']),
    ])
    return ok(
      [...new Set([...tracked.split('\0'), ...untracked.split('\0')])]
        .filter((entry) => entry !== '')
        .sort(),
    )
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法读取 ticket working-tree changed files'))
  }
}
