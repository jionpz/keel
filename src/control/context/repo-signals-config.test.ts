import { describe, expect, it } from 'vitest'
import { resolveRepoSignalsConfig } from './repo-signals-config.js'

describe('resolveRepoSignalsConfig', () => {
  it('缺省 14 天 / 1200 token', () => {
    expect(resolveRepoSignalsConfig({})).toEqual({
      ok: true,
      value: { sinceDays: 14, maxTokens: 1_200 },
    })
  })

  it('可分别配置窗口与上限', () => {
    expect(
      resolveRepoSignalsConfig({
        KEEL_REPO_SIGNALS_DAYS: '30',
        KEEL_REPO_SIGNALS_MAX_TOKENS: '800',
      }),
    ).toEqual({ ok: true, value: { sinceDays: 30, maxTokens: 800 } })
  })

  it.each([
    ['KEEL_REPO_SIGNALS_DAYS', '0'],
    ['KEEL_REPO_SIGNALS_DAYS', 'ten'],
    ['KEEL_REPO_SIGNALS_MAX_TOKENS', '99'],
    ['KEEL_REPO_SIGNALS_MAX_TOKENS', '  '],
  ])('%s=%s 非法 → 启动期拒绝，不静默回退', (name, raw) => {
    const r = resolveRepoSignalsConfig({ [name]: raw })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain(name)
  })
})
