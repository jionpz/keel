/**
 * 工作区 git 脏树读取 —— Human 与 OMP 共用同一实现。
 *
 * collectChanges 的语义是「这个 Run 在工作区里到底改了什么」，
 * 与 Harness 无关：人改的、模型改的，都落在同一个 git 工作树里。
 * 各自实现会让同一份逻辑漂移（#1-06 之前 Human 恒返回空）。
 */

import { execFileSync } from 'node:child_process'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { WorkspaceDiff } from '../../contracts/harness-adapter.js'

export interface GitDiffOptions {
  /** 执行 git 的命令 —— 默认 node:child_process 的 execFileSync,测试注入 */
  readonly exec?: (
    cmd: string,
    args: readonly string[],
    cwd: string,
  ) => { code: number; stdout: string; stderr: string }
}

const defaultExec: GitDiffOptions['exec'] = (cmd, args, cwd) => {
  try {
    const stdout = execFileSync(cmd, [...args], { cwd, encoding: 'utf8' }) as string
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stderr?: string | Buffer; message?: string }
    return {
      code: err.status ?? -1,
      stdout: '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.stderr ?? err.message),
    }
  }
}

/**
 * 读工作区 git 状态与 diff —— 与 omp 的 collectChanges 同构。
 *
 * status: porcelain 输出,按行拆分出 files_changed;
 * diff: 全部改动,空串表示没有 patch(干净或纯新增未暂存)。
 * commits: 本 Run 的提交数 —— v0.1 由调用方另行查询,这里恒空。
 */
export async function collectGitDiff(
  cwd: string,
  opts: GitDiffOptions = {},
): Promise<Result<WorkspaceDiff>> {
  const exec = opts.exec ?? defaultExec
  if (exec === undefined) {
    return err(makeError('WORKSPACE_ERROR', '未提供 git 执行器'))
  }

  const status = exec('git', ['status', '--porcelain'], cwd)
  if (status.code !== 0) {
    return err(makeError('WORKSPACE_ERROR', `git status 失败：${status.stderr}`))
  }
  const patch = exec('git', ['diff'], cwd)
  if (patch.code !== 0) {
    return err(makeError('WORKSPACE_ERROR', `git diff 失败：${patch.stderr}`))
  }

  const files = status.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const code = l.slice(0, 2).trim()
      const path = l.slice(2).trim()
      const change = code.includes('D') ? 'deleted' : code.includes('?') ? 'added' : 'modified'
      return { path, change } as const
    })

  return ok({
    files_changed: files,
    patch: patch.stdout === '' ? null : patch.stdout,
    commits: [],
    is_dirty: files.length > 0,
  })
}
