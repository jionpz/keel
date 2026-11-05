/**
 * liveness 策略表与模式解析 —— 纯函数，不碰数据库。
 *
 * 钉住三件容易在改阈值时被破坏的事：
 *   - human 既不判沉默也没有硬上限（旧的 180s 不能漏回来）；
 *   - 无 CAP-STREAM 时只保留硬上限，不按沉默收割；
 *   - 显式 --wall-clock 覆盖 stage 上限，wallclock 模式保持旧全局 180s。
 */

import { describe, expect, it } from 'vitest'
import {
  HUMAN_POLICY,
  LEGACY_WALLCLOCK_S,
  LIVENESS_POLICY,
  livenessMode,
  policyFor,
  progressSourceOf,
  runWallClockS,
  withoutProgressSignal,
} from './policy.js'

describe('livenessMode', () => {
  it('未设置 / 空串 → 默认 progress', () => {
    expect(livenessMode({})).toBe('progress')
    expect(livenessMode({ KEEL_LIVENESS_MODE: '' })).toBe('progress')
  })

  it('两个合法值原样返回', () => {
    expect(livenessMode({ KEEL_LIVENESS_MODE: 'progress' })).toBe('progress')
    expect(livenessMode({ KEEL_LIVENESS_MODE: 'wallclock' })).toBe('wallclock')
  })

  it('非法值抛错并说明可选值，不静默回退', () => {
    expect(() => livenessMode({ KEEL_LIVENESS_MODE: 'sometimes' })).toThrow(
      /KEEL_LIVENESS_MODE=sometimes 非法.*progress \| wallclock/,
    )
  })
})

describe('policyFor', () => {
  it('有进展信号的 stage 使用策略表：develop 沉默 20m、硬上限 12h', () => {
    const p = policyFor({ stage: 'develop', isHuman: false, hasProgressSignal: true })
    expect(p.silenceMs).toBe(20 * 60_000)
    expect(p.hardCapS).toBe(12 * 60 * 60)
    expect(progressSourceOf(p)).toBe('stream')
  })

  it('其余 stage 的默认值集中在 LIVENESS_POLICY', () => {
    expect(LIVENESS_POLICY.pm).toEqual({ silenceMs: 5 * 60_000, hardCapS: 30 * 60 })
    expect(LIVENESS_POLICY.qa).toEqual({ silenceMs: 10 * 60_000, hardCapS: 2 * 3600 })
  })

  it('无 CAP-STREAM：progressSource → none，只保留硬上限', () => {
    const p = policyFor({ stage: 'develop', isHuman: false, hasProgressSignal: false })
    expect(p.silenceMs).toBeNull()
    expect(p.hardCapS).toBe(12 * 3600)
    expect(progressSourceOf(p)).toBe('none')
  })

  it('human：沉默禁用且 hardCapS 为 null —— 超过旧 180s 也不会被任何定时器带走', () => {
    const p = policyFor({ stage: 'develop', isHuman: true, hasProgressSignal: false })
    expect(p).toEqual(HUMAN_POLICY)
    expect(p.silenceMs).toBeNull()
    expect(p.hardCapS).toBeNull()
    expect(progressSourceOf(p)).toBe('none')
    // 运行期据此不创建 wall_clock timer
    expect(runWallClockS('progress', undefined, p)).toBe(0)
  })

  it('withoutProgressSignal 不改硬上限', () => {
    expect(withoutProgressSignal(LIVENESS_POLICY.pm)).toEqual({
      silenceMs: null,
      hardCapS: 30 * 60,
    })
  })
})

describe('runWallClockS 优先级', () => {
  const develop = LIVENESS_POLICY.develop

  it('未指定 --wall-clock：progress 模式使用 stage 硬上限（develop 12h）', () => {
    expect(runWallClockS('progress', undefined, develop)).toBe(12 * 3600)
  })

  it('未指定 --wall-clock：wallclock 模式保持旧的全局 180s', () => {
    expect(runWallClockS('wallclock', undefined, develop)).toBe(LEGACY_WALLCLOCK_S)
  })

  it('显式 --wall-clock 覆盖所有 stage 上限（两种模式都一样）', () => {
    expect(runWallClockS('progress', 600, develop)).toBe(600)
    expect(runWallClockS('wallclock', 600, develop)).toBe(600)
  })

  it('human 在 wallclock 模式下仍会被 180s 带走 —— 模式切换是显式选择', () => {
    // progress 模式 human 不挂 timer；wallclock 模式是整体退回旧行为，
    // 这里如实断言，避免把「human 豁免」误读成跨模式保证。
    expect(runWallClockS('progress', undefined, HUMAN_POLICY)).toBe(0)
    expect(runWallClockS('wallclock', undefined, HUMAN_POLICY)).toBe(180)
  })
})
