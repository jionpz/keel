import { describe, expect, it } from 'vitest'
import type { Result } from '../../contracts/errors.js'
import type { ProjectDecision, ProjectMemoryContent } from '../../generated/managed.js'
import {
  buildProjectMemoryContent,
  MEMORY_MODEL_VERSION,
  mergeMemoryCandidates,
  type ProjectMemoryEntry,
  projectMemoryContentDigest,
  selectProjectMemoryEntries,
  validateProjectMemoryContent,
} from './memory-protocol.js'

const NOW = '2026-11-11T00:00:00.000Z'
const OLD = '2026-05-01T00:00:00.000Z'
const PAST = '2026-01-01T00:00:00.000Z'
const FUTURE = '2027-01-01T00:00:00.000Z'
const PROJECT_A = '11111111-1111-4111-8111-111111111111'
const PROJECT_B = '22222222-2222-4222-8222-222222222222'

const OPTIONS: ProjectDecision['options'] = [
  { id: 'zh', text: '中文' },
  { id: 'en', text: 'English' },
]

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function decision(index: number, over: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    schema_version: '1.0',
    id: uuid(index),
    project_id: PROJECT_A,
    decision_key: `memory.topic.${index}`,
    version: 1,
    statement: `项目决定 ${index}：使用中文。`,
    selected_option_id: 'zh',
    options: OPTIONS,
    scope: {
      decision_kinds: ['preference'],
      actions: ['write_file'],
      resource_selectors: ['docs/*'],
      environments: ['local'],
      reversibilities: ['reversible'],
    },
    source_type: 'owner_confirmed',
    source_ref: `owner-message:${index}`,
    created_by: 'owner',
    valid_from: PAST,
    created_at: PAST,
    ...over,
  }
}

function mustValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.detail}`)
  return result.value
}

function firstEntry(content: ProjectMemoryContent): ProjectMemoryEntry {
  const entry = content.entries[0]
  if (entry === undefined) throw new Error('missing memory entry')
  return entry
}

function cloneContent(content: ProjectMemoryContent): ProjectMemoryContent {
  return JSON.parse(JSON.stringify(content)) as ProjectMemoryContent
}

describe('项目记忆协议', () => {
  it('固定模型版本，并过滤项目、未来、过期、撤销与替代决定', () => {
    const active = decision(1, { valid_until: FUTURE })
    const expired = decision(2, { valid_until: PAST })
    const revoked = decision(3, {
      revoked_at: PAST,
      revoked_by: 'owner',
      revocation_reason: '已撤销',
    })
    const superseded = decision(4, { superseded_by: uuid(99) })
    const future = decision(5, { valid_from: FUTURE })
    const otherProject = decision(6, { project_id: PROJECT_B })

    const content = mustValue(
      buildProjectMemoryContent(
        PROJECT_A,
        [future, superseded, otherProject, expired, revoked, active],
        NOW,
      ),
    )

    expect(MEMORY_MODEL_VERSION).toBe('keel-deterministic-v1')
    expect(content.entries).toHaveLength(1)
    const entry = firstEntry(content)
    expect(entry.decision_id).toBe(active.id)
    expect(entry.source_type).toBe('owner_confirmed')
    expect(entry.conditions).toEqual([
      '适用决定类型：preference',
      '适用动作：write_file',
      '适用资源：docs/*',
      '适用环境：local',
      '可逆性：reversible',
      `有效期至：${FUTURE}`,
    ])
  })

  it('项目 A/B 的相似问题分别得到各自答案', () => {
    const a = decision(11, {
      project_id: PROJECT_A,
      decision_key: 'report.language',
      statement: '项目报告使用中文。',
      selected_option_id: 'zh',
    })
    const b = decision(12, {
      project_id: PROJECT_B,
      decision_key: 'report.language',
      statement: 'Project reports use English.',
      selected_option_id: 'en',
    })

    const contentA = mustValue(buildProjectMemoryContent(PROJECT_A, [a, b], NOW))
    const contentB = mustValue(buildProjectMemoryContent(PROJECT_B, [a, b], NOW))

    expect(contentA.entries.map((entry) => [entry.project_id, entry.selected_option_id])).toEqual([
      [PROJECT_A, 'zh'],
    ])
    expect(contentB.entries.map((entry) => [entry.project_id, entry.selected_option_id])).toEqual([
      [PROJECT_B, 'en'],
    ])
  })

  it('同一 decision_key 的答案冲突写入双方条目', () => {
    const first = decision(21, {
      decision_key: 'report.language',
      version: 1,
      selected_option_id: 'zh',
    })
    const second = decision(22, {
      decision_key: 'report.language',
      version: 2,
      selected_option_id: 'en',
    })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [second, first], NOW))

    expect(content.entries).toHaveLength(2)
    for (const entry of content.entries) {
      expect(entry.conflicts).toHaveLength(1)
      expect(entry.conflicts[0]).toContain('同一 decision_key「report.language」存在冲突')
      expect(entry.conflicts[0]).toContain('版本 1')
      expect(entry.conflicts[0]).toContain('版本 2')
    }
  })

  it('超过 512 条有效决定时显式失败，不静默截断', () => {
    const decisions = Array.from({ length: 513 }, (_, index) =>
      decision(index + 1000, {
        decision_key: `memory.bulk.${index}`,
      }),
    )
    const result = buildProjectMemoryContent(PROJECT_A, decisions, NOW)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('CONTEXT_BUDGET_EXCEEDED')
  })

  it('确定性排序、输入顺序无关且摘要稳定', () => {
    const decisions = [
      decision(32, { decision_key: 'z.topic', version: 2, statement: 'Z 版本二' }),
      decision(31, { decision_key: 'z.topic', version: 1, statement: 'Z 版本一' }),
      decision(33, { decision_key: 'a.topic', version: 1, statement: 'A 主题' }),
    ]
    const forward = mustValue(buildProjectMemoryContent(PROJECT_A, decisions, NOW))
    const reverse = mustValue(buildProjectMemoryContent(PROJECT_A, [...decisions].reverse(), NOW))

    expect(forward).toEqual(reverse)
    expect(forward.entries.map((entry) => entry.decision_key)).toEqual([
      'a.topic',
      'z.topic',
      'z.topic',
    ])
    expect(forward.entries.map((entry) => entry.decision_version)).toEqual([1, 1, 2])
    expect(projectMemoryContentDigest(forward)).toBe(projectMemoryContentDigest(reverse))
  })

  it('校验快照；字段篡改是 SCHEMA_VIOLATION，引用缺失或失效是 CONFLICT', () => {
    const source = decision(41)
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [source], NOW))
    expect(validateProjectMemoryContent(content, PROJECT_A, [source], NOW).ok).toBe(true)

    const tampered = cloneContent(content)
    firstEntry(tampered).statement = '被篡改的结论'
    const tamperedResult = validateProjectMemoryContent(tampered, PROJECT_A, [source], NOW)
    expect(tamperedResult.ok).toBe(false)
    if (!tamperedResult.ok) expect(tamperedResult.error.kind).toBe('SCHEMA_VIOLATION')

    const missingResult = validateProjectMemoryContent(content, PROJECT_A, [], NOW)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) expect(missingResult.error.kind).toBe('CONFLICT')

    const beforeRevocation = mustValue(
      buildProjectMemoryContent(PROJECT_A, [source], '2026-06-01T00:00:00.000Z'),
    )
    const revoked = { ...source, revoked_at: '2026-07-01T00:00:00.000Z' }
    const revokedResult = validateProjectMemoryContent(beforeRevocation, PROJECT_A, [revoked], NOW)
    expect(revokedResult.ok).toBe(false)
    if (!revokedResult.ok) expect(revokedResult.error.kind).toBe('CONFLICT')
  })

  it('校验 selected_option_id、唯一性与 schema project_id', () => {
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [decision(51)], NOW))
    const badOption = cloneContent(content)
    firstEntry(badOption).selected_option_id = 'missing'
    const optionResult = validateProjectMemoryContent(badOption)
    expect(optionResult.ok).toBe(false)
    if (!optionResult.ok) expect(optionResult.error.kind).toBe('SCHEMA_VIOLATION')

    const duplicate = cloneContent(content)
    duplicate.entries.push({ ...firstEntry(duplicate) })
    const duplicateResult = validateProjectMemoryContent(duplicate)
    expect(duplicateResult.ok).toBe(false)
    if (!duplicateResult.ok) expect(duplicateResult.error.kind).toBe('SCHEMA_VIOLATION')

    const wrongProjectResult = validateProjectMemoryContent(content, PROJECT_B)
    expect(wrongProjectResult.ok).toBe(false)
    if (!wrongProjectResult.ok) expect(wrongProjectResult.error.kind).toBe('SCHEMA_VIOLATION')
  })

  it('merge 以 live 权威投影覆盖 summary，删除失效项且不复活', () => {
    const expired = decision(61, {
      decision_key: 'memory.a',
      valid_until: '2026-06-01T00:00:00.000Z',
    })
    const oldSummary = decision(62, {
      decision_key: 'memory.b',
      statement: '旧摘要结论',
      source_type: 'imported_candidate',
    })
    const revoked = decision(64, { decision_key: 'memory.d' })
    const superseded = decision(65, { decision_key: 'memory.e' })
    const currentLive = {
      ...oldSummary,
      statement: '当前权威结论',
    }
    const added = decision(63, { decision_key: 'memory.c' })

    const summary = mustValue(
      buildProjectMemoryContent(PROJECT_A, [expired, oldSummary, revoked, superseded], OLD),
    )
    const live = mustValue(buildProjectMemoryContent(PROJECT_A, [currentLive, added], NOW))
    const merged = mergeMemoryCandidates(summary.entries, live.entries)

    expect(merged.removedDecisionIds).toEqual([expired.id, revoked.id, superseded.id].sort())
    expect(merged.addedDecisionIds).toEqual([added.id])
    expect(merged.entries.map((entry) => entry.decision_key)).toEqual(['memory.b', 'memory.c'])
    const retained = merged.entries.find((entry) => entry.decision_id === oldSummary.id)
    expect(retained?.statement).toBe('当前权威结论')
    expect(retained?.source_type).toBe('imported_candidate')
    expect(merged.entries.some((entry) => entry.decision_id === expired.id)).toBe(false)
    expect(merged.entries.some((entry) => entry.decision_id === revoked.id)).toBe(false)
    expect(merged.entries.some((entry) => entry.decision_id === superseded.id)).toBe(false)

    const again = mergeMemoryCandidates(merged.entries, live.entries)
    expect(again.entries.some((entry) => entry.decision_id === expired.id)).toBe(false)
    expect(again.entries.some((entry) => entry.decision_id === revoked.id)).toBe(false)
    expect(again.entries.some((entry) => entry.decision_id === superseded.id)).toBe(false)
    expect(again.removedDecisionIds).toEqual([])
  })

  it('检索严格过滤 project_id，文本相关候选可成为关键项', () => {
    const relevant = decision(71, {
      project_id: PROJECT_A,
      decision_key: 'report.language',
      statement: '项目报告使用中文。',
    })
    const otherA = decision(72, {
      project_id: PROJECT_A,
      decision_key: 'docs.layout',
      statement: '文档采用单栏布局。',
    })
    const otherB = decision(73, {
      project_id: PROJECT_B,
      decision_key: 'report.language',
      statement: '项目报告使用英文。',
    })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [relevant, otherA, otherB], NOW))

    const selected = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '报告',
      budget_entries: 8,
      budget_tokens: 100_000,
    })

    expect(selected.candidate_count).toBe(2)
    expect(selected.entries.every((entry) => entry.project_id === PROJECT_A)).toBe(true)
    expect(selected.entries.some((entry) => entry.decision_id === otherB.id)).toBe(false)
    expect(selected.entries[0]?.decision_id).toBe(relevant.id)
    expect(selected.entries[0]?.match_reason).toContain('文本命中')
  })

  it('exact decision_key 的关键项装不下时返回 escalation_reason', () => {
    const source = decision(81, {
      decision_key: 'deploy.approval',
      statement: `必须保留的约束：${'细节'.repeat(1000)}`,
    })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [source], NOW))
    const selected = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '',
      decision_key: 'deploy.approval',
      budget_entries: 8,
      budget_tokens: 1,
    })

    expect(selected.entries).toEqual([])
    expect(selected.candidate_count).toBe(1)
    expect(selected.omitted_count).toBe(1)
    expect(selected.used_tokens).toBe(0)
    expect(selected.escalation_reason).toContain('关键记忆超出预算')
  })

  it('非关键候选被省略时记录 omitted_count 与 expansion_reason', () => {
    const first = decision(91, { decision_key: 'memory.a', statement: '甲' })
    const second = decision(92, { decision_key: 'memory.b', statement: '乙' })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [first, second], NOW))
    const selected = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '',
      budget_entries: 1,
      budget_tokens: 100_000,
    })

    expect(selected.entries).toHaveLength(1)
    expect(selected.candidate_count).toBe(2)
    expect(selected.omitted_count).toBe(1)
    expect(selected.escalation_reason).toBeNull()
    expect(selected.expansion_reason).toContain('预算仅纳入 1/2 条候选')
  })

  it('scope 适用性沿用 selector 前缀语义，并要求资源非空且全部覆盖', () => {
    const docs = decision(101, {
      decision_key: 'memory.a',
      scope: {
        decision_kinds: ['preference'],
        actions: ['write_file'],
        resource_selectors: ['docs/*'],
        environments: ['local'],
        reversibilities: ['reversible'],
      },
    })
    const source = decision(102, {
      decision_key: 'memory.b',
      scope: {
        decision_kinds: ['preference'],
        actions: ['write_file'],
        resource_selectors: ['src/*'],
        environments: ['local'],
        reversibilities: ['reversible'],
      },
    })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [docs, source], NOW))

    const selected = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '',
      kind: 'preference',
      action_category: 'write_file',
      impact: {
        environment: 'local',
        reversibility: 'reversible',
        affected_resources: ['docs/report.md'],
      },
      budget_entries: 1,
      budget_tokens: 100_000,
    })
    expect(selected.entries[0]?.decision_id).toBe(docs.id)
    expect(selected.entries[0]?.applicable).toBe(true)
    expect(selected.entries[0]?.match_reason).toContain('作用域适用')

    const emptyResources = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '',
      impact: {
        environment: 'local',
        reversibility: 'reversible',
        affected_resources: [],
      },
      budget_entries: 8,
      budget_tokens: 100_000,
    })
    expect(emptyResources.entries.every((entry) => !entry.applicable)).toBe(true)
  })

  it('检索不改写 source_type', () => {
    const source = decision(111, { source_type: 'imported_candidate' })
    const content = mustValue(buildProjectMemoryContent(PROJECT_A, [source], NOW))
    const selected = selectProjectMemoryEntries(content.entries, {
      project_id: PROJECT_A,
      text: '',
      budget_entries: 8,
      budget_tokens: 100_000,
    })
    expect(selected.entries[0]?.source_type).toBe('imported_candidate')
  })
})
