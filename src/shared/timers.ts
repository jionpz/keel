/**
 * timer 机制(issue #24,方案 A)。
 *
 * 定义处：docs/04-state-machine.md §6 / §5.2。
 *
 * 两条 Task 级 TTL：澄清(issue #24)与人工裁决(11-05-human-review-ttl)。
 * 收割路径相同：到期 → `TimerFired` → 对应转移的 `ConsumeTimer`。
 *
 * 注意:**不提供 TIMER_DURATIONS.wall_clock** —— Run 墙钟超时的期限来源是
 * `RunSpec.limits.wall_clock_s`(harness 侧),不是这里的常量;本轮也不插入
 * kind='wall_clock' 行(方案 B 才需要)。
 */

export type TimerKind = 'clarification_ttl' | 'human_review_ttl' | 'wall_clock'

/**
 * 出现在转移表里的 timer。
 *
 * `wall_clock` 属于 Run 级(R-009),由 loop / timer worker 直接管理,
 * 不经过 `StartTimer` / `CancelTimer` / `ConsumeTimer` 这三件套。
 */
export type TransitionTimerKind = Exclude<TimerKind, 'wall_clock'>

/** 人工裁决 TTL 的默认小时数 —— 与 TIMER_DURATIONS.human_review_ttl 同源 */
export const DEFAULT_HUMAN_REVIEW_TTL_H = 24

/** 各 timer 的到期期限(毫秒)。时间由调用方注入 now + 期限,不读系统时钟 */
export const TIMER_DURATIONS = {
  /** clarification TTL:24h。文档 §6 从此前「待定」改为该默认值 */
  clarification_ttl: 24 * 3600 * 1000,
  /** 人工裁决 TTL:24h。进程级可用 KEEL_HUMAN_REVIEW_TTL_H 覆盖或关闭 */
  human_review_ttl: DEFAULT_HUMAN_REVIEW_TTL_H * 3600 * 1000,
} as const

/**
 * `KEEL_HUMAN_REVIEW_TTL_H` 解析。**纯函数**:不读 process.env。
 *
 * | 入参 | 返回 | 含义 |
 * |---|---|---|
 * | `undefined` | `24` | 未设置 → 默认值 |
 * | 正整数 | 该小时数 | 覆盖 |
 * | `'0'` | `null` | 关闭调度(不插 timer 行,回到无限期等待) |
 * | 负数 / 非数字 / 空串 | throw | fail-closed,不静默回退默认值 |
 *
 * 返回 `null` 而不是 0,是为了让「关闭」与「0 小时后到期」在类型上不可混淆。
 */
export function parseHumanReviewTtlHours(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_HUMAN_REVIEW_TTL_H
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new Error(
      'KEEL_HUMAN_REVIEW_TTL_H 为空:省略即用默认 24 小时,0 表示关闭;空白不静默回退默认值',
    )
  }
  const hours = Number(trimmed)
  if (!Number.isInteger(hours) || hours < 0) {
    throw new Error(`KEEL_HUMAN_REVIEW_TTL_H=${raw} 非法:只接受非负整数小时(0 = 关闭调度)`)
  }
  return hours === 0 ? null : hours
}
