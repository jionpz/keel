/**
 * timer 机制(issue #24,方案 A)。
 *
 * 定义处：docs/04-state-machine.md §6 / §5.2。
 *
 * v0.1 只接通 clarification TTL:T-005 启动,loop 空闲 claim 到期,
 * T-008 进 S-ABANDONED。
 *
 * 注意:**不提供 TIMER_DURATIONS.wall_clock** —— Run 墙钟超时的期限来源是
 * `RunSpec.limits.wall_clock_s`(harness 侧),不是这里的常量;本轮也不插入
 * kind='wall_clock' 行(方案 B 才需要)。
 */

export type TimerKind = 'clarification_ttl' | 'wall_clock'

/** 各 timer 的到期期限(毫秒)。时间由调用方注入 now + 期限,不读系统时钟 */
export const TIMER_DURATIONS = {
  /** clarification TTL:24h。文档 §6 从此前「待定」改为该默认值 */
  clarification_ttl: 24 * 3600 * 1000,
} as const
