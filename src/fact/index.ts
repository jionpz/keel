/**
 * Fact Plane —— 唯一事实来源。
 *
 * 硬约束：只由 Control Plane 写入。Execution Plane 对本层无写权限，
 * 其产出必须走 Proposal 通道由 Control Plane 校验后代为落盘。
 * 见 docs/03-domain-model.md §4 写权限矩阵、不变量 I5。
 *
 * 代码层面由 .dependency-cruiser.cjs 的 execution-must-not-write-fact 规则强制；
 * 真正的强制在数据库授权（keel_execution 角色无写权限），属 v0.1 任务。
 *
 * v0.1 将在此实现 ArtifactStore 与 event log。
 */
export const PLANE = 'fact' as const
