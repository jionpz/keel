/**
 * 跨平面共享的标识符类型。
 *
 * 这些 ID 的**定义处在文档里**（docs/README.md「可寻址 ID」一节），
 * 本文件是它们在代码中的对应物。两者必须一致 ——
 * 状态集合的一致性由 scripts/check-transition-table.ts（约束 C4）检查。
 */

// ────────────────────────────── Task 级状态 ──────────────────────────────
// 定义处：docs/04-state-machine.md §1.1

/** 阶段态：有 Run 在跑 */
export const STAGE_STATUSES = [
  'S-PM_ANALYZING',
  'S-BRAINSTORM',
  'S-RFC_DRAFT',
  'S-DEVELOPING',
  'S-QA',
  'S-REVIEW',
] as const

/** 关口态：无 Run，等条件或等人 */
export const GATE_STATUSES = [
  'S-NEW',
  'S-NEED_CLARIFICATION',
  'S-RFC_READY',
  'S-HUMAN_REVIEW',
  'S-PR_OPEN',
] as const

/** 终态：无出边 */
export const TERMINAL_STATUSES = ['S-DONE', 'S-REJECTED', 'S-ABANDONED', 'S-FAILED'] as const

export const TASK_STATUSES = [...STAGE_STATUSES, ...GATE_STATUSES, ...TERMINAL_STATUSES] as const

export type StageStatus = (typeof STAGE_STATUSES)[number]
export type GateStatus = (typeof GATE_STATUSES)[number]
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]
export type TaskStatus = (typeof TASK_STATUSES)[number]

export function isTerminal(status: TaskStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

export function isStageStatus(status: TaskStatus): status is StageStatus {
  return (STAGE_STATUSES as readonly string[]).includes(status)
}

// ──────────────────────── control_mode（与状态正交）────────────────────────
// 定义处：docs/04-state-machine.md §3
//
// 它与 TaskStatus 是**两个独立维度**：status 说业务走到哪，control_mode 说谁在驾驶。
// 把暂停/接管做进状态链会让状态数翻倍。

export const CONTROL_MODES = ['auto', 'paused', 'human'] as const
export type ControlMode = (typeof CONTROL_MODES)[number]

// ────────────────────────────── Run 级状态 ──────────────────────────────
// 定义处：docs/04-state-machine.md §4.1

export const RUN_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

// ─────────────────────────────── Stage / Role ───────────────────────────────

export const STAGES = [
  'pm',
  'brainstorm',
  'critic',
  'rfc_draft',
  'develop',
  'qa',
  'review',
] as const
export type Stage = (typeof STAGES)[number]

/**
 * 角色约定(S2,issue #23):`run.role` 是**描述性字段**,DB 无 CHECK 是有意的 ——
 * 它记录「这个 run 由谁执行」,正确性由 effects.roleFor(stage) 保证,
 * 不参与授权或转移决策。ROLES 仅作类型约定,与 DB 无强制绑定。
 */
export const ROLES = [
  'PM',
  'Critic',
  'Developer',
  'QA',
  'Reviewer',
  'Architect',
  'Security',
] as const
export type RoleId = (typeof ROLES)[number]

// ───────────────────────────── Harness 能力 ─────────────────────────────
// 定义处：docs/05-contracts/harness-adapter.md §1.1

export const CAPABILITIES = [
  'CAP-HEADLESS',
  'CAP-UNTRUSTED_WORKSPACE',
  'CAP-STRUCTURED_OUTPUT',
  'CAP-RESUME',
  'CAP-STREAM',
  'CAP-COST',
  'CAP-PERMISSION',
  'CAP-INTERRUPT',
  'CAP-PROBE',
  'CAP-MODEL_OVERRIDE',
] as const
export type CapabilityId = (typeof CAPABILITIES)[number]

/** 能力级别。注意 CAP-UNTRUSTED_WORKSPACE 不在分级内 —— 它是准入条件而非档次 */
export const HARNESS_TIERS = ['L0', 'L1', 'L2'] as const
export type HarnessTier = (typeof HARNESS_TIERS)[number]

/** 各级别的必备能力（docs/05-contracts/harness-adapter.md §1.2，与 tierOf 一致） */
export const TIER_REQUIREMENTS: Readonly<Record<HarnessTier, readonly CapabilityId[]>> = {
  L0: ['CAP-HEADLESS'],
  L1: ['CAP-HEADLESS', 'CAP-RESUME'],
  L2: ['CAP-HEADLESS', 'CAP-RESUME', 'CAP-STREAM', 'CAP-COST'],
}

// ──────────────────────────── 转移 ID ────────────────────────────

/** Task 级转移 ID，形如 T-001 */
export type TransitionId = `T-${string}`
/** control_mode 转移 ID，形如 C-001 */
export type ControlTransitionId = `C-${string}`
/** Run 级转移 ID，形如 R-001 */
export type RunTransitionId = `R-${string}`

// ──────────────────────────── 产物引用 ────────────────────────────

/** 产物引用，形如 artifact:state@3 */
export type ArtifactRef = string
