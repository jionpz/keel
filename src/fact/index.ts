/**
 * Fact Plane —— 唯一事实来源。
 *
 * 硬约束：只由 Control Plane 写入。Execution Plane 对本层无写权限，
 * 其产出必须走 Proposal 通道由 Control Plane 校验后代为落盘。
 * 见 docs/03-domain-model.md §4 写权限矩阵、不变量 I5。
 *
 * 代码层面由 .dependency-cruiser.cjs 的 execution-must-not-write-fact 规则强制；
 * 数据库层面由 GRANT 强制（migrations/1000000000000_initial-schema.sql：
 * keel_execution 对 artifact / event / feedback / task 一律无权限,
 * 写 artifact 的唯一通道 keel_commit_artifact 也只授 keel_control ——
 * 反例固化在 src/fact/invariants.test.ts）。
 *
 * blob 大 body 落库见 src/fact/blob.ts（ADR-0004,256 KB 阈值）。
 */
export const PLANE = 'fact' as const
