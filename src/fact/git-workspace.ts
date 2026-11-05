/**
 * GitWorkspace —— 每个 Task 一个独立 git worktree。
 *
 * 定义处：docs/08-cross-cutting.md §4.1（并发）与 §1.6（隔离）
 *
 * worktree 隔离**同时解决两件事**：
 *   - 并发：多个 Task 改同一仓库时互不可见（N1）
 *   - 安全：Agent 污染工作区后，销毁 worktree 即完全清理（S1）
 *
 * 两种项目绑定（.trellis/tasks/10-27-local-project-binding/design.md §4）：
 *
 * ```
 * managed   <root>/repos/<repo_id>.git        Keel 维护的裸仓库
 * attached  用户已有的本地 git 工作树          只用其对象库，不改其工作树
 *
 * 两种模式的 worktree 都在 <root>/worktrees/<task_id>/。
 * ```
 *
 * **基线锚点是 commit，不是 ref 名**：prepare 解析出 `baseSha` 后，
 * worktree 直接用这个 40 位 SHA 创建。中间即使有另一个进程 fetch 移动了
 * `origin/<base>`，新 worktree 的起点仍是证据里记录的那个 commit。
 *
 * **为什么放在 src/fact/**：git 仓库是崩溃后仍存在的状态，
 * 符合 Fact Plane 的定义性属性（docs/02-glossary.md §1）。
 * 放这里的副作用是 Execution Plane 无法 import 它 —— 这正是想要的：
 * **工作区的生命周期归 Control 管，Execution 只在给定的 path 里干活。**
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { withFileLock } from './file-lock.js'
import {
  authEnvFor,
  gitAuthSecrets,
  readTokenFromEnv,
  redactSecrets,
  resolveGitHubToken,
  type TokenResolver,
} from './github-auth.js'
import { parseRemoteUrl } from './github-remote.js'
import { resolveKeelHome, validateAttachedDir } from './project-root.js'
import { workspaceError } from './workspace-error.js'

type ExecResult = { readonly stdout: string; readonly stderr: string }

/**
 * git 子进程执行器。
 *
 * 抽成注入点不是为了「换个假 git 跑测试」，而是为了在真实 git 之上
 * 捕获实际传给它的 argv 与 env —— 认证注入的安全性断言(header 在、token 不在 argv)
 * 只能这样验证，起一个 https git server 既慢又证明不了 argv 干净。
 */
export type GitExec = (
  file: string,
  args: readonly string[],
  opts?: { readonly env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>

const execAsync = promisify(execFile)

const defaultExec: GitExec = async (file, args, opts = {}) => {
  const { stdout, stderr } = await execAsync(file, [...args], {
    encoding: 'utf8',
    ...(opts.env === undefined ? {} : { env: opts.env }),
  })
  return { stdout, stderr }
}

export interface GitWorkspaceOptions {
  /** 根目录。默认从 KEEL_HOME 解析为绝对路径 */
  readonly root?: string
  /** 测试注入的 git 执行器；缺省用 `promisify(execFile)` */
  readonly exec?: GitExec
  /**
   * token 解析器注入点。缺省 `resolveGitHubToken`（env → `gh auth token`）。
   * 只对 http(s) remote 起作用；ssh / file 不解析、不注入。
   */
  readonly tokenResolver?: TokenResolver
}

export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
  /** 执行 git 命令的目录：managed 是裸仓库，attached 是用户工作树 */
  readonly gitDir: string
}

export interface WorktreeResult extends WorktreeInfo {
  /** 本次调用是否真的创建了 worktree；false 表示幂等复用 */
  readonly created: boolean
  /**
   * 本次调用是否真的创建了分支。
   *
   * 与 `created` 分开：worktree 被清理后重放时，worktree 是新建的，
   * 但分支早已存在、起点是**当初**那次 prepare 的 commit。
   * 基线证据只能在前者为 true 时取本次 `baseSha`。
   */
  readonly branchCreated: boolean
}

export type ProjectBinding =
  | { readonly mode: 'managed'; readonly repoId: string }
  | { readonly mode: 'attached'; readonly repoId: string; readonly localPath: string }

export interface PreparedProject {
  readonly repoId: string
  readonly gitDir: string
  readonly baseBranch: string
  /** 固定的远端跟踪 ref，例如 refs/remotes/origin/main */
  readonly baseRef: string
  /** 本次基线的唯一锚点 */
  readonly baseSha: string
  readonly fetchedAt: string
}

/** 分支名由 task_id 决定 —— 幂等的前提（docs/04-state-machine.md §5.2） */
export function branchFor(taskId: string): string {
  return `ai/task-${taskId.slice(0, 8)}`
}

export class GitWorkspace {
  private readonly root: string
  private readonly exec: GitExec
  private readonly tokenResolver: TokenResolver
  /**
   * 按 host 缓存的 token —— 供 `authEnvFor` 注入，同时进入 `secrets()`
   * 的脱敏集合。gh 来源的 token 不在环境里，不缓存就脱敏不到。
   */
  private readonly tokenCache = new Map<string, string>()

  constructor(opts: GitWorkspaceOptions = {}) {
    this.root = opts.root ?? resolveKeelHome()
    this.exec = opts.exec ?? defaultExec
    this.tokenResolver = opts.tokenResolver ?? resolveGitHubToken
  }

  private bareRepoPath(repoId: string): string {
    return join(this.root, 'repos', `${repoId}.git`)
  }

  private worktreePath(taskId: string): string {
    return join(this.root, 'worktrees', taskId)
  }

  /**
   * 兼容入口：只准备托管模式的裸仓库，不做 fetch。
   *
   * 保留它是为了测试装置先建仓库、再单独验证 prepare 的增量部分。
   * 生产入口一律用 `prepareProject` —— 它保证 fetch 与基线解析。
   */
  async ensureBareRepo(repoId: string, remoteUrl: string): Promise<Result<string>> {
    return this.withRepoLock(repoId, 'clone', () => this.ensureGitDir(repoId, remoteUrl))
  }

  /**
   * 准备项目：确定 git 目录、同步基线、返回锚点。
   *
   * 全程持 per-repo 锁：clone / fetch 是共享 git 状态，并发执行会互相破坏。
   */
  async prepareProject(
    binding: ProjectBinding,
    remoteUrl: string,
    baseBranch: string,
  ): Promise<Result<PreparedProject>> {
    return this.withRepoLock(binding.repoId, 'prepare', async () => {
      let gitDir: string

      if (binding.mode === 'attached') {
        const validated = await validateAttachedDir(binding.localPath, remoteUrl)
        if (!validated.ok) return err(validated.error)
        gitDir = validated.value.path
      } else {
        const ensured = await this.ensureGitDir(binding.repoId, remoteUrl)
        if (!ensured.ok) return ensured
        gitDir = ensured.value
      }

      const synced = await this.syncBase(gitDir, remoteUrl, baseBranch)
      if (!synced.ok) return synced

      return ok({
        repoId: binding.repoId,
        gitDir,
        baseBranch,
        baseRef: `refs/remotes/origin/${baseBranch}`,
        baseSha: synced.value,
        fetchedAt: new Date().toISOString(),
      })
    })
  }

  /**
   * 幂等创建 worktree 与分支。
   *
   * 重复调用返回已有的（`created=false`）—— 这是 `CreateBranch` 副作用
   * 可以安全重放的原因（docs/04-state-machine.md §5.2）。
   *
   * 创建时锚定 `project.baseSha` 而不是 `baseRef`：ref 会被并发 fetch 移动。
   *
   * 两个容易被「目录存在」骗过的场景在这里收紧：
   *   - 目录存在但不是该分支的 worktree 根（比如被普通目录占用、或 checkout
   *     到了别的分支）→ **fail closed**，不删目录（可能含未提交内容）；
   *   - 目录被外部删除但 git 仍留着 worktree 元数据 → `worktree add` 会失败，
   *     先 `worktree prune` 再重试一次，而不是让 task 永久卡在 worktree_failed。
   */
  async ensureWorktree(project: PreparedProject, taskId: string): Promise<Result<WorktreeResult>> {
    return this.withRepoLock(project.repoId, 'worktree', async () => {
      const branch = branchFor(taskId)
      const wt = this.worktreePath(taskId)
      const info = { path: wt, branch, gitDir: project.gitDir }

      if (existsSync(wt)) {
        const inspected = await this.inspectWorktree(wt, branch)
        if (!inspected.ok) return err(inspected.error)
        return ok({ ...info, created: false, branchCreated: false })
      }

      await mkdir(join(this.root, 'worktrees'), { recursive: true })
      // 分支已存在（worktree 被清理后又被重放）则复用，否则从基线建
      const branchCreated = !(await this.branchExists(project.gitDir, branch))
      const args = branchCreated
        ? ['worktree', 'add', '-b', branch, wt, project.baseSha]
        : ['worktree', 'add', wt, branch]
      try {
        await this.execGit(['-C', project.gitDir, ...args])
        return ok({ ...info, created: true, branchCreated })
      } catch (first) {
        // 陈旧元数据（目录被手工删除）会让 add 失败；prune 后重试一次。
        // 仍然失败才是真的失败，错误里带上两次尝试的原因。
        try {
          await this.execGit(['-C', project.gitDir, 'worktree', 'prune'])
          await this.execGit(['-C', project.gitDir, ...args])
          return ok({ ...info, created: true, branchCreated })
        } catch (second) {
          return err(
            workspaceError('worktree_failed', {
              path: wt,
              branch,
              reason: this.redact(first),
              retry_reason: this.redact(second),
            }),
          )
        }
      }
    })
  }

  /**
   * 提交工作树中的全部改动。
   *
   * 无改动时返回 null 而非报错 —— 「这一轮没改东西」是正常情况，
   * 不该被当作故障。
   *
   * 身份与签名都由 `-c` 显式钉死，不继承调用者的全局 git 配置：
   * 提交是机器署名（`Keel <keel@localhost>`），用操作者的密钥签名会把
   * 人的身份加到 Agent 产物上；且签名程序可能交互提示或变慢，
   * 在无人干预的编排循环里等同于挂起。
   */
  async commitAll(taskId: string, message: string): Promise<Result<string | null>> {
    const wt = this.worktreePath(taskId)
    if (!existsSync(wt)) {
      return err(makeError('WORKSPACE_ERROR', `worktree 不存在：${wt}`))
    }
    try {
      const { stdout: status } = await this.execGit(['-C', wt, 'status', '--porcelain'])
      if (status.trim() === '') return ok(null)

      await this.execGit(['-C', wt, 'add', '-A'])
      await this.execGit([
        '-C',
        wt,
        '-c',
        'user.email=keel@localhost',
        '-c',
        'user.name=Keel',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        message,
      ])
      const { stdout: sha } = await this.execGit(['-C', wt, 'rev-parse', 'HEAD'])
      return ok(sha.trim())
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', `提交失败：${this.redact(e)}`))
    }
  }

  /** 读该 Task 分支的 HEAD SHA（分支在 git 目录里，与 worktree 是否还在无关） */
  async headSha(project: PreparedProject, taskId: string): Promise<Result<string>> {
    const branch = branchFor(taskId)
    try {
      const { stdout } = await this.execGit([
        '-C',
        project.gitDir,
        'rev-parse',
        `refs/heads/${branch}`,
      ])
      return ok(stdout.trim())
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', `读取分支 ${branch} HEAD 失败：${this.redact(e)}`))
    }
  }

  /**
   * 把该 Task 的分支 push 到远程。
   *
   * 只允许 `ai/*` 分支；不使用 `--force`。
   * 幂等由 git 自身保证：远程已是最新时输出 "Everything up-to-date"。
   */
  async push(project: PreparedProject, taskId: string, remoteUrl: string): Promise<Result<string>> {
    const branch = branchFor(taskId)
    if (!branch.startsWith('ai/')) {
      return err(makeError('WORKSPACE_ERROR', `拒绝 push 非 ai/* 分支：${branch}`))
    }
    if (!(await this.branchExists(project.gitDir, branch))) {
      return err(makeError('WORKSPACE_ERROR', `分支不存在：${branch}`))
    }
    try {
      const { stdout } = await this.execGit(
        ['-C', project.gitDir, 'push', remoteUrl, `${branch}:${branch}`],
        { auth: remoteUrl },
      )
      return ok(stdout.trim())
    } catch (e) {
      return err(
        makeError('WORKSPACE_ERROR', `push ${branch} 到 ${remoteUrl} 失败：${this.redact(e)}`),
      )
    }
  }

  /** 读工作树的改动摘要 */
  async status(taskId: string): Promise<Result<string>> {
    const wt = this.worktreePath(taskId)
    try {
      const { stdout } = await this.execGit(['-C', wt, 'status', '--porcelain'])
      return ok(stdout)
    } catch (e) {
      return err(makeError('WORKSPACE_ERROR', this.redact(e)))
    }
  }

  /**
   * 移除 worktree。
   *
   * **分支保留在 git 目录里** —— 移除的是工作树，不是历史。
   * 用于 S-DONE / S-REJECTED / S-ABANDONED。
   *
   * 失败只经 `Result` 返回，不抛异常：调用方（`cleanWorkspace`）要据此
   * 把「没做成」写成 `SideEffectIntent`，而不是让整个转移事务回滚。
   */
  async remove(project: PreparedProject, taskId: string): Promise<Result<void>> {
    return this.withRepoLock(project.repoId, 'remove', async () => {
      const wt = this.worktreePath(taskId)
      if (!existsSync(wt)) return ok(undefined)
      try {
        await this.execGit(['-C', project.gitDir, 'worktree', 'remove', '--force', wt])
        return ok(undefined)
      } catch (removeErr) {
        // worktree 元数据可能已损坏；退回直接删目录。
        // 目录真的删掉了才算清理成功，prune 只是尽力而为（下次 ensure 会再 prune）。
        try {
          await rm(wt, { recursive: true, force: true })
        } catch (rmErr) {
          return err(
            workspaceError('worktree_failed', {
              path: wt,
              reason: this.redact(removeErr),
              fallback_reason: this.redact(rmErr),
            }),
          )
        }
        await this.execGit(['-C', project.gitDir, 'worktree', 'prune']).catch(() => undefined)
        return ok(undefined)
      }
    })
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

  // ─────────────────────────────── 内部 ───────────────────────────────

  /**
   * 确保托管模式的裸仓库可用。
   *
   * 目录存在不等于仓库可用：上次 clone 可能中途崩溃，留下一个没有 refs 的目录。
   * 先 `rev-parse --is-bare-repository` 验证，避免把半成品当成缓存。
   *
   * 新建时先 clone 到 `.tmp-*` 再 rename：崩溃最多留下临时目录，不污染正式路径。
   */
  private async ensureGitDir(repoId: string, remoteUrl: string): Promise<Result<string>> {
    const bare = this.bareRepoPath(repoId)

    if (existsSync(bare)) {
      if (await this.isBareRepo(bare)) return ok(bare)
      return err(
        workspaceError('git_dir_invalid', {
          path: bare,
          detail: '不是有效的裸仓库（可能是上次 clone 中断）；确认后可手动删除',
        }),
      )
    }

    await mkdir(join(this.root, 'repos'), { recursive: true })
    const tmp = join(this.root, 'repos', `.tmp-${repoId}-${process.pid}`)
    await rm(tmp, { recursive: true, force: true })

    try {
      await this.execGit(['clone', '--bare', remoteUrl, tmp], { auth: remoteUrl })
      // 持锁期间不会有两个进程同时 rename；目标已存在说明锁失效，宁可报错
      await rename(tmp, bare)
      return ok(bare)
    } catch (e) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      return err(workspaceError('git_dir_invalid', { path: bare, detail: this.redact(e) }))
    }
  }

  /** fetch 基线分支并解析成 commit。只同步 base，不 fetch 全部分支。 */
  private async syncBase(
    gitDir: string,
    remoteUrl: string,
    baseBranch: string,
  ): Promise<Result<string>> {
    try {
      await this.execGit(
        [
          '-C',
          gitDir,
          'fetch',
          '--prune',
          'origin',
          `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
        ],
        { auth: remoteUrl },
      )
    } catch (e) {
      // 远端没有该分支时 fetch 本身就失败（couldn't find remote ref）。
      // 对用户来说这与「ref 解析不到」是同一件事：base 配错了，改 base 或建分支。
      const reason = this.redact(e)
      if (/couldn't find remote ref|unknown revision|not our ref/i.test(reason)) {
        return err(workspaceError('base_missing', { remote: 'origin', base: baseBranch }))
      }
      return err(
        workspaceError('fetch_failed', {
          git_dir: gitDir,
          base: baseBranch,
          reason,
        }),
      )
    }

    try {
      const { stdout } = await this.execGit([
        '-C',
        gitDir,
        'rev-parse',
        `refs/remotes/origin/${baseBranch}`,
      ])
      return ok(stdout.trim())
    } catch {
      return err(workspaceError('base_missing', { remote: 'origin', base: baseBranch }))
    }
  }

  private async isBareRepo(path: string): Promise<boolean> {
    try {
      const { stdout } = await this.execGit(['-C', path, 'rev-parse', '--is-bare-repository'])
      return stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  private async branchExists(gitDir: string, branch: string): Promise<boolean> {
    try {
      await this.execGit(['-C', gitDir, 'rev-parse', '--verify', `refs/heads/${branch}`])
      return true
    } catch {
      return false
    }
  }

  /**
   * 校验「目录存在」确实是「这个 task 的 worktree」。
   *
   * 只读：不 checkout、不删除。目录被普通文件占用、或 checkout 在别的分支时，
   * 继续复用会把 agent 的改动落到错误的地方，所以这里 fail closed。
   */
  private async inspectWorktree(wt: string, branch: string): Promise<Result<void>> {
    if (!existsSync(join(wt, '.git'))) {
      return err(
        workspaceError('worktree_failed', { path: wt, branch, actual: '(not a worktree)' }),
      )
    }
    try {
      const { stdout } = await this.execGit(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const actual = stdout.trim()
      if (actual !== branch) {
        return err(workspaceError('worktree_failed', { path: wt, branch, actual }))
      }
      return ok(undefined)
    } catch (e) {
      return err(
        workspaceError('worktree_failed', {
          path: wt,
          branch,
          actual: '(unreadable)',
          reason: this.redact(e),
        }),
      )
    }
  }

  /**
   * 统一 git 调用入口。
   *
   * `auth` 存在时先按 remote host 解析 token，再注入 GitHub https 认证（只对本次
   * 子进程生效）；本地操作、无 token、或 ssh/file remote 一律不传 env ——
   * 没有认证可加时保持与改动前完全一致的调用形态。
   */
  private async execGit(
    args: readonly string[],
    opts: { readonly auth?: string } = {},
  ): Promise<ExecResult> {
    if (opts.auth === undefined) return this.exec('git', args)
    const token = await this.tokenForRemoteHost(opts.auth)
    const auth = authEnvFor(opts.auth, token)
    if (Object.keys(auth).length === 0) return this.exec('git', args)
    return this.exec('git', args, { env: { ...process.env, ...auth } })
  }

  /**
   * 按 remote 解析 token。非 http(s) / 解析失败不调 resolver ——
   * ssh 走部署方 key，file 是本地路径，都不该触发 `gh`。
   */
  private async tokenForRemoteHost(remoteUrl: string): Promise<string | undefined> {
    const trimmed = remoteUrl.trim()
    if (!/^https?:\/\//i.test(trimmed)) return undefined

    const parsed = parseRemoteUrl(trimmed)
    if (!parsed.ok) return undefined

    const host = parsed.value.host
    const cached = this.tokenCache.get(host)
    if (cached !== undefined) return cached

    let resolved: string | undefined
    try {
      resolved = await this.tokenResolver(host)
    } catch {
      // 解析失败按无 token 处理；异常内容可能含凭据，不向上带
      resolved = undefined
    }
    if (resolved === undefined) return undefined
    const token = resolved.trim()
    if (token === '') return undefined
    this.tokenCache.set(host, token)
    return token
  }

  /**
   * 可能出现在 git 输出里的凭据形态（明文 token + 它的 base64）。
   *
   * 既包括环境 token，也包括运行期解析出来的（gh 登录态）token ——
   * 后者不在 `process.env` 里，漏掉它就等于 git 错误 detail 未脱敏。
   */
  private secrets(): readonly string[] {
    const tokens = [readTokenFromEnv(), ...this.tokenCache.values()]
    return [...new Set(tokens.flatMap((token) => gitAuthSecrets(token)))]
  }

  /** git 错误统一脱敏：所有 `msg(e)` 出口都必须过这里，避免未来新增调用点漏掉 */
  private redact(e: unknown): string {
    return redactSecrets(msg(e), this.secrets())
  }

  /** per-repo 锁：clone / fetch / worktree 共用一把，避免共享 git 状态被并发写 */
  private async withRepoLock<T>(
    repoId: string,
    op: string,
    fn: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const locks = join(this.root, 'locks')
    try {
      await mkdir(locks, { recursive: true })
    } catch (e) {
      return err(workspaceError('lock_failed', { lock: locks, op, detail: this.redact(e) }))
    }
    return withFileLock(join(locks, `repo-${repoId}.lock`), op, fn, {
      hint: `pnpm keel unlock ${repoId} --force`,
    })
  }
}

function msg(e: unknown): string {
  if (e instanceof Error) {
    const withStderr = e as Error & { stderr?: string }
    return withStderr.stderr?.trim() || e.message
  }
  return String(e)
}
