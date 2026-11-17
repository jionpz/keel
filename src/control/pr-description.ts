/**
 * PR 标题与正文的共享生成逻辑。
 *
 * legacy Task/Run 与 managed ticket 的事实来源不同，但对外契约一致：
 * - 没有仓库提交模板时，标题沿用来源 issue / ticket 标题；
 * - 有模板时按同一模板渲染 header，并做 header 正则校验；
 * - 正文按章节呈现问题、根因、改动、验证和风险，缺哪类事实就整节省略；
 * - `Keel Task`、`Closes`、`keel:v1` 等兼容标记仍由 `pr-body.ts` 收口。
 *
 * 这里只消费已经落库的事实（artifact / 阶段记录），不在开 PR 时重新向模型要事实。
 */

import {
  type CommitMessageFields,
  parseCommitHeader,
  type RepoCommitPolicy,
} from '../shared/commit-policy.js'
import { prBodyWithIssueReferences } from './pr-body.js'

/**
 * 正文主体上限：legacy 与 managed 共用。超出时先截断主体，兼容引用与机器标记
 * 仍在截断之后追加；事实正文来自没有 maxLength 约束的自由文本，必须设上限。
 */
export const PULL_REQUEST_BODY_MAX_LENGTH = 12000

export interface PullRequestSection {
  readonly heading: string
  readonly content: string
  /** 事实来源，例如 artifact:rfc@2 或 managed-ticket-stage:<stage row id>。 */
  readonly source: string
}

export interface PullRequestArtifactFact {
  /** 可回查的 Fact Plane 标识，例如 artifact:rfc@2。 */
  readonly ref: string
  readonly body: Record<string, unknown>
}

export interface PullRequestArtifactFacts {
  readonly rfc?: PullRequestArtifactFact | undefined
  readonly qa?: PullRequestArtifactFact | undefined
  readonly review?: PullRequestArtifactFact | undefined
  readonly develop?: PullRequestArtifactFact | undefined
  readonly state?: PullRequestArtifactFact | undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const value = text(entry)
        return value === null ? [] : [value]
      })
    : []
}

function bullets(lines: readonly string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

function proposedChange(body: Record<string, unknown>): string | null {
  const change = record(body.proposed_change)
  if (change === null) return null
  const lines: string[] = []
  const summary = text(change.summary)
  if (summary !== null) lines.push(`摘要：${summary}`)
  const approach = text(change.approach)
  if (approach !== null) lines.push(`方案：${approach}`)
  const areas = strings(change.affected_areas)
  if (areas.length > 0) lines.push(`影响面：${areas.join('、')}`)
  return lines.length === 0 ? null : bullets(lines)
}

function stateRisks(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.risks)) return []
  return body.risks.flatMap((entry) => {
    const risk = record(entry)
    if (risk === null) return []
    const textValue = text(risk.text)
    if (textValue === null) return []
    const severity = text(risk.severity)
    const mitigation = text(risk.mitigation)
    return [
      [
        severity === null ? textValue : `[${severity}] ${textValue}`,
        mitigation === null ? null : `缓解：${mitigation}`,
      ]
        .filter((part) => part !== null)
        .join('；'),
    ]
  })
}

function reviewFailures(body: Record<string, unknown>): string[] {
  if (body.verdict !== 'fail') return []
  const lines: string[] = []
  const reason = text(body.reason)
  if (reason !== null) lines.push(`Review 未通过：${reason}`)
  const details = record(body.details)
  const failed = strings(details?.failed_criteria)
  if (failed.length > 0) lines.push(`未通过标准：${failed.join('、')}`)
  return lines
}

function section(heading: string, content: string, source: string): PullRequestSection {
  return { heading, content, source }
}

/**
 * 从已落库的事实生成正文章节。缺失的事实整节省略，不写占位文字。
 *
 * `problem` 和 `changes` 总有来源：前者是来源 issue / ticket 标题，后者在没有
 * RFC / develop 产物时退回分支与基线事实。
 */
export function pullRequestSections(input: {
  readonly issueTitle: string
  readonly issueSource: string
  readonly facts: PullRequestArtifactFacts
  readonly fallbackChanges: string
  readonly fallbackChangesSource: string
}): readonly PullRequestSection[] {
  const sections: PullRequestSection[] = []
  const { rfc, qa, review, develop, state } = input.facts
  const problem = text(input.issueTitle)
  if (problem !== null) sections.push(section('问题', problem, input.issueSource))

  const rootCause = rfc === undefined ? null : text(rfc.body.problem)
  if (rootCause !== null && rfc !== undefined) {
    sections.push(section('根因', rootCause, rfc.ref))
  }

  const changeLines: string[] = []
  const changeSources: string[] = []
  const rfcChange = rfc === undefined ? null : proposedChange(rfc.body)
  if (rfcChange !== null && rfc !== undefined) {
    changeLines.push(rfcChange)
    changeSources.push(rfc.ref)
  }
  const developReason = develop === undefined ? null : text(develop.body.reason)
  if (developReason !== null && develop !== undefined) {
    changeLines.push(`实施：${developReason}`)
    changeSources.push(develop.ref)
  }
  if (changeLines.length === 0) {
    changeLines.push(input.fallbackChanges)
    changeSources.push(input.fallbackChangesSource)
  }
  sections.push(section('改动', changeLines.join('\n'), changeSources.join(', ')))

  const verification: string[] = []
  const verificationSources: string[] = []
  for (const [label, outcome] of [
    ['QA', qa],
    ['Review', review],
  ] as const) {
    if (outcome === undefined) continue
    const verdict = text(outcome.body.verdict)
    const reason = text(outcome.body.reason)
    if (verdict === null && reason === null) continue
    verification.push(`${label}：${[verdict, reason].filter((part) => part !== null).join(' — ')}`)
    verificationSources.push(outcome.ref)
  }
  if (verification.length > 0) {
    sections.push(section('验证', bullets(verification), verificationSources.join(', ')))
  }

  const risks = state === undefined ? [] : stateRisks(state.body)
  const riskSources: string[] = []
  if (state !== undefined && risks.length > 0) riskSources.push(state.ref)
  if (review !== undefined) {
    const failures = reviewFailures(review.body)
    if (failures.length > 0) {
      risks.push(...failures)
      riskSources.push(review.ref)
    }
  }
  if (risks.length > 0) {
    sections.push(section('风险与未做', bullets(risks), riskSources.join(', ')))
  }
  return sections
}

/** 统一正文骨架；引用与机器标记仍由 prBodyWithIssueReferences 追加。 */
export function renderPullRequestBody(input: {
  readonly taskId: string
  readonly sections: readonly PullRequestSection[]
}): string {
  const blocks = [`Keel Task ${input.taskId}`]
  for (const item of input.sections) {
    const content = item.content.trim()
    if (content === '') continue
    blocks.push(`## ${item.heading}\n\n${content}\n\n来源：${item.source}`)
  }
  return blocks.join('\n\n')
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncate(value: string, max: number): string {
  const chars = [...value]
  return chars.length <= max ? value : chars.slice(0, max).join('')
}

function singleLineTitle(value: string): string {
  return truncate(
    value
      .replace(/[\r\n\0]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    1000,
  )
}

function truncatedTemplateHeader(
  policy: RepoCommitPolicy,
  fields: CommitMessageFields,
  maxLength: number,
): string | null {
  const template = policy.commit_message_template
  if (template === undefined) return null
  const marker = '{summary}'
  const index = template.indexOf(marker)
  if (index < 0) return null
  const before = template.slice(0, index)
  const after = template.slice(index + marker.length)
  const expand = (part: string) =>
    part.replace(/\{type\}/g, fields.type).replace(/\{scope\}/g, fields.scope)
  const prefix = expand(before)
  const suffix = expand(after)
  const available = maxLength - [...prefix].length - [...suffix].length
  if (available < 1) return null
  return `${prefix}${truncate(fields.summary, Math.min(available, 72))}${suffix}`
}

/**
 * 生成 PR 标题。
 *
 * 未配置提交模板、或提交字段缺失/不合法时沿用来源标题。配置模板后按同一模板
 * 渲染 header：先压缩空白，再截断到 100 个 Unicode 字符，最后仍要过仓库的
 * header 正则；任何一步不满足都退回来源标题，不把不合规的标题送到 GitHub。
 */
export function pullRequestTitle(input: {
  readonly issueTitle: string
  readonly policy?: RepoCommitPolicy
  readonly commitMessage?: CommitMessageFields
}): string {
  const fallback = singleLineTitle(input.issueTitle)
  const policy = input.policy
  const fields = input.commitMessage
  if (policy?.commit_message_template === undefined || fields === undefined) return fallback
  const type = collapse(fields.type)
  const scope = collapse(fields.scope)
  const summary = collapse(fields.summary)
  if (
    !policy.commit_types?.includes(type) ||
    !policy.commit_scopes?.includes(scope) ||
    summary === ''
  )
    return fallback

  const normalized = { type, scope, summary }
  const rendered = truncatedTemplateHeader(policy, normalized, 100)
  const title = rendered !== null && [...rendered].length <= 100 ? rendered : null
  if (title === null) return fallback
  const check = policy.commit_message_check
  if (check !== undefined && check !== 'hook') {
    try {
      if (!new RegExp(check, 'u').test(title)) return fallback
    } catch {
      return fallback
    }
  }
  return title
}

/** 从已落盘的 commit header 取 PR 标题字段；不符合模板时返回 undefined。 */
export function commitFieldsFromHeader(
  policy: RepoCommitPolicy | undefined,
  message: string | null,
): CommitMessageFields | undefined {
  if (policy === undefined || message === null) return undefined
  const header = message.split('\n')[0] ?? ''
  return parseCommitHeader(policy, header) ?? undefined
}

/**
 * 一次完成正文渲染与兼容引用追加，legacy 与 managed 都从这条出口出正文。
 */
export function pullRequestBody(input: {
  readonly taskId: string
  readonly sections: readonly PullRequestSection[]
  readonly remoteUrl: string | null | undefined
  readonly externalRefs: readonly string[]
  /** 截断正文主体，引用与机器标记仍在截断之后追加。 */
  readonly maxBodyLength?: number
}): string {
  const rendered = renderPullRequestBody({ taskId: input.taskId, sections: input.sections })
  return prBodyWithIssueReferences({
    body: input.maxBodyLength === undefined ? rendered : rendered.slice(0, input.maxBodyLength),
    taskId: input.taskId,
    remoteUrl: input.remoteUrl,
    externalRefs: input.externalRefs,
  })
}
