import type { JstackRoutePackage, JstackRoutePlan } from '../../generated/managed.js'
import { sha256Text } from '../../shared/canonical-json.js'
import { type RouteSize, routePackageDigest } from './route-protocol.js'
import { fixtureToolPolicy, TICKET_PROVIDERS } from './ticket-test-utils.js'

const ROUTE_RULES: readonly {
  readonly size: RouteSize
  readonly min_tickets: number
  readonly max_tickets: number
  readonly description: string
}[] = [
  { size: 'XS', min_tickets: 1, max_tickets: 1, description: 'single tiny ticket' },
  { size: 'S', min_tickets: 1, max_tickets: 1, description: 'single small ticket' },
  { size: 'M', min_tickets: 1, max_tickets: 3, description: 'one to three tickets' },
  { size: 'L', min_tickets: 2, max_tickets: 12, description: 'dependency graph' },
  { size: 'XL', min_tickets: 2, max_tickets: 20, description: 'large dependency graph' },
]

export function fixtureRoutePackage(
  overrides: {
    readonly completionTarget?: 'branch_ready' | 'pr_ready'
    readonly archiveGate?: string
  } = {},
): JstackRoutePackage {
  const instructions = {
    route: '# route\n',
    stages: '# stages\n',
    plan: '# plan\n',
    must_stop: '# must stop\n',
  }
  const stageText: Record<string, string> = {
    execute: 'execute instructions\n',
    verify: 'verify instructions\n',
    review: 'review instructions\n',
    land: 'land instructions\n',
  }
  const stageTemplates = TICKET_PROVIDERS.map((provider) => ({
    stage: provider.stage,
    provider: provider.provider,
    provider_path: provider.provider_path,
    gate: `${provider.stage} gate`,
    tool_profile: {
      execute: 'developer',
      verify: 'verifier',
      review: 'reviewer',
      land: 'releaser',
    }[provider.stage] as string,
    instructions: stageText[provider.stage] ?? '',
    content_digest: sha256Text(stageText[provider.stage] ?? ''),
  })) as JstackRoutePackage['stage_templates']
  const sourceEntries: Array<[string, string]> = [
    ['src/flow/skills/route/SKILL.md', instructions.route],
    ['src/flow/skills/route/stages.md', instructions.stages],
    ['src/flow/skills/route/must-stop.md', instructions.must_stop],
    ['src/managed/plan.md', instructions.plan],
    ...TICKET_PROVIDERS.map((provider): [string, string] => [
      provider.provider_path,
      stageText[provider.stage] ?? '',
    ]),
  ]
  const routePackage = {
    protocol_version: '1.0' as const,
    workflow_id: 'jstack' as const,
    mode: 'route' as const,
    source_commit: 'fixture',
    completion_target: overrides.completionTarget ?? ('pr_ready' as const),
    route_rules: ROUTE_RULES.map((rule) => ({
      ...rule,
      stage_path: ['execute', 'verify', 'review', 'land'],
    })) as JstackRoutePackage['route_rules'],
    stage_templates: stageTemplates,
    instructions,
    tool_policy: fixtureToolPolicy(),
    must_stop: {
      content: instructions.must_stop,
      actions: [{ action: 'sudo', hook: 'sudo' }] as JstackRoutePackage['must_stop']['actions'],
      content_digest: sha256Text(instructions.must_stop),
    },
    archive_gate: overrides.archiveGate ?? 'archive requires all stage evidence',
    sources: sourceEntries.map(([path, content]) => ({
      path,
      sha256: sha256Text(content),
      bytes: Buffer.byteLength(content),
    })),
  }
  return {
    ...routePackage,
    content_digest: routePackageDigest({
      ...routePackage,
      content_digest: '',
    } as unknown as JstackRoutePackage),
  } as unknown as JstackRoutePackage
}

export function fixtureRoutePlan(routeSize: RouteSize, ticketCount: number): JstackRoutePlan {
  const ticketSize = routeSize === 'XS' || routeSize === 'S' ? routeSize : 'S'
  const tickets = Array.from({ length: ticketCount }, (_, index) => ({
    key: `ticket-${index + 1}`,
    ticket_id: `JT-TEST-${index + 1}`,
    title: `ticket ${index + 1}`,
    size: ticketSize,
    depends_on: index === 0 ? [] : [`ticket-${index}`],
    scope_paths: ['src'],
    acceptance: ['tests pass'],
  }))
  return {
    schema_version: '1.0',
    route_size: routeSize,
    summary: 'fixture route plan',
    tickets,
  } as unknown as JstackRoutePlan
}
