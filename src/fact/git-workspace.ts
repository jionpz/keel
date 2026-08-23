/**
 * GitWorkspace —— 每个 Task 一个独立 git worktree。
 *
 * 定义处：docs/08-cross-cutting.md §4.1（并发）与 §1.6（隔离）
 *
 * worktree 隔离**同时解决两件事**：
 *   - 并发：多个 Task 改同一仓库时互不可见（N1）
 *   - 安全：Agent 污染工作区后，销毁 worktree 即完全清理（S1）
 *
 * 成本只是一条 `git worktree add`，因此在 v0.1 就是**必须**而非可选。
 *
 * ```
 * <root>/repos/<repo_id>.git      裸仓库，共享对象存储
 * <root>/worktrees/<task_id>/     每 Task 独立工作树，独立分支
 * ```
 *
 * **为什么放在 src/fact/**：git 仓库是崩溃后仍存在的状态，
 * 符合 Fact Plane 的定义性属性（docs/02-glossary.md §1）。
 * 放这里的副作用是 Execution Plane 无法 import 它 —— 这正是想要的：
 * **工作区的生命周期归 Control 管，Execution 只在给定的 path 里干活。**
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { err, makeError, ok, type Result } from '../contracts/errors.js'

const exec = promisify(execFile)

export interface GitWorkspaceOptions {
  /** 根目录。默认 .keel */
  readonly root?: string
}

export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
  readonly bareRepo: string
}

/** 分支名由 task_id 决定 —— 幂等的前提（docs/04-state-machine.md §5.2） */
export function branchFor(taskId: string): string {
  return `ai/task-${taskId.slice(0, 8)}`
}

export class GitWorkspace {
  private readonly root: string

  constructor(opts: GitWorkspaceOptions = {}) {
    this.root = opts.root ?? '.keel'
  }

  private bareRepoPath(repoId: string): string {
    return join(this.root, 'repos', `${repoId}.git`)
  }

  private worktreePath(taskId: string): string {
    return join(this.root, 'worktrees', taskId)
  }

  /**
   * 准备裸仓库。
   *
   * 幂等：已存在则直接返回。
   * `remoteUrl` 为 `file://` 时克隆本地仓库 —— v0.1 的验证路径。
   */
  async ensureBareRepo(repoId: string, remoteUrl: string): Promise<Result<string>> {
    const bare = this.bareRepoPath(repoId)
    if (existsSync(bare)) return ok(bare)

    await mkdir(join(this.root, 'repos'), { recursive: true })
    try {
      await exec('git', ['clone', '--bare', remoteUrl, bare])
      return ok(bare)
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', `克隆裸仓库失败（${remoteUrl}）：${msg(e)}`))
    }
  }

  /**
   * 幂等创建 worktree 与分支。
   *
   * 重复调用返回已有的 —— 这是 `CreateBranch` 副作用可以安全重放的原因
   * （docs/04-state-machine.md §5.2）。
   */
  async ensureWorktree(
    repoId: string,
    taskId: string,
    baseBranch: string,
  ): Promise<Result<WorktreeInfo>> {
    const bare = this.bareRepoPath(repoId)
    if (!existsSync(bare)) {
      return err(makeError('WORKSPACE_ERROR', `裸仓库不存在：${bare}，请先 ensureBareRepo`))
    }

    const branch = branchFor(taskId)
    const wt = this.worktreePath(taskId)
    const info: WorktreeInfo = { path: wt, branch, bareRepo: bare }

    if (existsSync(wt)) return ok(info)

    await mkdir(join(this.root, 'worktrees'), { recursive: true })
    try {
      // 分支已存在则复用，否则从 baseBranch 建
      const exists = await this.branchExists(bare, branch)
      const args = exists
        ? ['worktree', 'add', wt, branch]
        : ['worktree', 'add', '-b', branch, wt, baseBranch]
      await exec('git', ['-C', bare, ...args])
      return ok(info)
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', `创建 worktree 失败：${msg(e)}`))
    }
  }

  private async branchExists(bare: string, branch: string): Promise<boolean> {
    try {
      await exec('git', ['-C', bare, 'rev-parse', '--verify', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * 提交工作树中的全部改动。
   *
   * 无改动时返回 null 而非报错 —— 「这一轮没改东西」是正常情况，
   * 不该被当作故障。
   */
  async commitAll(taskId: string, message: string): Promise<Result<string | null>> {
    const wt = this.worktreePath(taskId)
    if (!existsSync(wt)) {
      return err(makeError('WORKSPACE_ERROR', `worktree 不存在：${wt}`))
    }
    try {
      const { stdout: status } = await exec('git', ['-C', wt, 'status', '--porcelain'])
      if (status.trim() === '') return ok(null)

      await exec('git', ['-C', wt, 'add', '-A'])
      await exec('git', [
        '-C',
        wt,
        '-c',
        'user.email=keel@localhost',
        '-c',
        'user.name=Keel',
        'commit',
        '-m',
        message,
      ])
      const { stdout: sha } = await exec('git', ['-C', wt, 'rev-parse', 'HEAD'])
      return ok(sha.trim())
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', `提交失败：${msg(e)}`))
    }
  }

  /** 读工作树的改动摘要 */
  async status(taskId: string): Promise<Result<string>> {
    const wt = this.worktreePath(taskId)
    try {
      const { stdout } = await exec('git', ['-C', wt, 'status', '--porcelain'])
      return ok(stdout)
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', msg(e)))
    }
  }

  /**
   * 移除 worktree。
   *
   * **分支保留在裸仓库里** —— 移除的是工作树，不是历史。
   * 用于 S-DONE / S-REJECTED / S-ABANDONED。
   */
  async remove(repoId: string, taskId: string): Promise<Result<void>> {
    const wt = this.worktreePath(taskId)
    if (!existsSync(wt)) return ok(undefined)
    try {
      await exec('git', ['-C', this.bareRepoPath(repoId), 'worktree', 'remove', '--force', wt])
      return ok(undefined)
    } catch {
      // worktree 元数据可能已损坏；直接删目录并 prune
      await rm(wt, { recursive: true, force: true })
      await exec('git', ['-C', this.bareRepoPath(repoId), 'worktree', 'prune']).catch(
        () => undefined,
      )
      return ok(undefined)
    }
  }

  /**
   * 保留现场。
   *
   * 用于 `S-FAILED`（T-041）：**刻意不清理**，供诊断。
   * 见 docs/04-state-machine.md §2.2 —— 不可恢复失败的判定标准很窄，
   * 一旦触发就说明有需要人看的东西。
   */
  preservePath(taskId: string): string {
    return this.worktreePath(taskId)
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const withStderr = e as Error & { stderr?: string }
    return withStderr.stderr?.trim() || e.message
  }
  return String(e)
}
