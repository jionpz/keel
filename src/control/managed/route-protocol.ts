import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { parseToolPolicy, type ToolPolicyDocument } from '../../execution/tool-policy.js'
import type {
  JstackRoutePackage,
  JstackRoutePlan,
  JstackTicketPackage,
} from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'
import {
  TICKET_STAGE_ORDER,
  ticketPackageDigest,
  validateTicketPackage,
} from './ticket-protocol.js'

const ajv = new Ajv2020({ allErrors: true })
const routePackageValidator = ajv.compile<JstackRoutePackage>(MANAGED_SCHEMAS.route_package)
const routePlanValidator = ajv.compile<JstackRoutePlan>(MANAGED_SCHEMAS.route_plan)

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL'] as const
const PER_TICKET_SIZES = new Set(['XS', 'S', 'M'])

export interface ValidatedRoutePackage {
  readonly package: JstackRoutePackage
  readonly toolPolicy: ToolPolicyDocument
}

export type RouteSize = (typeof SIZE_ORDER)[number]

export interface ValidatedRoutePlan {
  readonly plan: JstackRoutePlan
  readonly digest: string
}

export function routePackageDigest(value: JstackRoutePackage): string {
  const { content_digest: ignored, ...body } = value
  void ignored
  return sha256CanonicalJson(body)
}

export function routePlanDigest(value: JstackRoutePlan): string {
  return sha256CanonicalJson(value)
}

function sourceFor(
  sources: JstackRoutePackage['sources'],
  path: string,
): JstackRoutePackage['sources'][number] | undefined {
  return sources.find((source) => source.path === path)
}

function validateRouteRules(rules: JstackRoutePackage['route_rules']): Result<true> {
  const seen = new Set<string>()
  for (const rule of rules) {
    if (seen.has(rule.size))
      return err(makeError('SCHEMA_VIOLATION', `route 规模重复：${rule.size}`))
    seen.add(rule.size)
    if (rule.min_tickets > rule.max_tickets) {
      return err(
        makeError('SCHEMA_VIOLATION', `route ${rule.size} 的 min_tickets 大于 max_tickets`),
      )
    }
    if (rule.stage_path.join(',') !== TICKET_STAGE_ORDER.join(',')) {
      return err(
        makeError(
          'SCHEMA_VIOLATION',
          `route ${rule.size} 的 stage_path 必须是 execute→verify→review→land`,
        ),
      )
    }
  }
  const missing = SIZE_ORDER.filter((size) => !seen.has(size))
  if (missing.length > 0)
    return err(makeError('SCHEMA_VIOLATION', `route 缺少规模：${missing.join(',')}`))
  return ok(true)
}

export function validateRoutePackage(value: unknown): Result<ValidatedRoutePackage> {
  if (!routePackageValidator(value)) {
    return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(routePackageValidator.errors)))
  }
  const routePackage = value
  if (routePackageDigest(routePackage) !== routePackage.content_digest) {
    return err(makeError('SCHEMA_VIOLATION', 'route package content_digest 不一致'))
  }
  const rules = validateRouteRules(routePackage.route_rules)
  if (!rules.ok) return rules
  if (routePackage.must_stop.content_digest !== sha256Text(routePackage.must_stop.content)) {
    return err(makeError('SCHEMA_VIOLATION', 'route must-stop content_digest 不一致'))
  }
  if (routePackage.instructions.must_stop !== routePackage.must_stop.content) {
    return err(
      makeError('SCHEMA_VIOLATION', 'route instructions.must_stop 与 must_stop.content 不一致'),
    )
  }
  if (
    routePackage.stage_templates.map((stage) => stage.stage).join(',') !==
    TICKET_STAGE_ORDER.join(',')
  ) {
    return err(makeError('SCHEMA_VIOLATION', 'route stage_templates 缺失、重复或顺序不兼容'))
  }
  const policy = parseToolPolicy(routePackage.tool_policy)
  if (!policy.ok) return policy
  for (const stage of routePackage.stage_templates) {
    if (stage.content_digest !== sha256Text(stage.instructions)) {
      return err(makeError('SCHEMA_VIOLATION', `route 阶段 ${stage.stage} 的内容摘要不一致`))
    }
    if (policy.value.stages[stage.stage] !== stage.tool_profile) {
      return err(
        makeError(
          'SCHEMA_VIOLATION',
          `route 阶段 ${stage.stage} 的 tool profile 与 tool_policy 不一致`,
        ),
      )
    }
    const source = sourceFor(routePackage.sources, stage.provider_path)
    if (source === undefined || source.sha256 !== stage.content_digest) {
      return err(
        makeError('SCHEMA_VIOLATION', `route 阶段 ${stage.stage} 缺少绑定的 provider 来源摘要`),
      )
    }
  }
  const sourceChecks = [
    ['src/flow/skills/route/SKILL.md', routePackage.instructions.route],
    ['src/flow/skills/route/stages.md', routePackage.instructions.stages],
    ['src/flow/skills/route/must-stop.md', routePackage.instructions.must_stop],
  ] as const
  for (const [path, content] of sourceChecks) {
    const source = sourceFor(routePackage.sources, path)
    if (source === undefined || source.sha256 !== sha256Text(content)) {
      return err(makeError('SCHEMA_VIOLATION', `route 固定来源 ${path} 的摘要不一致`))
    }
  }
  const planSource = sourceFor(routePackage.sources, 'src/managed/plan.md')
  if (
    planSource === undefined ||
    planSource.sha256 !== sha256Text(routePackage.instructions.plan)
  ) {
    return err(makeError('SCHEMA_VIOLATION', 'route plan 指令来源摘要不一致'))
  }
  if (
    new Set(routePackage.sources.map((source) => source.path)).size !== routePackage.sources.length
  ) {
    return err(makeError('SCHEMA_VIOLATION', 'route sources 路径重复'))
  }
  return ok({ package: routePackage, toolPolicy: policy.value })
}

function isRelativeScopePath(path: string): boolean {
  if (path.trim() !== path || path === '' || path.includes('\0') || path.includes('\\'))
    return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

function scopeContains(scope: string, path: string): boolean {
  if (scope === '*') return true
  return path === scope || path.startsWith(`${scope}/`)
}

function cycleNodes(plan: JstackRoutePlan): readonly string[] {
  const deps = new Map(plan.tickets.map((ticket) => [ticket.key, [...ticket.depends_on]]))
  const remaining = new Set(deps.keys())
  const removed = new Set<string>()
  let progress = true
  while (progress) {
    progress = false
    for (const key of [...remaining]) {
      const blockers = deps.get(key) ?? []
      if (blockers.every((blocker) => removed.has(blocker))) {
        remaining.delete(key)
        removed.add(key)
        progress = true
      }
    }
  }
  return [...remaining]
}

export function validateRoutePlan(
  value: unknown,
  routePackage: JstackRoutePackage,
  allowedScopePaths: readonly string[],
): Result<ValidatedRoutePlan> {
  if (!routePlanValidator(value)) {
    return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(routePlanValidator.errors)))
  }
  const plan = value
  const rule = routePackage.route_rules.find((entry) => entry.size === plan.route_size)
  if (rule === undefined)
    return err(makeError('SCHEMA_VIOLATION', `route 包没有规模 ${plan.route_size}`))
  if (plan.tickets.length < rule.min_tickets || plan.tickets.length > rule.max_tickets) {
    return err(
      makeError(
        'SCHEMA_VIOLATION',
        `route ${plan.route_size} 需要 ${rule.min_tickets}..${rule.max_tickets} 个 ticket，实际 ${plan.tickets.length}`,
      ),
    )
  }
  if (allowedScopePaths.length === 0)
    return err(makeError('SCHEMA_VIOLATION', 'workflow 未绑定允许的 scope_paths'))
  const keys = new Set<string>()
  const ticketIds = new Set<string>()
  const issues = new Set<string>()
  for (const ticket of plan.tickets) {
    if (keys.has(ticket.key))
      return err(makeError('SCHEMA_VIOLATION', `ticket key 重复：${ticket.key}`))
    keys.add(ticket.key)
    if (ticketIds.has(ticket.ticket_id))
      return err(makeError('SCHEMA_VIOLATION', `ticket_id 重复：${ticket.ticket_id}`))
    ticketIds.add(ticket.ticket_id)
    if (ticket.external_issue !== undefined) {
      if (issues.has(ticket.external_issue))
        return err(makeError('SCHEMA_VIOLATION', `external_issue 重复：${ticket.external_issue}`))
      issues.add(ticket.external_issue)
    }
    if (!PER_TICKET_SIZES.has(ticket.size)) {
      return err(makeError('SCHEMA_VIOLATION', `ticket ${ticket.key} 必须拆到 XS/S/M`))
    }
    if (plan.route_size === 'XS' || plan.route_size === 'S') {
      if (ticket.size !== plan.route_size)
        return err(
          makeError(
            'SCHEMA_VIOLATION',
            `route ${plan.route_size} 的 ticket 必须同为 ${plan.route_size}`,
          ),
        )
    } else if (SIZE_ORDER.indexOf(ticket.size) > SIZE_ORDER.indexOf(plan.route_size)) {
      return err(makeError('SCHEMA_VIOLATION', `ticket ${ticket.key} 大于整体路线规模`))
    }
    for (const path of ticket.scope_paths) {
      if (!isRelativeScopePath(path))
        return err(makeError('SCHEMA_VIOLATION', `ticket ${ticket.key} 含非法 scope path：${path}`))
      if (!allowedScopePaths.some((scope) => scopeContains(scope, path))) {
        return err(
          makeError(
            'SCHEMA_VIOLATION',
            `ticket ${ticket.key} 的 scope 越出 workflow 范围：${path}`,
          ),
        )
      }
    }
    if ((ticket.depends_on as readonly string[]).includes(ticket.key))
      return err(makeError('SCHEMA_VIOLATION', `ticket ${ticket.key} 不能依赖自身`))
  }
  for (const ticket of plan.tickets) {
    for (const dependency of ticket.depends_on) {
      if (!keys.has(dependency))
        return err(makeError('SCHEMA_VIOLATION', `ticket ${ticket.key} 依赖不存在的 ${dependency}`))
    }
  }
  const cyclic = cycleNodes(plan)
  if (cyclic.length > 0)
    return err(makeError('SCHEMA_VIOLATION', `ticket 依赖存在循环：${cyclic.join(',')}`))
  const roots = plan.tickets.filter((ticket) => ticket.depends_on.length === 0)
  if (roots.length === 0) return err(makeError('SCHEMA_VIOLATION', 'ticket 图没有可启动的根节点'))
  return ok({ plan, digest: routePlanDigest(plan) })
}

export function buildTicketPackageForNode(
  routePackage: JstackRoutePackage,
  ticket: JstackRoutePlan['tickets'][number],
): Result<JstackTicketPackage> {
  const ticketPackage = {
    protocol_version: '1.0' as const,
    workflow_id: 'jstack' as const,
    mode: 'ticket' as const,
    source_commit: routePackage.source_commit,
    ticket: {
      id: ticket.ticket_id,
      title: ticket.title,
      ...(ticket.description === undefined ? {} : { description: ticket.description }),
    },
    route: {
      size: ticket.size,
      stages: [...TICKET_STAGE_ORDER] as JstackTicketPackage['route']['stages'],
    },
    stages: routePackage.stage_templates,
    instructions: {
      route: routePackage.instructions.route,
      stages: routePackage.instructions.stages,
      must_stop: routePackage.instructions.must_stop,
    },
    tool_policy: routePackage.tool_policy,
    must_stop: routePackage.must_stop,
    completion_target: routePackage.completion_target,
    sources: routePackage.sources,
    content_digest: '',
  }
  ticketPackage.content_digest = ticketPackageDigest(ticketPackage)
  const validated = validateTicketPackage(ticketPackage)
  return validated.ok ? ok(ticketPackage) : err(makeError('PROTOCOL_ERROR', validated.error.detail))
}
