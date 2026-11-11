import { describe, expect, it } from 'vitest'
import type { JstackRoutePlan } from '../../generated/managed.js'
import {
  buildTicketPackageForNode,
  type RouteSize,
  routePackageDigest,
  validateRoutePackage,
  validateRoutePlan,
} from './route-protocol.js'
import { fixtureRoutePackage, fixtureRoutePlan } from './route-test-utils.js'
import { validateTicketPackage } from './ticket-protocol.js'

const SCOPE = ['src'] as const

function plan(routeSize: RouteSize, tickets: readonly Record<string, unknown>[]): JstackRoutePlan {
  return {
    schema_version: '1.0',
    route_size: routeSize,
    summary: 'fixture',
    tickets,
  } as unknown as JstackRoutePlan
}

function ticket(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    ticket_id: `JT-${key}`,
    title: `ticket ${key}`,
    size: 'S',
    depends_on: [],
    scope_paths: ['src/control'],
    acceptance: ['tests pass'],
    ...overrides,
  }
}

describe('managed route protocol', () => {
  it('accepts every route size with the declared ticket bounds', () => {
    const routePackage = fixtureRoutePackage()
    const cases: Array<[RouteSize, number]> = [
      ['XS', 1],
      ['S', 1],
      ['M', 3],
      ['L', 12],
      ['XL', 20],
    ]
    for (const [size, count] of cases) {
      const result = validateRoutePlan(fixtureRoutePlan(size, count), routePackage, SCOPE)
      expect(result.ok, `${size}: ${result.ok ? '' : result.error.detail}`).toBe(true)
    }
  })

  it('rejects a ticket count outside the route range', () => {
    const routePackage = fixtureRoutePackage()
    const result = validateRoutePlan(fixtureRoutePlan('M', 4), routePackage, SCOPE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toContain('需要 1..3 个 ticket')
  })

  it('rejects a ticket size larger than the route', () => {
    const routePackage = fixtureRoutePackage()
    const result = validateRoutePlan(plan('S', [ticket('a', { size: 'M' })]), routePackage, SCOPE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toContain('必须同为 S')
  })

  it('rejects missing and cyclic dependencies', () => {
    const routePackage = fixtureRoutePackage()
    const missing = validateRoutePlan(
      plan('L', [ticket('a', { depends_on: ['ghost'] }), ticket('b')]),
      routePackage,
      SCOPE,
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.detail).toContain('依赖不存在的 ghost')

    const cyclic = validateRoutePlan(
      plan('L', [ticket('a', { depends_on: ['b'] }), ticket('b', { depends_on: ['a'] })]),
      routePackage,
      SCOPE,
    )
    expect(cyclic.ok).toBe(false)
    if (!cyclic.ok) expect(cyclic.error.detail).toContain('循环')
  })

  it('rejects self dependency and duplicate keys, tickets, and issues', () => {
    const routePackage = fixtureRoutePackage()
    const self = validateRoutePlan(
      plan('L', [ticket('a', { depends_on: ['a'] }), ticket('b')]),
      routePackage,
      SCOPE,
    )
    expect(self.ok).toBe(false)
    if (!self.ok) expect(self.error.detail).toContain('不能依赖自身')

    const duplicateKey = validateRoutePlan(
      plan('L', [ticket('a'), ticket('a', { ticket_id: 'JT-other' })]),
      routePackage,
      SCOPE,
    )
    expect(duplicateKey.ok).toBe(false)

    const duplicateTicket = validateRoutePlan(
      plan('L', [ticket('a'), ticket('b', { ticket_id: 'JT-a' })]),
      routePackage,
      SCOPE,
    )
    expect(duplicateTicket.ok).toBe(false)

    const duplicateIssue = validateRoutePlan(
      plan('L', [ticket('a', { external_issue: '#1' }), ticket('b', { external_issue: '#1' })]),
      routePackage,
      SCOPE,
    )
    expect(duplicateIssue.ok).toBe(false)
  })

  it('rejects scope escapes and relative path tricks', () => {
    const routePackage = fixtureRoutePackage()
    for (const scope of ['../outside', '/etc/passwd', 'src/../outside', 'docs']) {
      const result = validateRoutePlan(
        plan('L', [ticket('a', { scope_paths: [scope] }), ticket('b')]),
        routePackage,
        SCOPE,
      )
      expect(result.ok, scope).toBe(false)
    }
  })

  it('rejects a graph without a root node', () => {
    const routePackage = fixtureRoutePackage()
    const result = validateRoutePlan(
      plan('L', [ticket('a', { depends_on: ['b'] }), ticket('b', { depends_on: ['a'] })]),
      routePackage,
      SCOPE,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.detail).toMatch(/循环|根节点/)
  })

  it('rejects forged route or source digests', () => {
    const routePackage = fixtureRoutePackage()
    const forgedRoute = { ...routePackage, archive_gate: 'tampered' }
    const badRoute = validateRoutePackage(forgedRoute)
    expect(badRoute.ok).toBe(false)
    if (!badRoute.ok) expect(badRoute.error.detail).toContain('content_digest')

    const forgedSource = structuredClone(routePackage)
    const firstStage = forgedSource.stage_templates[0]
    if (firstStage === undefined) throw new Error('缺少 stage template')
    firstStage.instructions = 'tampered instructions\n'
    const badSource = validateRoutePackage(forgedSource)
    expect(badSource.ok).toBe(false)

    expect(routePackageDigest(routePackage)).toBe(routePackage.content_digest)
  })

  it('builds a valid fixed ticket package for a graph node', () => {
    const routePackage = fixtureRoutePackage()
    const node = fixtureRoutePlan('M', 2).tickets[0]
    if (node === undefined) throw new Error('缺少 ticket fixture')
    const built = buildTicketPackageForNode(routePackage, node)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.ticket.id).toBe(node.ticket_id)
    expect(built.value.route.stages).toEqual(['execute', 'verify', 'review', 'land'])
    expect(validateTicketPackage(built.value).ok).toBe(true)
  })
})
