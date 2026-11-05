/**
 * CLI 侧的 TTL 解析：把纯函数抛出的异常翻译成 Result，
 * 让四个入口用同一种方式在任何数据库动作之前失败。
 */

import { describe, expect, it } from 'vitest'
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'

const HOUR_MS = 3600 * 1000

describe('resolveHumanReviewTtlMs', () => {
  it('未设置 → 默认 24h 毫秒值', () => {
    expect(resolveHumanReviewTtlMs(undefined)).toEqual({ ok: true, value: 24 * HOUR_MS })
  })

  it("'0' → ok(null)（关闭，不是 0ms）", () => {
    expect(resolveHumanReviewTtlMs('0')).toEqual({ ok: true, value: null })
  })

  it("'2' → 2 小时的毫秒值", () => {
    expect(resolveHumanReviewTtlMs('2')).toEqual({ ok: true, value: 2 * HOUR_MS })
  })

  it.each(['abc', '-1', '', '1.5'])('非法值 %j → CAPABILITY_UNSUPPORTED 且点名变量', (raw) => {
    const r = resolveHumanReviewTtlMs(raw)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toContain('KEEL_HUMAN_REVIEW_TTL_H')
    expect(r.error.detail).toContain(raw === '' ? '为空' : raw)
  })
})
