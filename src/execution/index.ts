/**
 * Execution Plane —— 干活的地方，产生非确定性结果。
 *
 * 硬约束：绝不直接写 Fact Plane，只能 emit Proposal。
 * 读取也不直接进行 —— 它看到的一切都经由 Context Builder 构造。
 * 见 docs/02-glossary.md §1 三平面、docs/05-contracts/session-manager.md §3。
 *
 * v0.1 将在此实现 SessionManager 与各 HarnessAdapter。
 */
export const PLANE = 'execution' as const
