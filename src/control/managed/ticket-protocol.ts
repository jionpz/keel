import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { parseToolPolicy, type ToolPolicyDocument } from '../../execution/tool-policy.js'
import type { JstackTicketPackage, ManagedTicketStageResult } from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'

export const TICKET_STAGE_ORDER = ['execute', 'verify', 'review', 'land'] as const

const ajv = new Ajv2020({ allErrors: true })
const packageValidator = ajv.compile<JstackTicketPackage>(MANAGED_SCHEMAS.ticket_package)
const stageResultValidator = ajv.compile<ManagedTicketStageResult>(
  MANAGED_SCHEMAS.ticket_stage_result,
)

export interface ValidatedTicketPackage {
  readonly package: JstackTicketPackage
  readonly toolPolicy: ToolPolicyDocument
}

export function ticketPackageDigest(value: JstackTicketPackage): string {
  const { content_digest: ignored, ...body } = value
  void ignored
  return sha256CanonicalJson(body)
}

function findDigest(
  sources: JstackTicketPackage['sources'],
  path: string,
): JstackTicketPackage['sources'][number] | undefined {
  return sources.find((source) => source.path === path)
}

export function validateTicketPackage(value: unknown): Result<ValidatedTicketPackage> {
  if (!packageValidator(value)) {
    return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(packageValidator.errors)))
  }
  const ticketPackage = value
  if (ticketPackageDigest(ticketPackage) !== ticketPackage.content_digest) {
    return err(makeError('SCHEMA_VIOLATION', 'ticket package content_digest 不一致'))
  }
  if (ticketPackage.route.stages.join(',') !== TICKET_STAGE_ORDER.join(',')) {
    return err(
      makeError('SCHEMA_VIOLATION', 'ticket route 阶段顺序必须是 execute→verify→review→land'),
    )
  }
  if (ticketPackage.stages.map((stage) => stage.stage).join(',') !== TICKET_STAGE_ORDER.join(',')) {
    return err(makeError('SCHEMA_VIOLATION', 'ticket stages 缺失、重复或顺序不兼容'))
  }
  if (ticketPackage.must_stop.content_digest !== sha256Text(ticketPackage.must_stop.content)) {
    return err(makeError('SCHEMA_VIOLATION', 'must-stop content_digest 不一致'))
  }
  if (ticketPackage.instructions.must_stop !== ticketPackage.must_stop.content) {
    return err(makeError('SCHEMA_VIOLATION', 'instructions.must_stop 与 must_stop.content 不一致'))
  }

  const policy = parseToolPolicy(ticketPackage.tool_policy)
  if (!policy.ok) return policy
  for (const stage of ticketPackage.stages) {
    if (stage.content_digest !== sha256Text(stage.instructions)) {
      return err(makeError('SCHEMA_VIOLATION', `阶段 ${stage.stage} 的内容摘要不一致`))
    }
    if (policy.value.stages[stage.stage] !== stage.tool_profile) {
      return err(
        makeError('SCHEMA_VIOLATION', `阶段 ${stage.stage} 的 tool profile 与 tool_policy 不一致`),
      )
    }
    const source = findDigest(ticketPackage.sources, stage.provider_path)
    if (source === undefined || source.sha256 !== stage.content_digest) {
      return err(makeError('SCHEMA_VIOLATION', `阶段 ${stage.stage} 缺少绑定的 provider 来源摘要`))
    }
  }
  const sourceChecks = [
    ['src/flow/skills/route/SKILL.md', ticketPackage.instructions.route],
    ['src/flow/skills/route/stages.md', ticketPackage.instructions.stages],
    ['src/flow/skills/route/must-stop.md', ticketPackage.instructions.must_stop],
  ] as const
  for (const [path, content] of sourceChecks) {
    const source = findDigest(ticketPackage.sources, path)
    if (source === undefined || source.sha256 !== sha256Text(content)) {
      return err(makeError('SCHEMA_VIOLATION', `固定来源 ${path} 的摘要不一致`))
    }
  }
  if (
    new Set(ticketPackage.sources.map((source) => source.path)).size !==
    ticketPackage.sources.length
  ) {
    return err(makeError('SCHEMA_VIOLATION', 'sources 路径重复'))
  }
  return ok({ package: ticketPackage, toolPolicy: policy.value })
}

export function validateTicketStageResult(value: unknown): Result<ManagedTicketStageResult> {
  return stageResultValidator(value)
    ? ok(value)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(stageResultValidator.errors)))
}

export function ticketStageIndex(stage: string): number {
  return TICKET_STAGE_ORDER.indexOf(stage as (typeof TICKET_STAGE_ORDER)[number])
}

export function ticketStageAt(index: number): (typeof TICKET_STAGE_ORDER)[number] | null {
  return TICKET_STAGE_ORDER[index] ?? null
}

export { canonicalJson } from '../../shared/canonical-json.js'
