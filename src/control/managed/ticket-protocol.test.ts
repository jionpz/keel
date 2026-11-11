import { describe, expect, it } from 'vitest'
import { sha256Text } from '../../shared/canonical-json.js'
import {
  ticketPackageDigest,
  validateTicketPackage,
  validateTicketStageResult,
} from './ticket-protocol.js'
import { fixtureTicketPackage } from './ticket-test-utils.js'

describe('managed ticket protocol', () => {
  it('固定包摘要覆盖完整内容与来源清单', () => {
    const ticketPackage = fixtureTicketPackage()
    const validated = validateTicketPackage(ticketPackage)
    expect(validated.ok).toBe(true)
    expect(ticketPackageDigest(ticketPackage)).toBe(ticketPackage.content_digest)
    expect(ticketPackage.sources).toHaveLength(7)
    expect(ticketPackage.tool_policy.content_digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('阶段内容变化会改变包摘要', () => {
    const first = fixtureTicketPackage()
    const second = fixtureTicketPackage({ execute: 'changed execute instructions\n' })
    expect(first.content_digest).not.toBe(second.content_digest)
    expect(first.stages[0]?.content_digest).not.toBe(second.stages[0]?.content_digest)
  })

  it('可选 ticket 正文进入完整包摘要', () => {
    const withoutDescription = fixtureTicketPackage()
    const withDescription = fixtureTicketPackage({
      ticketDescription: '验收：新增文档，且只改 docs/agents。',
    })
    expect(validateTicketPackage(withDescription).ok).toBe(true)
    expect(withDescription.ticket.description).toBe('验收：新增文档，且只改 docs/agents。')
    expect(withDescription.content_digest).not.toBe(withoutDescription.content_digest)
  })

  it('拒绝阶段缺失、顺序不兼容和来源摘要不符', () => {
    const missing = fixtureTicketPackage()
    missing.stages.pop()
    expect(validateTicketPackage(missing).ok).toBe(false)

    const wrongOrder = fixtureTicketPackage()
    const stages = [...wrongOrder.stages]
    stages[0] = stages[1] as JstackTicketPackageStage
    stages[1] = wrongOrder.stages[0] as JstackTicketPackageStage
    wrongOrder.stages = stages as typeof wrongOrder.stages
    wrongOrder.content_digest = ticketPackageDigest(wrongOrder)
    expect(validateTicketPackage(wrongOrder).ok).toBe(false)

    const sourceMismatch = fixtureTicketPackage()
    const firstSource = sourceMismatch.sources[0]
    if (firstSource === undefined) throw new Error('missing source')
    sourceMismatch.sources[0] = {
      ...firstSource,
      sha256: sha256Text('different'),
    }
    sourceMismatch.content_digest = ticketPackageDigest(sourceMismatch)
    expect(validateTicketPackage(sourceMismatch).ok).toBe(false)
  })

  it('拒绝不存在的 tool profile 与摘要篡改', () => {
    const missingProfile = fixtureTicketPackage()
    const thirdStage = missingProfile.stages[2]
    if (thirdStage === undefined) throw new Error('missing stage')
    missingProfile.stages[2] = {
      ...thirdStage,
      tool_profile: 'missing-profile',
    }
    missingProfile.content_digest = ticketPackageDigest(missingProfile)
    expect(validateTicketPackage(missingProfile).ok).toBe(false)

    const tampered = fixtureTicketPackage()
    tampered.content_digest = sha256Text('tampered')
    expect(validateTicketPackage(tampered).ok).toBe(false)
  })

  it('阶段输出必须是受控结构化对象', () => {
    expect(
      validateTicketStageResult({
        schema_version: '1.0',
        stage: 'verify',
        status: 'completed',
        summary: 'tests passed',
        checks: [
          {
            command: 'pnpm test',
            exit_code: 0,
            passed: true,
            output_digest: sha256Text('ok'),
            output_excerpt: 'ok',
          },
        ],
        worktree_head: 'a'.repeat(40),
      }).ok,
    ).toBe(true)
    expect(
      validateTicketStageResult({
        schema_version: '1.0',
        stage: 'verify',
        status: 'completed',
        summary: 'claim only',
      }).ok,
    ).toBe(true)
  })
})

type JstackTicketPackageStage = ReturnType<typeof fixtureTicketPackage>['stages'][number]
