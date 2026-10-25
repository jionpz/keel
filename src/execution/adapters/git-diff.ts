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
  /**
   * 基线提交：只报「这个 Run 在基线之后改了什么」。
   *
   * 缺省(null) = 现状语义「工作树现在脏不脏」。有基线时把**本轮已提交**的改动
   * 也算进来 —— 模型自己 `git commit` 之后 status 是干净的，只读脏树会把一次
   * 真实完成的工作报成「0 文件」。基线由 Adapter 在 startRun 时取（`gitHeadSha`）。
   */
  readonly since?: string | null
}

const defaultExec: GitDiffOptions['exec'] = (cmd, args, cwd) => {
  try {
    // stderr 显式 pipe：非 git 目录下 git 会往 stderr 写 fatal，
    // 让它直接漏到测试输出里会把真正的失败信息淹没
    const stdout = execFileSync(cmd, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as string
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
 * 两种语义，靠 `since` 区分：
 * - `since = null`（缺省）：**工作树现状**。status 出文件、`git diff` 出 patch，
 *   已提交的改动看不见。
 * - `since = <sha>`：**这个 Run 改了什么**。`git diff <since>` 同时覆盖已提交、
 *   已暂存、未暂存；未跟踪文件另由 porcelain 补进来（`git diff` 看不见它们，
 *   而 develop 常常是「新建一个文件」）；`commits` 报出本轮 SHA。
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
  const dirty = parseStatus(status.stdout)

  const since = opts.since ?? null
  if (since === null) {
    const patch = exec('git', ['diff'], cwd)
    if (patch.code !== 0) {
      return err(makeError('WORKSPACE_ERROR', `git diff 失败：${patch.stderr}`))
    }
    return ok({
      files_changed: dirty,
      patch: patch.stdout === '' ? null : patch.stdout,
      commits: [],
      is_dirty: dirty.length > 0,
    })
  }

  const patch = exec('git', ['diff', since], cwd)
  if (patch.code !== 0) {
    return err(makeError('WORKSPACE_ERROR', `git diff ${since} 失败：${patch.stderr}`))
  }
  const names = exec('git', ['diff', '--name-status', since], cwd)
  if (names.code !== 0) {
    return err(makeError('WORKSPACE_ERROR', `git diff --name-status 失败：${names.stderr}`))
  }
  const log = exec('git', ['log', '--format=%H', `${since}..HEAD`], cwd)
  if (log.code !== 0) {
    return err(makeError('WORKSPACE_ERROR', `git log ${since}..HEAD 失败：${log.stderr}`))
  }

  return ok({
    files_changed: mergeFiles(parseNameStatus(names.stdout), dirty),
    patch: patch.stdout === '' ? null : patch.stdout,
    commits: log.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
    is_dirty: dirty.length > 0,
  })
}

/**
 * 取当前 HEAD 作为 diff 基线。
 *
 * 非 git 目录 / 尚无提交 → `ok(null)`：**没有基线不是错误**，退回「脏树」语义即可。
 * 报错会让 Adapter 的 startRun 在裸目录上失败 —— 那不是我们要拦的东西。
 */
export async function gitHeadSha(
  cwd: string,
  opts: Pick<GitDiffOptions, 'exec'> = {},
): Promise<Result<string | null>> {
  const exec = opts.exec ?? defaultExec
  if (exec === undefined) return ok(null)
  const r = exec('git', ['rev-parse', 'HEAD'], cwd)
  if (r.code !== 0) return ok(null)
  const sha = r.stdout.trim()
  return ok(sha === '' ? null : sha)
}

const CHANGED = { added: 'added', modified: 'modified', deleted: 'deleted' } as const

/** porcelain → 文件清单。R8(issue #23) 的双列语义见下方注释 */
function parseStatus(stdout: string): { path: string; change: 'added' | 'modified' | 'deleted' }[] {
  return stdout
    .split('\n')
    .map((l) => l.replace(/\s+$/, '')) // 只去行尾,保留行首 XY 列(porcelain 固定格式)
    .filter((l) => l !== '')
    .map((l) => {
      // porcelain 格式:XY path —— X=暂存区状态,Y=工作区状态。
      // Y 列取值:空格(工作区未动)/ M / D / ?(未跟踪,此时 X 也 ?)。
      // X 列可含 A(暂存新增)/ M / D / R / C / ?。以 Y 列(工作区)为主,
      // 未跟踪(??/!!)整体 added;Y=空格时回看 X。R8(issue #23)。
      const path = l.slice(3).trim()
      const isUntracked = l.startsWith('??') || l.startsWith('!!')
      const x = l[0] ?? ''
      const y = l[1] ?? ' '
      let change: 'added' | 'modified' | 'deleted'
      if (isUntracked) change = CHANGED.added
      else if (y === 'D')
        change = CHANGED.deleted // 工作区删除(含 AD:暂存新增后删除)
      else if (y === 'M')
        change = CHANGED.modified // 工作区改(含 AM/MM)
      else if (y === ' ') {
        // 工作区未动:看暂存区 —— 新增 → added;删除 → deleted(理论上 X=D 时 Y 必 D,防御)
        if (x === 'A' || x === 'R' || x === 'C') change = CHANGED.added
        else if (x === 'D') change = CHANGED.deleted
        else change = CHANGED.modified
      } else change = CHANGED.modified
      return { path, change } as const
    })
}

/**
 * `git diff --name-status <since>` → 文件清单。
 *
 * 行格式:`A\tpath` / `M\tpath` / `D\tpath` / `R100\told\tnew`。
 * 重命名按 **删旧 + 增新** 两行报 —— WorkspaceDiff 只有三态，
 * 只报新路径会让「旧路径没了」这件事消失。
 */
function parseNameStatus(
  stdout: string,
): { path: string; change: 'added' | 'modified' | 'deleted' }[] {
  const out: { path: string; change: 'added' | 'modified' | 'deleted' }[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [code = '', first = '', second] = line.split('\t')
    const letter = code[0] ?? ''
    if ((letter === 'R' || letter === 'C') && second !== undefined) {
      out.push({ path: first, change: CHANGED.deleted })
      out.push({ path: second, change: CHANGED.added })
      continue
    }
    if (letter === 'A') out.push({ path: first, change: CHANGED.added })
    else if (letter === 'D') out.push({ path: first, change: CHANGED.deleted })
    else if (letter !== '') out.push({ path: first, change: CHANGED.modified })
  }
  return out
}

/**
 * 合并两路来源：diff 与 HEAD 的比较**看不见未跟踪文件**，它们只出现在 porcelain。
 * 以 diff 为主（它带正确的 A/M/D），porcelain 里 diff 没有的路径补进来。
 */
function mergeFiles(
  fromDiff: { path: string; change: 'added' | 'modified' | 'deleted' }[],
  fromStatus: { path: string; change: 'added' | 'modified' | 'deleted' }[],
): { path: string; change: 'added' | 'modified' | 'deleted' }[] {
  const seen = new Set(fromDiff.map((f) => f.path))
  const out = [...fromDiff]
  for (const f of fromStatus) {
    if (seen.has(f.path)) continue
    seen.add(f.path)
    out.push(f)
  }
  return out
}
