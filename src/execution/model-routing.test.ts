/**
 * 执行面模型路由 —— 纯函数，表驱动。
 *
 * 钉住四层优先级（R3）、非法 profile / allowlist 的拒绝（R6），
 * 以及「缺省模型只有一处字面量」（R4）。
 */

import { describe, expect, it } from 'vitest'
import { STAGES } from '../shared/ids.js'
import { DEFAULT_OMP_MODEL as OMP_DEFAULT } from './adapters/omp.js'
import {
  DEFAULT_OMP_MODEL,
  ENTERPRISE_STAGE_MODELS,
  parseAllowlist,
  parseProfile,
  preflightModelRouting,
  resolveStageModel,
} from './model-routing.js'

describe('DEFAULT_OMP_MODEL · 唯一事实源', () => {
  it('omp adapter re-export 的是同一个值（不允许第二份字面量）', () => {
    expect(OMP_DEFAULT).toBe(DEFAULT_OMP_MODEL)
    expect(DEFAULT_OMP_MODEL).toBe('deepseek-v4-flash')
  })
})

describe('ENTERPRISE_STAGE_MODELS · 阶段表', () => {
  it('覆盖全部 Stage，没有漏配的阶段', () => {
    for (const stage of STAGES) {
      expect(ENTERPRISE_STAGE_MODELS[stage], `缺少 stage=${stage}`).toMatch(/\S/)
    }
  })

  it('develop / qa / review → Kimi-K3', () => {
    for (const stage of ['develop', 'qa', 'review'] as const) {
      expect(ENTERPRISE_STAGE_MODELS[stage]).toBe('moonshotai/Kimi-K3')
    }
  })

  it('pm / brainstorm / critic / rfc_draft → GLM-5.3', () => {
    for (const stage of ['pm', 'brainstorm', 'critic', 'rfc_draft'] as const) {
      expect(ENTERPRISE_STAGE_MODELS[stage]).toBe('zai-org/GLM-5.3')
    }
  })
})

describe('parseProfile · KEEL_MODEL_PROFILE', () => {
  it('未设置 → default（不破坏既有基线）', () => {
    const r = parseProfile(undefined)
    expect(r.ok && r.value).toBe('default')
  })

  it('接受 default / enterprise，前后空白被裁掉', () => {
    expect(parseProfile(' default ')).toEqual({ ok: true, value: 'default' })
    expect(parseProfile('enterprise')).toEqual({ ok: true, value: 'enterprise' })
  })

  it('非法 / 空白 → CAPABILITY_UNSUPPORTED，消息点名变量与可选值', () => {
    for (const raw of ['enterprize', '', '   ', 'ENTERPRISE']) {
      const r = parseProfile(raw)
      expect(r.ok, `${JSON.stringify(raw)} 应被拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.retryable).toBe(false)
      expect(r.error.detail).toContain('KEEL_MODEL_PROFILE')
      expect(r.error.detail).toContain('default | enterprise')
    }
  })
})

describe('parseAllowlist · KEEL_MODEL_ALLOWLIST', () => {
  it('未设置 → 空清单（不校验）', () => {
    expect(parseAllowlist(undefined)).toEqual({ ok: true, value: [] })
  })

  it('逗号分隔，前后空白被裁掉', () => {
    const r = parseAllowlist(' moonshotai/Kimi-K3 , zai-org/GLM-5.3 ')
    expect(r.ok && r.value).toEqual(['moonshotai/Kimi-K3', 'zai-org/GLM-5.3'])
  })

  it('空项 / 全空白 → 拒绝，不静默跳过', () => {
    for (const raw of ['', 'a,,b', 'a,', ',a', '   ']) {
      const r = parseAllowlist(raw)
      expect(r.ok, `${JSON.stringify(raw)} 应被拒绝`).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
      expect(r.error.detail).toContain('KEEL_MODEL_ALLOWLIST')
    }
  })
})

describe('resolveStageModel · 优先级 override > profile 表 > 缺省', () => {
  it('default profile：所有阶段都是内置缺省 model', () => {
    for (const stage of STAGES) {
      const r = resolveStageModel({ stage, profile: 'default' })
      expect(r.ok && r.value, `stage=${stage}`).toBe(DEFAULT_OMP_MODEL)
    }
  })

  it('enterprise profile：各阶段按表', () => {
    for (const stage of STAGES) {
      const r = resolveStageModel({ stage, profile: 'enterprise' })
      expect(r.ok && r.value, `stage=${stage}`).toBe(ENTERPRISE_STAGE_MODELS[stage])
    }
  })

  it('override 最高优先级，且压过 enterprise 阶段表', () => {
    for (const profile of ['default', 'enterprise'] as const) {
      const r = resolveStageModel({ stage: 'develop', override: 'custom/model', profile })
      expect(r.ok && r.value).toBe('custom/model')
    }
  })

  it('override 前后空白被裁掉', () => {
    const r = resolveStageModel({ stage: 'pm', override: '  custom/model  ', profile: 'default' })
    expect(r.ok && r.value).toBe('custom/model')
  })

  it('空 override 拒绝，不静默回退 profile', () => {
    for (const override of ['', '   ']) {
      const r = resolveStageModel({ stage: 'pm', override, profile: 'enterprise' })
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    }
  })

  it('allowlist 命中 → 放行', () => {
    const r = resolveStageModel({
      stage: 'develop',
      profile: 'enterprise',
      allowlist: ['moonshotai/Kimi-K3'],
    })
    expect(r.ok && r.value).toBe('moonshotai/Kimi-K3')
  })

  it('allowlist 未命中 → CAPABILITY_UNSUPPORTED，点名最终值与清单', () => {
    const r = resolveStageModel({
      stage: 'develop',
      profile: 'default',
      allowlist: ['moonshotai/Kimi-K3'],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toContain(DEFAULT_OMP_MODEL)
    expect(r.error.detail).toContain('moonshotai/Kimi-K3')
    expect(r.error.detail).toContain('KEEL_MODEL_ALLOWLIST')
  })

  it('allowlist 也约束 override —— 显式模型同样不得越界', () => {
    const r = resolveStageModel({
      stage: 'develop',
      override: 'not/allowed',
      profile: 'default',
      allowlist: ['moonshotai/Kimi-K3'],
    })
    expect(r.ok).toBe(false)
  })

  it('空 allowlist = 不校验', () => {
    const r = resolveStageModel({ stage: 'pm', profile: 'default', allowlist: [] })
    expect(r.ok && r.value).toBe(DEFAULT_OMP_MODEL)
  })
})

describe('preflightModelRouting · 启动前就拒绝不可能的配置', () => {
  it('空 allowlist 不校验', () => {
    expect(preflightModelRouting({ harnessId: 'omp', profile: 'default', allowlist: [] })).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it('default profile：清单不含内置缺省 → 拒绝（哪怕只有 develop 会跑）', () => {
    const r = preflightModelRouting({
      harnessId: 'omp',
      profile: 'default',
      allowlist: ['moonshotai/Kimi-K3'],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toContain(DEFAULT_OMP_MODEL)
    expect(r.error.detail).toContain('KEEL_MODEL_ALLOWLIST')
  })

  it('enterprise profile：清单只覆盖一个阶段目录 → 拒绝', () => {
    const r = preflightModelRouting({
      harnessId: 'omp',
      profile: 'enterprise',
      allowlist: ['moonshotai/Kimi-K3'],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('zai-org/GLM-5.3')
  })

  it('enterprise profile：清单覆盖两个目录 → 放行', () => {
    const r = preflightModelRouting({
      harnessId: 'omp',
      profile: 'enterprise',
      allowlist: ['moonshotai/Kimi-K3', 'zai-org/GLM-5.3'],
    })
    expect(r.ok).toBe(true)
  })

  it('显式 override 压过 profile：清单只需覆盖 override', () => {
    const r = preflightModelRouting({
      harnessId: 'omp',
      profile: 'enterprise',
      override: 'custom/model',
      allowlist: ['custom/model'],
    })
    expect(r.ok).toBe(true)
  })

  it('显式 override 不在清单 → 拒绝，且不因 override 跳过校验', () => {
    const r = preflightModelRouting({
      harnessId: 'omp',
      profile: 'default',
      override: 'custom/model',
      allowlist: [DEFAULT_OMP_MODEL],
    })
    expect(r.ok).toBe(false)
  })

  it('claude 未指定模型：不按 profile 表校验（R7）', () => {
    const r = preflightModelRouting({
      harnessId: 'claude',
      profile: 'enterprise',
      allowlist: ['anything'],
    })
    expect(r.ok).toBe(true)
  })

  it('claude 显式模型同样受清单约束', () => {
    const r = preflightModelRouting({
      harnessId: 'claude',
      profile: 'default',
      override: 'claude-opus-4-6',
      allowlist: ['other'],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('claude-opus-4-6')
  })
})
