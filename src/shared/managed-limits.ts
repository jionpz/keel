/** managed 单次运行（阶段、路线规划、天问）的缺省墙钟上限。 */
export const MANAGED_STAGE_TIMEOUT_MS = 15 * 60_000
export const MANAGED_STAGE_CLEANUP_MS = 5_000

/**
 * 执行租约秒数 = 单次运行的最长墙钟 + 清理等待 + 60 秒余量。
 *
 * 租约必须比运行本身活得久：超时后还要中断 Harness、等它收敛，再用同一个
 * 租约把失败写回。租约先到期的话，这次失败就记不下来。阶段上限可以由部署
 * 配置调大，所以租约从实际上限派生，不能是独立的常量。
 */
export function managedExecutionLeaseSeconds(maxRunMs: number = MANAGED_STAGE_TIMEOUT_MS): number {
  return Math.ceil((maxRunMs + MANAGED_STAGE_CLEANUP_MS) / 1000) + 60
}
