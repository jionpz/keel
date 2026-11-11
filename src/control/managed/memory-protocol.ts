/**
 * JT-03 项目记忆纯协议层。
 *
 * 只处理已读取的权威决定与记忆投影；不访问数据库、时钟或进程状态。
 * 摘要可以回滚，但 live 投影与当前有效期始终是“不复活旧结论”的最后防线。
 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ProjectDecision, ProjectMemoryContent } from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { canonicalJson, sha256CanonicalJson } from '../../shared/canonical-json.js'
import { validateProjectDecision } from './decision-protocol.js'

export const MEMORY_MODEL_VERSION = 'keel-deterministic-v1'

export type ProjectMemoryEntry = ProjectMemoryContent['entries'][number]

type DecisionKind = Exclude<ProjectDecision['scope']['decision_kinds'][number], '*'>
type DecisionEnvironment = Exclude<ProjectDecision['scope']['environments'][number], '*'>
type DecisionReversibility = Exclude<ProjectDecision['scope']['reversibilities'][number], '*'>

export interface ProjectMemoryQueryImpact {
  environment: DecisionEnvironment
  reversibility: DecisionReversibility
  affected_resources: readonly string[]
}

export interface ProjectMemoryQuery {
  project_id: string
  text: string
  decision_key?: string
  kind?: DecisionKind
  action_category?: string
  impact?: ProjectMemoryQueryImpact
  budget_entries: number
  budget_tokens: number
}

export interface ProjectMemoryRetrievalEntry extends ProjectMemoryEntry {
  applicable: boolean
  match_reason: string
}

export interface ProjectMemorySelection {
  entries: ProjectMemoryRetrievalEntry[]
  candidate_count: number
  omitted_count: number
  used_tokens: number
  escalation_reason: string | null
  expansion_reason: string | null
}

export interface MergeMemoryResult {
  entries: ProjectMemoryEntry[]
  removedDecisionIds: string[]
  addedDecisionIds: string[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN = /[\p{L}\p{N}]+/gu
const HAN_RUN = /\p{Script=Han}+/gu

const ajv = new Ajv2020({ allErrors: true })
const memoryValidator = ajv.compile<ProjectMemoryContent>(MANAGED_SCHEMAS.project_memory_content)

function timestamp(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function fieldMatches(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value)
}

function validSelector(selector: string): boolean {
  if (selector === '*') return true
  if (!selector.includes('*')) return selector.length > 0
  return selector.length > 1 && selector.endsWith('*') && !selector.slice(0, -1).includes('*')
}

function selectorMatches(selector: string, resource: string): boolean {
  if (!validSelector(selector)) return false
  if (selector === '*') return true
  return selector.endsWith('*') ? resource.startsWith(selector.slice(0, -1)) : resource === selector
}

function resourcesMatch(selectors: readonly string[], resources: readonly string[]): boolean {
  return (
    resources.length > 0 &&
    resources.every((resource) => selectors.some((selector) => selectorMatches(selector, resource)))
  )
}

function activeAt(decision: ProjectDecision, now: number): boolean {
  if (decision.revoked_at !== undefined || decision.superseded_by !== undefined) return false
  const from = timestamp(decision.valid_from)
  if (from === null || from > now) return false
  if (decision.valid_until === undefined) return true
  const until = timestamp(decision.valid_until)
  return until !== null && now < until
}

function selectedOption(decision: ProjectDecision): ProjectDecision['options'][number] | undefined {
  return decision.options.find((option) => option.id === decision.selected_option_id)
}

function compareDecisions(left: ProjectDecision, right: ProjectDecision): number {
  const key = compareText(left.decision_key, right.decision_key)
  if (key !== 0) return key
  if (left.version !== right.version) return left.version - right.version
  return compareText(left.id, right.id)
}

function compareEntries(left: ProjectMemoryEntry, right: ProjectMemoryEntry): number {
  const project = compareText(left.project_id, right.project_id)
  if (project !== 0) return project
  const key = compareText(left.decision_key, right.decision_key)
  if (key !== 0) return key
  if (left.decision_version !== right.decision_version)
    return left.decision_version - right.decision_version
  return compareText(left.decision_id, right.decision_id)
}

function cloneMemoryEntry(entry: ProjectMemoryEntry): ProjectMemoryEntry {
  return {
    project_id: entry.project_id,
    decision_id: entry.decision_id,
    decision_key: entry.decision_key,
    decision_version: entry.decision_version,
    statement: entry.statement,
    selected_option_id: entry.selected_option_id,
    options: entry.options.map((option) => ({ ...option })) as ProjectMemoryEntry['options'],
    scope: {
      decision_kinds: [...entry.scope.decision_kinds],
      actions: [...entry.scope.actions],
      resource_selectors: [...entry.scope.resource_selectors],
      environments: [...entry.scope.environments],
      reversibilities: [...entry.scope.reversibilities],
    } as ProjectMemoryEntry['scope'],
    source_type: entry.source_type,
    source_ref: entry.source_ref,
    valid_from: entry.valid_from,
    ...(entry.valid_until === undefined ? {} : { valid_until: entry.valid_until }),
    conditions: [...entry.conditions],
    conflicts: [...entry.conflicts],
  }
}

function clipText(value: string, maxLength: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  return `${characters.slice(0, maxLength - 1).join('')}…`
}

function describeValues(values: readonly string[], maxLength = 1500): string {
  if (values.includes('*')) return '全部'
  const sorted = [...new Set(values)].sort(compareText)
  const parts: string[] = []
  let used = 0
  for (const [index, value] of sorted.entries()) {
    const separator = parts.length === 0 ? 0 : 1
    if (used + separator + value.length > maxLength) {
      parts.push(`等 ${sorted.length - index} 项`)
      break
    }
    parts.push(value)
    used += separator + value.length
  }
  return parts.join('、')
}

function deriveConditions(decision: ProjectDecision): string[] {
  const conditions = [
    `适用决定类型：${describeValues(decision.scope.decision_kinds)}`,
    `适用动作：${describeValues(decision.scope.actions)}`,
    `适用资源：${describeValues(decision.scope.resource_selectors)}`,
    `适用环境：${describeValues(decision.scope.environments)}`,
    `可逆性：${describeValues(decision.scope.reversibilities)}`,
  ]
  if (decision.valid_until !== undefined) conditions.push(`有效期至：${decision.valid_until}`)
  return conditions
}

function optionLabel(option: ProjectDecision['options'][number]): string {
  return `${option.id}「${clipText(option.text, 180)}」`
}

function answerConflicts(left: ProjectDecision, right: ProjectDecision): boolean {
  const leftOption = selectedOption(left)
  const rightOption = selectedOption(right)
  if (leftOption === undefined || rightOption === undefined) return true
  return (
    left.selected_option_id !== right.selected_option_id || leftOption.text !== rightOption.text
  )
}

function deriveConflicts(
  decision: ProjectDecision,
  activeDecisions: readonly ProjectDecision[],
): string[] {
  const ownOption = selectedOption(decision)
  if (ownOption === undefined) return []
  return activeDecisions
    .filter(
      (candidate) =>
        candidate.id !== decision.id &&
        candidate.decision_key === decision.decision_key &&
        answerConflicts(decision, candidate),
    )
    .sort(compareDecisions)
    .slice(0, 32)
    .map((other) => {
      const otherOption = selectedOption(other)
      const otherAnswer =
        otherOption === undefined
          ? `${other.selected_option_id}「选项正文缺失」`
          : optionLabel(otherOption)
      return `同一 decision_key「${decision.decision_key}」存在冲突：本决定版本 ${decision.version} 选择 ${optionLabel(ownOption)}；版本 ${other.version}（${other.id}）选择 ${otherAnswer}。`
    })
}

function toMemoryEntry(
  decision: ProjectDecision,
  activeDecisions: readonly ProjectDecision[],
): ProjectMemoryEntry {
  return {
    project_id: decision.project_id,
    decision_id: decision.id,
    decision_key: decision.decision_key,
    decision_version: decision.version,
    statement: decision.statement,
    selected_option_id: decision.selected_option_id,
    options: decision.options.map((option) => ({ ...option })) as ProjectMemoryEntry['options'],
    scope: {
      decision_kinds: [...decision.scope.decision_kinds],
      actions: [...decision.scope.actions],
      resource_selectors: [...decision.scope.resource_selectors],
      environments: [...decision.scope.environments],
      reversibilities: [...decision.scope.reversibilities],
    } as ProjectMemoryEntry['scope'],
    source_type: decision.source_type,
    source_ref: decision.source_ref,
    valid_from: decision.valid_from,
    ...(decision.valid_until === undefined ? {} : { valid_until: decision.valid_until }),
    conditions: deriveConditions(decision),
    conflicts: deriveConflicts(decision, activeDecisions),
  }
}

function validateDecisionInput(decision: ProjectDecision): Result<ProjectDecision> {
  const checked = validateProjectDecision(decision)
  if (!checked.ok) return checked
  if (selectedOption(decision) === undefined)
    return err(makeError('SCHEMA_VIOLATION', `项目决定 ${decision.id} 的选项不在 options 内`))
  if (timestamp(decision.valid_from) === null)
    return err(makeError('SCHEMA_VIOLATION', `项目决定 ${decision.id} 的 valid_from 不是合法时间`))
  if (decision.valid_until !== undefined && timestamp(decision.valid_until) === null)
    return err(makeError('SCHEMA_VIOLATION', `项目决定 ${decision.id} 的 valid_until 不是合法时间`))
  return ok(decision)
}

export function buildProjectMemoryContent(
  projectId: string,
  decisions: readonly ProjectDecision[],
  now: string,
): Result<ProjectMemoryContent> {
  if (!UUID.test(projectId)) return err(makeError('SCHEMA_VIOLATION', 'project_id 不是 UUID'))
  const nowValue = timestamp(now)
  if (nowValue === null) return err(makeError('SCHEMA_VIOLATION', 'now 不是合法时间'))

  const projectDecisions = decisions.filter((decision) => decision.project_id === projectId)
  for (const decision of projectDecisions) {
    const checked = validateDecisionInput(decision)
    if (!checked.ok) return checked
  }

  const activeDecisions = projectDecisions
    .filter((decision) => activeAt(decision, nowValue))
    .sort(compareDecisions)
  if (activeDecisions.length > 512)
    return err(
      makeError(
        'CONTEXT_BUDGET_EXCEEDED',
        `项目记忆需要 ${activeDecisions.length} 条，超过 512 条上限，拒绝静默截断`,
      ),
    )

  const content: ProjectMemoryContent = {
    entries: activeDecisions.map((decision) => toMemoryEntry(decision, activeDecisions)),
  }
  const checked = validateProjectMemoryContent(content, projectId, decisions, now)
  return checked.ok ? checked : err(checked.error)
}

function snapshotMatches(entry: ProjectMemoryEntry, decision: ProjectDecision): boolean {
  return (
    entry.project_id === decision.project_id &&
    entry.decision_id === decision.id &&
    entry.decision_key === decision.decision_key &&
    entry.decision_version === decision.version &&
    entry.statement === decision.statement &&
    entry.selected_option_id === decision.selected_option_id &&
    canonicalJson(entry.options) === canonicalJson(decision.options) &&
    canonicalJson(entry.scope) === canonicalJson(decision.scope) &&
    entry.source_type === decision.source_type &&
    entry.source_ref === decision.source_ref &&
    entry.valid_from === decision.valid_from &&
    canonicalJson(entry.valid_until ?? null) === canonicalJson(decision.valid_until ?? null)
  )
}

export function validateProjectMemoryContent(
  value: unknown,
  projectId?: string,
  decisions?: readonly ProjectDecision[],
  now?: string,
): Result<ProjectMemoryContent> {
  if (!memoryValidator(value))
    return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(memoryValidator.errors ?? undefined)))
  const content = value as ProjectMemoryContent

  if (projectId !== undefined && !UUID.test(projectId))
    return err(makeError('SCHEMA_VIOLATION', 'project_id 不是 UUID'))
  if ((decisions === undefined) !== (now === undefined))
    return err(makeError('SCHEMA_VIOLATION', 'decisions 与 now 必须同时提供'))
  const nowValue = now === undefined ? null : timestamp(now)
  if (now !== undefined && nowValue === null)
    return err(makeError('SCHEMA_VIOLATION', 'now 不是合法时间'))

  const decisionIds = new Set<string>()
  const keyVersions = new Set<string>()
  let contentProjectId: string | undefined

  for (const [index, entry] of content.entries.entries()) {
    if (projectId !== undefined && entry.project_id !== projectId)
      return err(makeError('SCHEMA_VIOLATION', `第 ${index + 1} 条记忆不属于项目 ${projectId}`))
    if (contentProjectId === undefined) contentProjectId = entry.project_id
    else if (contentProjectId !== entry.project_id)
      return err(makeError('SCHEMA_VIOLATION', '项目记忆内容混入了多个 project_id'))

    const idKey = `${entry.project_id}\u0000${entry.decision_id}`
    if (decisionIds.has(idKey))
      return err(makeError('SCHEMA_VIOLATION', `decision_id 重复：${entry.decision_id}`))
    decisionIds.add(idKey)

    const keyVersion = `${entry.project_id}\u0000${entry.decision_key}\u0000${entry.decision_version}`
    if (keyVersions.has(keyVersion))
      return err(
        makeError(
          'SCHEMA_VIOLATION',
          `decision_key/version 重复：${entry.decision_key}@${entry.decision_version}`,
        ),
      )
    keyVersions.add(keyVersion)

    if (!entry.options.some((option) => option.id === entry.selected_option_id))
      return err(
        makeError(
          'SCHEMA_VIOLATION',
          `记忆条目 ${entry.decision_id} 的 selected_option_id 不在 options 内`,
        ),
      )
  }

  if (decisions === undefined || nowValue === null || contentProjectId === undefined) {
    return ok(content)
  }

  const sourceDecisions = decisions.filter((decision) => decision.project_id === contentProjectId)
  const sourceById = new Map<string, ProjectDecision>()
  for (const decision of sourceDecisions) {
    const checked = validateDecisionInput(decision)
    if (!checked.ok) return checked
    if (sourceById.has(decision.id))
      return err(makeError('SCHEMA_VIOLATION', `当前决定集含重复 decision_id：${decision.id}`))
    sourceById.set(decision.id, decision)
  }
  const activeDecisions = sourceDecisions
    .filter((decision) => activeAt(decision, nowValue))
    .sort(compareDecisions)

  for (const entry of content.entries) {
    const source = sourceById.get(entry.decision_id)
    if (source === undefined)
      return err(makeError('CONFLICT', `记忆条目 ${entry.decision_id} 引用的当前项目决定已不存在`))
    if (source.version !== entry.decision_version)
      return err(
        makeError(
          'CONFLICT',
          `记忆条目 ${entry.decision_id} 引用版本 ${entry.decision_version}，当前版本为 ${source.version}`,
        ),
      )
    if (!snapshotMatches(entry, source))
      return err(
        makeError('SCHEMA_VIOLATION', `记忆条目 ${entry.decision_id} 的字段与权威决定不一致`),
      )
    if (!activeAt(source, nowValue))
      return err(
        makeError('CONFLICT', `记忆条目 ${entry.decision_id} 引用的决定已过期、撤销或被替代`),
      )
    if (canonicalJson(entry.conditions) !== canonicalJson(deriveConditions(source)))
      return err(
        makeError('SCHEMA_VIOLATION', `记忆条目 ${entry.decision_id} 的 conditions 已被改写`),
      )
    if (canonicalJson(entry.conflicts) !== canonicalJson(deriveConflicts(source, activeDecisions)))
      return err(
        makeError('SCHEMA_VIOLATION', `记忆条目 ${entry.decision_id} 的 conflicts 已被改写`),
      )
  }

  return ok(content)
}

export function projectMemoryContentDigest(content: ProjectMemoryContent): string {
  return sha256CanonicalJson(content)
}

function projectIdKey(entry: ProjectMemoryEntry): string {
  return `${entry.project_id}\u0000${entry.decision_id}`
}

function projectKeyVersion(entry: ProjectMemoryEntry): string {
  return `${entry.project_id}\u0000${entry.decision_key}\u0000${entry.decision_version}`
}

function uniqueEntries(entries: readonly ProjectMemoryEntry[]): ProjectMemoryEntry[] {
  const byId = new Map<string, ProjectMemoryEntry>()
  for (const entry of entries) {
    const key = projectIdKey(entry)
    const current = byId.get(key)
    const order = current === undefined ? -1 : compareEntries(entry, current)
    if (
      current === undefined ||
      order < 0 ||
      (order === 0 && compareText(canonicalJson(entry), canonicalJson(current)) < 0)
    )
      byId.set(key, cloneMemoryEntry(entry))
  }
  const byVersion = new Map<string, ProjectMemoryEntry>()
  for (const entry of [...byId.values()].sort(compareEntries)) {
    const key = projectKeyVersion(entry)
    if (!byVersion.has(key)) byVersion.set(key, entry)
  }
  return [...byVersion.values()].sort(compareEntries)
}

export function mergeMemoryCandidates(
  summaryEntries: readonly ProjectMemoryEntry[],
  liveEntries: readonly ProjectMemoryEntry[],
): MergeMemoryResult {
  const live = uniqueEntries(liveEntries)
  const liveById = new Set(live.map(projectIdKey))
  const summary = uniqueEntries(summaryEntries)
  const summaryIds = new Set(summary.map(projectIdKey))

  const removedDecisionIds = [
    ...new Set(
      summary
        .filter((entry) => !liveById.has(projectIdKey(entry)))
        .map((entry) => entry.decision_id),
    ),
  ].sort(compareText)
  const addedDecisionIds = [
    ...new Set(
      live
        .filter((entry) => !summaryIds.has(projectIdKey(entry)))
        .map((entry) => entry.decision_id),
    ),
  ].sort(compareText)

  return {
    entries: live,
    removedDecisionIds,
    addedDecisionIds,
  }
}

function textTerms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const terms = new Set<string>()
  for (const match of normalized.matchAll(TOKEN)) {
    const token = match[0]
    terms.add(token)
    for (const run of token.matchAll(HAN_RUN)) {
      const value = run[0]
      if (value.length === 1) {
        terms.add(value)
        continue
      }
      for (let index = 0; index < value.length - 1; index += 1) {
        terms.add(value.slice(index, index + 2))
      }
    }
  }
  return [...terms].sort(compareText)
}

function searchableText(entry: ProjectMemoryEntry): string {
  const selected = entry.options.find((option) => option.id === entry.selected_option_id)
  return [
    entry.decision_key,
    entry.statement,
    entry.selected_option_id,
    selected?.text ?? '',
    ...entry.options.map((option) => option.text),
    ...entry.scope.actions,
    ...entry.scope.resource_selectors,
  ]
    .join('\n')
    .normalize('NFKC')
    .toLowerCase()
}

function scopeApplies(entry: ProjectMemoryEntry, query: ProjectMemoryQuery): boolean {
  if (query.kind !== undefined && !fieldMatches(entry.scope.decision_kinds, query.kind))
    return false
  if (
    query.action_category !== undefined &&
    !fieldMatches(entry.scope.actions, query.action_category)
  )
    return false
  if (query.impact !== undefined) {
    if (!fieldMatches(entry.scope.environments, query.impact.environment)) return false
    if (!fieldMatches(entry.scope.reversibilities, query.impact.reversibility)) return false
    if (!resourcesMatch(entry.scope.resource_selectors, query.impact.affected_resources))
      return false
  }
  return true
}

function matchReason(
  exactKey: boolean,
  matchedTerms: readonly string[],
  applicable: boolean,
): string {
  const reasons: string[] = []
  if (exactKey) reasons.push('decision_key 精确匹配')
  if (matchedTerms.length > 0) reasons.push(`文本命中：${matchedTerms.join('、')}`)
  if (!exactKey && matchedTerms.length === 0) reasons.push('无文本命中')
  reasons.push(applicable ? '作用域适用' : '作用域不适用')
  return reasons.join('；')
}

function tokenEstimate(entry: ProjectMemoryRetrievalEntry): number {
  return Math.ceil(JSON.stringify(entry).length / 4)
}

interface PreparedCandidate {
  entry: ProjectMemoryRetrievalEntry
  exactKey: boolean
  matchedTerms: string[]
  applicable: boolean
  critical: boolean
  tokens: number
}

function compareCandidates(left: PreparedCandidate, right: PreparedCandidate): number {
  if (left.exactKey !== right.exactKey) return left.exactKey ? -1 : 1
  if (left.matchedTerms.length !== right.matchedTerms.length)
    return right.matchedTerms.length - left.matchedTerms.length
  if (left.applicable !== right.applicable) return left.applicable ? -1 : 1
  return compareEntries(left.entry, right.entry)
}

function prepareCandidate(
  source: ProjectMemoryEntry,
  query: ProjectMemoryQuery,
  queryTerms: readonly string[],
): PreparedCandidate {
  const entry = cloneMemoryEntry(source)
  const exactKey = query.decision_key !== undefined && entry.decision_key === query.decision_key
  const haystack = searchableText(entry)
  const matchedTerms = queryTerms.filter((term) => haystack.includes(term))
  const applicable = scopeApplies(entry, query)
  const critical = exactKey || (applicable && matchedTerms.length > 0)
  const retrievalEntry: ProjectMemoryRetrievalEntry = {
    ...entry,
    applicable,
    match_reason: matchReason(exactKey, matchedTerms, applicable),
  }
  return {
    entry: retrievalEntry,
    exactKey,
    matchedTerms,
    applicable,
    critical,
    tokens: tokenEstimate(retrievalEntry),
  }
}

export function selectProjectMemoryEntries(
  candidates: readonly ProjectMemoryEntry[],
  query: ProjectMemoryQuery,
): ProjectMemorySelection {
  if (!Number.isInteger(query.budget_entries) || query.budget_entries < 1)
    throw new RangeError('budget_entries 必须是 >= 1 的整数')
  if (!Number.isInteger(query.budget_tokens) || query.budget_tokens < 1)
    throw new RangeError('budget_tokens 必须是 >= 1 的整数')

  const queryTerms = textTerms(query.text)
  const ranked = candidates
    .filter((entry) => entry.project_id === query.project_id)
    .map((entry) => prepareCandidate(entry, query, queryTerms))
    .sort(compareCandidates)
  const critical = ranked.filter((candidate) => candidate.critical)
  const nonCritical = ranked.filter((candidate) => !candidate.critical)
  const criticalTokens = critical.reduce((total, candidate) => total + candidate.tokens, 0)
  const candidateCount = ranked.length

  if (critical.length > query.budget_entries || criticalTokens > query.budget_tokens) {
    const escalationReason = `关键记忆超出预算：${critical.length} 条关键候选需要 ${criticalTokens} tokens、${critical.length} 个条目，预算为 ${query.budget_tokens} tokens、${query.budget_entries} 个条目；已停止自动检索。`
    return {
      entries: [],
      candidate_count: candidateCount,
      omitted_count: candidateCount,
      used_tokens: 0,
      escalation_reason: escalationReason,
      expansion_reason:
        nonCritical.length > 0
          ? '关键记忆未完整纳入，非关键候选同样未展开，避免把不完整候选伪装成完整覆盖。'
          : null,
    }
  }

  const selected = [...critical]
  let usedTokens = criticalTokens
  for (const candidate of nonCritical) {
    if (
      selected.length >= query.budget_entries ||
      usedTokens + candidate.tokens > query.budget_tokens
    )
      continue
    selected.push(candidate)
    usedTokens += candidate.tokens
  }

  const omittedCount = candidateCount - selected.length
  return {
    entries: selected.map((candidate) => candidate.entry),
    candidate_count: candidateCount,
    omitted_count: omittedCount,
    used_tokens: usedTokens,
    escalation_reason: null,
    expansion_reason:
      omittedCount > 0
        ? `预算仅纳入 ${selected.length}/${candidateCount} 条候选，${omittedCount} 条非关键记忆因条目或 token 预算未展开。`
        : null,
  }
}
