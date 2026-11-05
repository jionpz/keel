/**
 * `KEEL_HUMAN_REVIEW_TTL_H` 纯函数解析测试。
 *
 * 这里不连库、不碰 env —— 解析规则本身就是「非法值不静默回退」的强制点。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_HUMAN_REVIEW_TTL_H, parseHumanReviewTtlHours, TIMER_DURATIONS } from './timers.js'

describe('parseHumanReviewTtlHours', () => {
  it('未设置 → 默认 24 小时', () => {
    expect(parseHumanReviewTtlHours(undefined)).toBe(24)
    expect(DEFAULT_HUMAN_REVIEW_TTL_H).toBe(24)
  })

  it("'0' → null（关闭调度，而不是「0 小时后到期」）", () => {
    expect(parseHumanReviewTtlHours('0')).toBeNull()
  })

  it('正整数 → 该小时数', () => {
    expect(parseHumanReviewTtlHours('48')).toBe(48)
    expect(parseHumanReviewTtlHours(' 2 ')).toBe(2)
  })

  it('负数 / 非数字 / 空串 / 小数 → 抛错（fail-closed，不静默回退默认值）', () => {
    for (const raw of ['-1', 'abc', '', '  ', '1.5', 'NaN']) {
      expect(() => parseHumanReviewTtlHours(raw), `raw=${JSON.stringify(raw)}`).toThrow(
        /KEEL_HUMAN_REVIEW_TTL_H/,
      )
    }
  })

  it('默认期限与小时数同源', () => {
    expect(TIMER_DURATIONS.human_review_ttl).toBe(DEFAULT_HUMAN_REVIEW_TTL_H * 3600 * 1000)
  })
})
