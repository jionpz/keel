/**
 * 工作区失败的稳定错误码。
 *
 * `KeelError.detail` 是字符串（src/contracts/errors.ts），本模块不扩展全局结构，
 * 只保证同一类失败总是以同一个 `[code]` 前缀开头，字段名固定。
 *
 * 为什么需要稳定码：绑定/同步失败发生在无人值守的编排入口，用户看到的是
 * 一行字符串；没有固定 code 时，只能靠整段中文文案判断该重新绑定还是检查网络，
 * 而测试也只能断言「报错了」。code + 固定字段让两者都能机械处理。
 *
 * 事实来源：.trellis/tasks/10-27-local-project-binding/design.md §8。
 */

import { type KeelError, makeError } from '../contracts/errors.js'

export type WorkspaceFailureCode =
  | 'local_path_missing'
  | 'not_a_git_worktree'
  | 'origin_mismatch'
  | 'local_path_taken'
  | 'git_dir_invalid'
  | 'fetch_failed'
  | 'base_missing'
  | 'lock_timeout'
  | 'lock_failed'
  | 'worktree_failed'

export type WorkspaceFailureFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>

/** stderr 可能很长，也可能夹带用户目录；只保留可诊断的一段 */
const MAX_FIELD_LEN = 500

/**
 * 构造 `WORKSPACE_ERROR`，detail 形如：
 *
 *   `[origin_mismatch] expected="github.com/a/b" actual="github.com/a/c"`
 *
 * 字段按传入顺序输出，`undefined` / `null` 跳过。
 */
export function workspaceError(
  code: WorkspaceFailureCode,
  fields: WorkspaceFailureFields,
): KeelError {
  const rendered = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${sanitize(v)}"`)
    .join(' ')

  return makeError('WORKSPACE_ERROR', `[${code}]${rendered === '' ? '' : ` ${rendered}`}`)
}

function sanitize(value: unknown): string {
  const text = String(value).replace(/"/g, "'").replace(/\s+/g, ' ').trim()
  return text.length > MAX_FIELD_LEN ? `${text.slice(0, MAX_FIELD_LEN)}…` : text
}
