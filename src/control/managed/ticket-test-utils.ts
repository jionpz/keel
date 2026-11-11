import { readFileSync } from 'node:fs'
import type { ToolPolicyDocument } from '../../execution/tool-policy.js'
import type { JstackTicketPackage } from '../../generated/managed.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'
import { ticketPackageDigest } from './ticket-protocol.js'

interface RawToolPolicy {
  readonly protocol_version: '1.0'
  readonly stages: Readonly<Record<string, string>>
  readonly profiles: Readonly<Record<string, unknown>>
  readonly harnesses: Readonly<Record<string, unknown>>
}

export const TICKET_PROVIDERS = [
  {
    stage: 'execute',
    provider: 'flow:execute',
    provider_path: 'src/flow/skills/execute/SKILL.md',
  },
  {
    stage: 'verify',
    provider: 'pstack:principle-prove-it-works',
    provider_path: 'plugins/pstack/skills/principle-prove-it-works/SKILL.md',
  },
  {
    stage: 'review',
    provider: 'flow:review',
    provider_path: 'src/flow/skills/review/SKILL.md',
  },
  {
    stage: 'land',
    provider: 'pstack:poteto-mode/playbooks/opening-a-pr.md',
    provider_path: 'plugins/pstack/skills/poteto-mode/playbooks/opening-a-pr.md',
  },
] as const

export function fixtureToolPolicy(): ToolPolicyDocument {
  const raw = JSON.parse(
    readFileSync(new URL('../../../config/jstack-tools.json', import.meta.url), 'utf8'),
  ) as RawToolPolicy
  const policy = {
    protocol_version: '1.0' as const,
    source_commit: 'fixture',
    stages: raw.stages,
    profiles: raw.profiles,
    harnesses: raw.harnesses,
  }
  return {
    ...policy,
    content_digest: sha256CanonicalJson(policy),
  } as ToolPolicyDocument
}

export function fixtureTicketPackage(
  overrides: {
    ticketId?: string
    ticketTitle?: string
    execute?: string
    verify?: string
    review?: string
    land?: string
  } = {},
): JstackTicketPackage {
  const instructions = {
    route: '# route\n',
    stages: '# stages\n',
    must_stop: '# must stop\n',
  }
  const stageText: Record<string, string> = {
    execute: overrides.execute ?? 'execute instructions\n',
    verify: overrides.verify ?? 'verify instructions\n',
    review: overrides.review ?? 'review instructions\n',
    land: overrides.land ?? 'land instructions\n',
  }
  const stages = TICKET_PROVIDERS.map((provider) => ({
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
  })) as JstackTicketPackage['stages']
  const sourceEntries: Array<[string, string]> = [
    ['src/flow/skills/route/SKILL.md', instructions.route],
    ['src/flow/skills/route/stages.md', instructions.stages],
    ['src/flow/skills/route/must-stop.md', instructions.must_stop],
    ...TICKET_PROVIDERS.map((provider): [string, string] => [
      provider.provider_path,
      stageText[provider.stage] ?? '',
    ]),
  ]
  const sources = sourceEntries.map(([path, content]) => ({
    path,
    sha256: sha256Text(content),
    bytes: Buffer.byteLength(content),
  }))
  const ticketPackage = {
    protocol_version: '1.0' as const,
    workflow_id: 'jstack' as const,
    mode: 'ticket' as const,
    source_commit: 'fixture',
    ticket: {
      id: overrides.ticketId ?? 'JT-TEST',
      title: overrides.ticketTitle ?? 'fixture ticket',
    },
    route: {
      size: 'S' as const,
      stages: ['execute', 'verify', 'review', 'land'] as JstackTicketPackage['route']['stages'],
    },
    stages,
    instructions,
    tool_policy: fixtureToolPolicy(),
    must_stop: {
      content: instructions.must_stop,
      actions: [{ action: 'sudo', hook: 'sudo' }] as JstackTicketPackage['must_stop']['actions'],
      content_digest: sha256Text(instructions.must_stop),
    },
    completion_target: 'branch_ready' as const,
    sources,
  }
  const digest = ticketPackageDigest({
    ...ticketPackage,
    content_digest: '',
  } as unknown as JstackTicketPackage)
  return {
    ...ticketPackage,
    content_digest: digest,
  } as unknown as JstackTicketPackage
}
