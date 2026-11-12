/**
 * PR 正文中的来源 issue 引用。
 *
 * legacy 与 managed 两条开 PR 路径共用这里，避免“同仓写 Closes、跨仓写 Refs”
 * 的规则各写一份后漂移。只有 issue 引用存在时才追加机器标记；没有 GitHub
 * 来源的 Task 保持原正文不变。
 */

import { parseIssueUrl } from '../fact/github-provider.js'
import { parseRemoteUrl } from '../fact/github-remote.js'

const ABSOLUTE_REF = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)#([1-9]\d*)$/
const RELATIVE_REF = /^#([1-9]\d*)$/

interface IssueReference {
  readonly key: string
  readonly line: string
}

function repoSlug(remoteUrl: string | null | undefined): { host: string; slug: string } | null {
  if (remoteUrl === null || remoteUrl === undefined) return null
  const parsed = parseRemoteUrl(remoteUrl)
  return parsed.ok
    ? { host: parsed.value.host, slug: `${parsed.value.owner}/${parsed.value.repo}`.toLowerCase() }
    : null
}

function issueReference(
  externalRef: string,
  sameRepo: { host: string; slug: string } | null,
): IssueReference | null {
  const ref = externalRef.trim()
  if (/^https?:\/\//i.test(ref)) {
    const issue = parseIssueUrl(ref)
    if (!issue.ok) return null
    const source = repoSlug(issue.value.remoteUrl)
    if (source === null) return null
    const number = issue.value.number
    if (!Number.isSafeInteger(number) || number < 1) return null
    const sameHost = source.host === sameRepo?.host
    return {
      key: `${source.host}/${source.slug}#${number}`,
      line:
        sameHost && source.slug === sameRepo?.slug
          ? `Closes #${number}`
          : `Refs ${sameHost ? `${source.slug}#${number}` : `https://${source.host}/${source.slug}/issues/${number}`}`,
    }
  }
  const relative = RELATIVE_REF.exec(ref)
  if (relative !== null) {
    if (sameRepo === null) return null
    const number = relative[1] as string
    if (!Number.isSafeInteger(Number(number))) return null
    return { key: `${sameRepo.host}/${sameRepo.slug}#${number}`, line: `Closes #${number}` }
  }

  const absolute = ABSOLUTE_REF.exec(ref)
  if (absolute === null) return null
  const owner = absolute[1] as string
  const repo = absolute[2] as string
  const number = absolute[3] as string
  if (!Number.isSafeInteger(Number(number))) return null
  const slug = `${owner}/${repo}`
  const key = `${sameRepo?.host ?? ''}/${slug.toLowerCase()}#${number}`
  return {
    key,
    line: sameRepo?.slug === slug.toLowerCase() ? `Closes #${number}` : `Refs ${slug}#${number}`,
  }
}

/** 把来源 issue 转成 PR 正文行；非法引用忽略，重复 external_ref 只保留一条。 */
export function issueReferenceLines(
  externalRefs: readonly string[],
  remoteUrl: string | null | undefined,
): readonly string[] {
  const sameRepo = repoSlug(remoteUrl)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const externalRef of externalRefs) {
    const parsed = issueReference(externalRef, sameRepo)
    if (parsed === null || seen.has(parsed.key)) continue
    seen.add(parsed.key)
    lines.push(parsed.line)
  }
  return lines
}

/**
 * 在有来源 issue 时追加引用段与机器可读标记；没有引用时原样返回。
 */
export function prBodyWithIssueReferences(input: {
  readonly body: string
  readonly taskId: string
  readonly remoteUrl: string | null | undefined
  readonly externalRefs: readonly string[]
}): string {
  const lines = issueReferenceLines(input.externalRefs, input.remoteUrl)
  if (lines.length === 0) return input.body
  return `${input.body.trimEnd()}\n\n${lines.join('\n')}\n<!-- keel:v1 task=${input.taskId} -->`
}
