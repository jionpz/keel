import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { SCHEMAS } from '../../generated/schemas.js'
import { promptFor } from '../orchestrator/prompts.js'

const validate = new Ajv2020({ strict: false }).compile(SCHEMAS.stage_outcome)
const base = { schema_version: '1.1', stage: 'pm', run_id: 'pm-run', reason: '需要核对需求' }

describe('PM 1.1 结构化结论', () => {
  it('新 unclear 必须给 1–5 个可回答的非空问题，旧事实仍可读取', () => {
    expect(validate({ ...base, verdict: 'unclear' })).toBe(false)
    for (const questions of [[], [' '], Array.from({ length: 6 }, () => '问题')]) {
      expect(validate({ ...base, verdict: 'unclear', questions })).toBe(false)
    }
    expect(validate({ ...base, verdict: 'unclear', questions: ['预期哪些值？'] })).toBe(true)
    expect(validate({ ...base, schema_version: '1.0', verdict: 'unclear' })).toBe(true)
  })

  it('重复与已修复拒收必须带证据，不能只输出一个判断', () => {
    for (const reject_kind of ['duplicate', 'already_fixed']) {
      expect(validate({ ...base, verdict: 'reject', reject_kind, evidence: [] })).toBe(false)
      expect(
        validate({
          ...base,
          verdict: 'reject',
          reject_kind,
          evidence: ['https://github.example.com/acme/widget/commit/abc123'],
        }),
      ).toBe(true)
    }
    expect(validate({ ...base, verdict: 'reject' })).toBe(false)
    expect(
      validate({ ...base, verdict: 'reject', reject_kind: 'out_of_scope', evidence: [] }),
    ).toBe(true)
  })

  it('提示词要求先查证，证据不足继续推进或提问', () => {
    const prompt = promptFor('pm', 'pm-run')
    expect(prompt).toContain('先核对 repo_signals')
    expect(prompt).toContain('证据不足时判 actionable')
    expect(prompt).toContain('1–5 条非空')
    expect(prompt).not.toContain('这是一个明确、范围很小的需求')
  })
})
