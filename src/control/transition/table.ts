/**
 * Task 级转移表。
 *
 * ⚠️ 本表与 docs/04-state-machine.md §2 的 markdown 表格必须保持一致。
 *    一致性由 scripts/check-transition-table.ts（约束 C4）在 CI 中检查。
 *    改动任一侧后，另一侧必须同步 —— 否则 CI 会红。
 *
 * 表中不含 control_mode 转移（C-*）与 Run 级转移（R-*），它们各有自己的表。
 */

import type { Stage } from '../../shared/ids.js'
import type { SideEffect, TransitionFacts, TransitionRule } from './types.js'

/** 便捷构造：创建某阶段的首个 Run */
const firstRun = (stage: Stage): SideEffect => ({ kind: 'CreateRun', stage, attempt: 'first' })

/** 便捷构造：创建某阶段的下一次 Run */
const nextRun = (stage: Stage | 'SAME'): SideEffect => ({
  kind: 'CreateRun',
  stage,
  attempt: 'next',
})

const devUnderLimit = (f: TransitionFacts) => f.dev_attempts < f.max_dev_attempts
const devAtLimit = (f: TransitionFacts) => f.dev_attempts >= f.max_dev_attempts

export const TASK_TRANSITIONS: readonly TransitionRule[] = [
  // ── 进入 ──
  {
    id: 'T-001',
    from: null,
    on: ['FeedbackTriaged'],
    guard: null,
    guardText: '—',
    to: 'S-NEW',
    effects: [{ kind: 'CreateTask' }, { kind: 'LinkFeedback' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-002',
    from: 'S-NEW',
    on: ['Dispatch'],
    guard: null,
    guardText: '—',
    to: 'S-PM_ANALYZING',
    effects: [firstRun('pm')],
    ignoresControlMode: false,
  },

  // ── PM 判定 ──
  {
    id: 'T-003',
    from: 'S-PM_ANALYZING',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'actionable' && f.needs_design,
    guardText: 'verdict=actionable ∧ needs_design',
    to: 'S-BRAINSTORM',
    effects: [firstRun('brainstorm')],
    ignoresControlMode: false,
  },
  {
    id: 'T-004',
    from: 'S-PM_ANALYZING',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'actionable' && !f.needs_design,
    guardText: 'verdict=actionable ∧ ¬needs_design',
    to: 'S-RFC_DRAFT',
    effects: [firstRun('rfc_draft')],
    ignoresControlMode: false,
  },
  {
    id: 'T-005',
    from: 'S-PM_ANALYZING',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'unclear',
    guardText: 'verdict=unclear',
    to: 'S-NEED_CLARIFICATION',
    effects: [{ kind: 'AskUser' }, { kind: 'StartTimer', timer: 'clarification_ttl' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-006',
    from: 'S-PM_ANALYZING',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'reject',
    guardText: 'verdict=reject',
    to: 'S-REJECTED',
    effects: [{ kind: 'RecordReason' }],
    ignoresControlMode: false,
  },

  // ── 澄清 ──
  {
    id: 'T-007',
    from: 'S-NEED_CLARIFICATION',
    on: ['ClarificationReceived'],
    guard: null,
    guardText: '—',
    to: 'S-PM_ANALYZING',
    effects: [{ kind: 'LinkFeedback' }, nextRun('pm')],
    ignoresControlMode: false,
  },
  {
    id: 'T-008',
    from: 'S-NEED_CLARIFICATION',
    on: ['TimerFired'],
    guard: null,
    guardText: '—',
    to: 'S-ABANDONED',
    effects: [],
    ignoresControlMode: false,
  },

  // ── Brainstorm ──
  {
    id: 'T-009',
    from: 'S-BRAINSTORM',
    on: ['CapabilityRequested'],
    guard: (f) => f.capability_allowed,
    guardText: 'policy=allow',
    to: 'SELF',
    // guard 现场求值 Policy 决定放行;通过后仍落一条可重放的裁决记录,
    // 与本轮 guard 的输入一致(同 policy、同 facts、同 now)
    effects: [{ kind: 'EvaluatePolicy', point: 'capability_request' }, nextRun('critic')],
    ignoresControlMode: false,
  },
  {
    id: 'T-010',
    from: 'S-BRAINSTORM',
    on: ['RunSucceeded'],
    // 只有 brainstorm 自身的收敛产物才进 RFC_DRAFT;
    // critic run 的完成走 T-009b(评审回灌,不推进状态)
    guard: (_f, e) => e.type === 'RunSucceeded' && e.stage === 'brainstorm',
    guardText: 'stage=brainstorm',
    to: 'S-RFC_DRAFT',
    effects: [firstRun('rfc_draft')],
    ignoresControlMode: false,
  },
  {
    // critic run 完成:评审已落库(A-CriticReview),
    // 重新派发 brainstorm(n+1) —— 新 run 的 Context 自带评审(recipe 的 critic section),
    // 下一轮收敛后再走 T-010。
    // 回流 = rematerialize 语义(ADR-0003 仍 Proposed,不实现 session resume)
    id: 'T-009b',
    from: 'S-BRAINSTORM',
    on: ['RunSucceeded'],
    guard: (_f, e) => e.type === 'RunSucceeded' && e.stage === 'critic',
    guardText: 'stage=critic',
    to: 'SELF',
    effects: [nextRun('brainstorm')],
    ignoresControlMode: false,
  },

  // ── RFC ──
  {
    id: 'T-011',
    from: 'S-RFC_DRAFT',
    on: ['ArtifactCommitted'],
    guard: null,
    guardText: '—',
    to: 'S-RFC_READY',
    effects: [{ kind: 'FreezeRfc' }, { kind: 'EvaluatePolicy', point: 'rfc_ready' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-012',
    from: 'S-RFC_READY',
    on: ['PolicyEvaluated'],
    guard: (_f, e) => e.type === 'PolicyEvaluated' && e.decision === 'auto_develop',
    guardText: 'decision=auto_develop',
    to: 'S-DEVELOPING',
    effects: [{ kind: 'CreateBranch' }, firstRun('develop')],
    ignoresControlMode: false,
  },
  {
    id: 'T-013',
    from: 'S-RFC_READY',
    on: ['PolicyEvaluated'],
    guard: (_f, e) => e.type === 'PolicyEvaluated' && e.decision !== 'auto_develop',
    guardText: 'decision != auto_develop',
    to: 'S-HUMAN_REVIEW',
    effects: [{ kind: 'NotifyHuman', reason: 'policy_requires_review' }],
    ignoresControlMode: false,
  },

  // ── 人工裁决 ──
  {
    id: 'T-014',
    from: 'S-HUMAN_REVIEW',
    on: ['HumanApproved'],
    guard: null,
    guardText: '—',
    to: 'S-DEVELOPING',
    effects: [{ kind: 'CreateBranch' }, nextRun('develop')],
    ignoresControlMode: false,
  },
  {
    id: 'T-015',
    from: 'S-HUMAN_REVIEW',
    on: ['HumanRejected'],
    guard: null,
    guardText: '—',
    to: 'S-REJECTED',
    effects: [],
    ignoresControlMode: false,
  },
  {
    id: 'T-016',
    from: 'S-HUMAN_REVIEW',
    on: ['HumanRequestedRework'],
    guard: null,
    guardText: '—',
    to: 'S-BRAINSTORM',
    effects: [nextRun('brainstorm')],
    ignoresControlMode: false,
  },

  // ── 开发 → QA → 评审 ──
  {
    id: 'T-017',
    from: 'S-DEVELOPING',
    on: ['RunSucceeded'],
    guard: null,
    guardText: '—',
    to: 'S-QA',
    effects: [firstRun('qa')],
    ignoresControlMode: false,
  },
  {
    id: 'T-018',
    from: 'S-QA',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'pass',
    guardText: 'qa_verdict=pass',
    to: 'S-REVIEW',
    effects: [firstRun('review')],
    ignoresControlMode: false,
  },
  {
    id: 'T-019',
    from: 'S-QA',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'fail' && devUnderLimit(f),
    guardText: 'qa_verdict=fail ∧ dev_attempts < max',
    to: 'S-DEVELOPING',
    effects: [nextRun('develop')],
    ignoresControlMode: false,
  },
  {
    id: 'T-020',
    from: 'S-QA',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'fail' && devAtLimit(f),
    guardText: 'qa_verdict=fail ∧ dev_attempts ≥ max',
    to: 'S-HUMAN_REVIEW',
    effects: [{ kind: 'NotifyHuman', reason: 'qa_retries_exhausted' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-021',
    from: 'S-REVIEW',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'pass',
    guardText: 'review_verdict=pass',
    to: 'S-PR_OPEN',
    effects: [{ kind: 'CreatePullRequest' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-022',
    from: 'S-REVIEW',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'fail' && devUnderLimit(f),
    guardText: 'review_verdict=fail ∧ dev_attempts < max',
    to: 'S-DEVELOPING',
    effects: [nextRun('develop')],
    ignoresControlMode: false,
  },
  {
    id: 'T-023',
    from: 'S-REVIEW',
    on: ['RunSucceeded'],
    guard: (f) => f.verdict === 'fail' && devAtLimit(f),
    guardText: 'review_verdict=fail ∧ dev_attempts ≥ max',
    to: 'S-HUMAN_REVIEW',
    effects: [{ kind: 'NotifyHuman', reason: 'review_retries_exhausted' }],
    ignoresControlMode: false,
  },

  // ── PR / CI ──
  {
    id: 'T-024',
    from: 'S-PR_OPEN',
    on: ['CIPassed'],
    guard: null,
    guardText: '—',
    to: 'S-DONE',
    effects: [{ kind: 'MaybeAutoMerge' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-025',
    from: 'S-PR_OPEN',
    on: ['CIFailed'],
    guard: devUnderLimit,
    guardText: 'dev_attempts < max',
    to: 'S-DEVELOPING',
    effects: [nextRun('develop')],
    ignoresControlMode: false,
  },
  {
    id: 'T-026',
    from: 'S-PR_OPEN',
    on: ['CIFailed'],
    guard: devAtLimit,
    guardText: 'dev_attempts ≥ max',
    to: 'S-HUMAN_REVIEW',
    effects: [{ kind: 'NotifyHuman', reason: 'ci_retries_exhausted' }],
    ignoresControlMode: false,
  },
  {
    id: 'T-027',
    from: 'S-PR_OPEN',
    on: ['PRClosed'],
    guard: null,
    guardText: '—',
    to: 'S-ABANDONED',
    effects: [{ kind: 'CleanWorkspace' }],
    ignoresControlMode: false,
  },

  // ── 通用规则：全部阶段态 ──
  // 避免为每个阶段重复写六遍失败分支
  {
    id: 'T-030',
    from: 'ANY_STAGE',
    on: ['RunFailed', 'RunTimeout'],
    guard: (f) => f.stage_attempts < f.max_stage_attempts,
    guardText: 'attempt < max_attempts(stage)',
    to: 'SELF',
    effects: [nextRun('SAME')],
    ignoresControlMode: false,
  },
  {
    id: 'T-031',
    from: 'ANY_STAGE',
    on: ['RunFailed', 'RunTimeout'],
    guard: (f) => f.stage_attempts >= f.max_stage_attempts,
    guardText: 'attempt ≥ max_attempts(stage)',
    to: 'S-HUMAN_REVIEW',
    effects: [{ kind: 'NotifyHuman', reason: 'stage_retries_exhausted' }],
    ignoresControlMode: false,
  },

  // ── 通用规则：全部非终态。无视 control_mode ──
  {
    id: 'T-040',
    from: 'ANY_NON_TERMINAL',
    on: ['Cancelled'],
    guard: null,
    guardText: '—',
    to: 'S-ABANDONED',
    effects: [{ kind: 'CancelRun' }, { kind: 'CleanWorkspace' }],
    ignoresControlMode: true,
  },
  {
    id: 'T-041',
    from: 'ANY_NON_TERMINAL',
    on: ['UnrecoverableError'],
    guard: null,
    guardText: '—',
    to: 'S-FAILED',
    effects: [{ kind: 'PreserveWorkspace' }],
    ignoresControlMode: true,
  },
]
