import { describe, expect, it } from 'vitest'
import { type RecoveryInput, selectRecovery } from './recovery-policy.js'

const input: RecoveryInput = {
  stage: 'verify',
  binding: { commit: 'head', packageDigest: 'package', workspace: 'workspace' },
  failure: { kind: 'unknown', fingerprint: 'checks', evidenceRef: 'attempt' },
  history: [],
  remaining: { observation: 1, infrastructure: 1, verification: 1, code: 3 },
}

describe('selectRecovery', () => {
  it.each([
    ['observation', 'observe', 'observation'],
    ['infrastructure', 'retry_stage', 'infrastructure'],
    ['environment', 'reverify', 'verification'],
    ['unknown', 'reverify', 'verification'],
    ['guard', 'rework', 'code'],
    ['permission', 'stop', null],
    ['protocol', 'stop', null],
  ] as const)('分类 %s 返回 %s', (kind, action, budget) => {
    expect(selectRecovery({ ...input, failure: { ...input.failure, kind } })).toMatchObject({
      action,
      budget,
      evidenceRef: 'attempt',
    })
  })

  it('同一绑定只重验一次，其他 SHA 独立计算', () => {
    const history: RecoveryInput['history'] = [
      { action: 'reverify', stage: input.stage, binding: input.binding, fingerprint: 'earlier' },
    ]
    expect(selectRecovery({ ...input, history })).toMatchObject({
      action: 'decide',
      reason: 'no_progress',
    })
    expect(
      selectRecovery({ ...input, binding: { ...input.binding, commit: 'different' }, history }),
    ).toMatchObject({ action: 'reverify' })
  })

  it('授权必须匹配当前证据且没有用完额度', () => {
    const authorization = {
      action: 'rework',
      stage: input.stage,
      binding: input.binding,
      fingerprint: input.failure.fingerprint,
      evidenceRef: input.failure.evidenceRef,
    } as const
    expect(selectRecovery({ ...input, authorization })).toMatchObject({ action: 'rework' })
    expect(
      selectRecovery({
        ...input,
        authorization: { ...authorization, evidenceRef: 'different' },
      }),
    ).toMatchObject({ action: 'reverify' })
    expect(
      selectRecovery({ ...input, authorization, remaining: { ...input.remaining, code: 0 } }),
    ).toMatchObject({ action: 'decide', reason: 'budget_exhausted' })
    expect(
      selectRecovery({
        ...input,
        authorization,
        failure: { ...input.failure, error: 'PERMISSION_DENIED' },
      }),
    ).toMatchObject({ action: 'stop', reason: 'permission_failure' })
    expect(
      selectRecovery({
        ...input,
        authorization,
        failure: { ...input.failure, kind: 'environment' },
      }),
    ).toMatchObject({ action: 'reverify' })
  })
})
