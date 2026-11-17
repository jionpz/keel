/** 仓库提交规范的纯校验与 header 渲染；配置不是执行器指令。 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { RepoCommitPolicy } from '../generated/managed.js'
import { MANAGED_SCHEMAS } from '../generated/managed.js'

export type { RepoCommitPolicy }
export const COMMIT_MESSAGE_REJECTED = 'commit_message_rejected'
const ajv = new Ajv2020({ allErrors: true })
const validate = ajv.compile<RepoCommitPolicy>(MANAGED_SCHEMAS.repo_commit_policy)

export function validateCommitPolicy(value: unknown): Result<RepoCommitPolicy> {
  if (!validate(value)) return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors)))
  if (value.commit_author !== undefined) {
    const parts = value.commit_author.match(/^(.*) <([^<>]+)>$/)
    // Git 会裁剪姓名和邮箱两端的这些字符；注册时拒绝，避免落下永远无法通过的提交。
    if (
      parts === null ||
      parts.slice(1).some((part) => part === '' || /^[\s.,:;"'\\]|[\s.,:;"'\\]$/u.test(part))
    ) {
      return err(
        makeError('SCHEMA_VIOLATION', 'commit_author 姓名/邮箱不能为空或含 Git 会裁剪的首尾字符'),
      )
    }
  }
  const template = value.commit_message_template
  if (template !== undefined) {
    const placeholders = template.match(/\{[^{}]*\}/g) ?? []
    if (
      placeholders.sort().join(',') !== '{scope},{summary},{type}' ||
      template.replace(/\{(type|scope|summary)\}/g, '').match(/[{}]/)
    ) {
      return err(
        makeError('SCHEMA_VIOLATION', '模板必须且只能各包含一次 {type}、{scope}、{summary}'),
      )
    }
  }
  if (value.commit_message_check !== undefined && value.commit_message_check !== 'hook') {
    try {
      new RegExp(value.commit_message_check, 'u')
    } catch {
      return err(
        makeError('SCHEMA_VIOLATION', 'commit_message_check 必须是有效 header 正则或 hook'),
      )
    }
  }
  return ok(value)
}

export function commitMessageRejection(reason: string): ReturnType<typeof makeError> {
  return makeError('SCHEMA_VIOLATION', `${COMMIT_MESSAGE_REJECTED}: ${reason}`)
}

export interface CommitMessageFields {
  readonly type: string
  readonly scope: string
  readonly summary: string
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commitHeaderPattern(policy: RepoCommitPolicy): string | null {
  const template = policy.commit_message_template
  if (template === undefined) return null
  return template
    .split(/(\{type\}|\{scope\}|\{summary\})/)
    .map((part) => {
      if (part === '{type}') return `(?<type>${policy.commit_types?.map(escapePattern).join('|')})`
      if (part === '{scope}')
        return `(?<scope>${policy.commit_scopes?.map(escapePattern).join('|')})`
      // 在匹配时限定 summary，允许正则回溯到合法的枚举边界。
      return part === '{summary}'
        ? '(?<summary>[^\\s\\0](?:[^\\r\\n\\0]{0,70}[^\\s\\0])?)'
        : escapePattern(part)
    })
    .join('')
}

/** 从已落盘的 header 解析模板字段；只接受仓库闭合枚举。 */
export function parseCommitHeader(
  policy: RepoCommitPolicy,
  header: string,
): CommitMessageFields | null {
  const pattern = commitHeaderPattern(policy)
  if (pattern === null) return null
  const groups = new RegExp(`^${pattern}$`, 'u').exec(header)?.groups
  if (groups === undefined) return null
  const { type, scope, summary } = groups
  if (
    type === undefined ||
    scope === undefined ||
    summary === undefined ||
    !policy.commit_types?.includes(type) ||
    !policy.commit_scopes?.includes(scope) ||
    summary.trim() !== summary ||
    [...summary].length > 72
  )
    return null
  return { type, scope, summary }
}

/** 按仓库模板渲染 header，不附加 Keel-Run 正文行。 */
export function renderCommitHeader(
  policy: RepoCommitPolicy,
  fields: CommitMessageFields,
): Result<string> {
  if (policy.commit_message_template === undefined)
    return err(commitMessageRejection('仓库未配置提交模板'))
  if (
    !policy.commit_types?.includes(fields.type) ||
    !policy.commit_scopes?.includes(fields.scope)
  ) {
    return err(commitMessageRejection(`type/scope 不在仓库闭合枚举中：${JSON.stringify(fields)}`))
  }
  if (
    fields.summary.trim() !== fields.summary ||
    fields.summary.length === 0 ||
    [...fields.summary].length > 72 ||
    /[\r\n\0]/.test(fields.summary)
  ) {
    return err(commitMessageRejection('summary 必须是 1–72 字符的单行描述，不能有首尾空白'))
  }
  const values = { type: fields.type, scope: fields.scope, summary: fields.summary }
  const header = policy.commit_message_template.replace(
    /\{(type|scope|summary)\}/g,
    (_match, key: 'type' | 'scope' | 'summary') => values[key],
  )
  if ([...header].length > 100 || /[\r\n\0]/.test(header)) {
    return err(commitMessageRejection('header 必须是最多 100 字符的单行文本'))
  }
  return ok(header)
}

export function renderCommitMessage(
  policy: RepoCommitPolicy,
  stage: string,
  runId: string,
  body: unknown,
): Result<string> {
  if (policy.commit_message_template === undefined) return ok(`${stage}: run ${runId.slice(0, 8)}`)
  const fields =
    typeof body === 'object' && body !== null && 'commit_message' in body
      ? body.commit_message
      : undefined
  if (
    typeof fields !== 'object' ||
    fields === null ||
    !('type' in fields) ||
    !('scope' in fields) ||
    !('summary' in fields) ||
    typeof fields.type !== 'string' ||
    typeof fields.scope !== 'string' ||
    typeof fields.summary !== 'string'
  ) {
    return err(commitMessageRejection('Developer 结果必须提供 commit_message.type/scope/summary'))
  }
  const header = renderCommitHeader(policy, {
    type: fields.type,
    scope: fields.scope,
    summary: fields.summary,
  })
  if (!header.ok) return header
  return ok(`${header.value}\n\nKeel-Run: ${runId} stage=${stage}`)
}

/** 核对已落在分支上的真实消息，防止 Harness 自行 commit 或 hook 改写绕过规范。 */
export function validateStoredCommitMessage(
  policy: RepoCommitPolicy,
  message: string,
): Result<void> {
  if (policy.commit_message_template === undefined) return ok(undefined)
  const header = message.split('\n')[0] ?? ''
  const fields = parseCommitHeader(policy, header)
  const run = /\n\nKeel-Run: (\S+) stage=([a-z_]+)$/.exec(message)
  if (fields === null || run === null) {
    return err(commitMessageRejection('真实提交必须符合 header 模板并包含普通 Keel-Run 正文行'))
  }
  const rendered = renderCommitMessage(policy, run[2] ?? '', run[1] ?? '', {
    commit_message: fields,
  })
  if (!rendered.ok) return rendered
  return rendered.value === message
    ? ok(undefined)
    : err(commitMessageRejection('真实提交消息与仓库模板不一致'))
}

/** SQL 的 NULL 映射到可选字段；仅从固定列取配置，不消费任意 repo 文字。 */
export const COMMIT_POLICY_COLUMNS = [
  'commit_author',
  'commit_message_template',
  'commit_message_check',
  'commit_types',
  'commit_scopes',
] as const
export function commitPolicyFromRow(row: Record<string, unknown>): Result<RepoCommitPolicy> {
  return validateCommitPolicy(
    Object.fromEntries(
      COMMIT_POLICY_COLUMNS.filter((key) => row[key] !== null && row[key] !== undefined).map(
        (key) => [key, row[key]],
      ),
    ),
  )
}
