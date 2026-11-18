/**
 * 执行面模型路由 —— 部署配置、阶段/角色解析与启动期校验。
 *
 * 项目本身**不预设**模型 id 和思考等级：不同部署可用的模型目录不同，
 * 把某家企业的目录写进源码会让换环境时必须改代码。这里只保留机制：
 *
 * - `KEEL_MODEL_PROFILES_FILE` 指向部署方的 JSON 配置；
 * - `KEEL_MODEL_PROFILE` 选择其中一个 profile；
 * - `--model` / `KEEL_MODEL` 是全局显式覆盖；
 * - stage / role 的具体模型与可选 thinking 由配置决定。
 *
 * 配置结构（示例中的值全部是占位符）：
 *
 * ```json
 * {
 *   "profiles": {
 *     "team-a": {
 *       "omp": {
 *         "stages": {
 *           "develop": { "model": "<model-id>" },
 *           "managed_investigate": { "model": "<model-id>" }
 *         },
 *         "roles": {
 *           "Reviewer": { "model": "<model-id>" }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * 解析优先级：`override > role > stage > 不传`。`thinking` 按 role / stage
 * 独立解析，不因 model 是否配置而改变。缺项表示不覆盖，由 harness 或用户
 * 自己的配置决定；未知字段 / 未知 stage / 未知 role / 空值都在启动期拒绝。
 */

import { readFileSync } from 'node:fs'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { ROLES, type RoleId, STAGES, type Stage } from '../shared/ids.js'

/** 模型路由支持的三类 harness；配置键与 adapter 的 harness_id 一致。 */
export const MODEL_HARNESSES = ['omp', 'claude', 'pi'] as const
export type ModelHarness = (typeof MODEL_HARNESSES)[number]

/**
 * 模型路由阶段 = legacy Stage + managed 入口阶段。
 *
 * managed ticket 的 execute/verify/land 与 legacy 的 develop/qa 是不同入口；
 * `review` 两套流程共用同一阶段键。managed 调查与天问使用
 * managed_investigate / tianwen；`plan` 对应 workflow route planner。
 */
export const MODEL_STAGES = [
  ...STAGES,
  'managed_investigate',
  'tianwen',
  'plan',
  'execute',
  'verify',
  'land',
] as const
export type ModelStage = (typeof MODEL_STAGES)[number]

/** 模型路由角色 = legacy RoleId + managed 调查/天问角色。 */
export const MODEL_ROLES = [...ROLES, 'Investigator', 'Tianwen'] as const
export type ModelRole = (typeof MODEL_ROLES)[number]

export interface ModelRouteEntry {
  readonly model?: string
  readonly thinking?: string
}

export interface ModelRouteTable {
  readonly stages?: Partial<Record<ModelStage, ModelRouteEntry>>
  readonly roles?: Partial<Record<ModelRole, ModelRouteEntry>>
}

/** 一个 profile 下按 harness 分表；同一 profile 不应把 omp 的模型串给 pi。 */
export type ModelProfileDefinition = Partial<Record<ModelHarness, ModelRouteTable>>

export interface ModelProfilesConfig {
  readonly profiles: Readonly<Record<string, ModelProfileDefinition>>
}

export interface ModelRoutingSettings {
  /** 未设置 = 不做 profile 路由，只用显式 override 或 harness 自己的配置。 */
  readonly profile?: string
  readonly profiles?: ModelProfilesConfig
  readonly allowlist: readonly string[]
}

export interface ResolvedModelRoute {
  readonly model?: string
  readonly thinking?: string
}

/** profile 名规则由 `KEEL_MODEL_PROFILE` 与配置文件共用，避免写出选不中的键。 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * `KEEL_MODEL_PROFILE` → profile 名。未设置 = 不做 profile 路由。
 *
 * 不枚举 `default` / `enterprise`：profile 名由部署配置文件决定。拼错或
 * 夹带空白都拒绝，不能静默退回“不用 profile”。
 */
export function parseProfile(raw: string | undefined): Result<string | undefined> {
  if (raw === undefined) return ok(undefined)
  const trimmed = raw.trim()
  if (trimmed === '') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        'KEEL_MODEL_PROFILE 为空。省略它表示不做 profile 路由；空白值不会静默当作省略。',
      ),
    )
  }
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_PROFILE=${trimmed} 非法：只接受字母、数字、点、下划线和短横线，` +
          '且必须以字母或数字开头。',
      ),
    )
  }
  return ok(trimmed)
}

/**
 * `KEEL_MODEL_ALLOWLIST` → 允许的模型清单。未设置 = 不校验。
 *
 * 空项拒绝：`a,,b` 多半是拼写事故；静默跳过会让清单比写的人以为的更宽松。
 */
export function parseAllowlist(raw: string | undefined): Result<readonly string[]> {
  if (raw === undefined) return ok([])
  const items = raw.split(',').map((item) => item.trim())
  const emptyAt = items.indexOf('')
  if (emptyAt >= 0) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_ALLOWLIST 必须是逗号分隔的非空模型 id，第 ${emptyAt + 1} 项为空。` +
          '空项不会静默忽略。',
      ),
    )
  }
  return ok(items)
}

/**
 * 读取部署方提供的 profile 文件。文件内容只含模型 id 和 thinking 名，
 * 不放网关地址或密钥。
 */
export function loadModelProfilesFile(path: string): Result<ModelProfilesConfig> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `无法读取 KEEL_MODEL_PROFILES_FILE=${path}：` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_PROFILES_FILE=${path} 不是合法 JSON：` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
  return parseModelProfilesDocument(raw, path)
}

/** 解析并校验 profile 文档；纯函数，测试不需要碰文件系统。 */
export function parseModelProfilesDocument(
  raw: unknown,
  source = 'KEEL_MODEL_PROFILES_FILE',
): Result<ModelProfilesConfig> {
  const document = asRecord(raw)
  if (document === undefined) return invalid(`${source} 顶层必须是对象`)
  const unknownKey = rejectUnknownKeys(document, ['profiles'], source)
  if (!unknownKey.ok) return unknownKey

  const profilesRaw = asRecord(document.profiles)
  if (profilesRaw === undefined || Object.keys(profilesRaw).length === 0) {
    return invalid(`${source}.profiles 必须是非空对象`)
  }

  const profiles: Record<string, ModelProfileDefinition> = {}
  for (const [name, profileRaw] of Object.entries(profilesRaw)) {
    if (!PROFILE_NAME_PATTERN.test(name)) {
      return invalid(
        `${source}.profiles[${JSON.stringify(name)}] 不是合法 profile 名：` +
          '只接受字母、数字、点、下划线和短横线，且必须以字母或数字开头。',
      )
    }
    const parsed = parseProfileDefinition(profileRaw, `${source}.profiles.${name}`)
    if (!parsed.ok) return parsed
    profiles[name] = parsed.value
  }
  return ok({ profiles })
}

/**
 * 从环境读取路由设置。`KEEL_MODEL_PROFILE` 一旦设置，配置文件与 profile
 * 必须存在；否则启动期失败，不静默退回“没有 profile”。
 */
export function loadModelRoutingSettings(
  env: NodeJS.ProcessEnv = process.env,
): Result<ModelRoutingSettings> {
  const profile = parseProfile(env.KEEL_MODEL_PROFILE)
  if (!profile.ok) return profile
  const allowlist = parseAllowlist(env.KEEL_MODEL_ALLOWLIST)
  if (!allowlist.ok) return allowlist

  if (profile.value === undefined) {
    return ok({ allowlist: allowlist.value })
  }

  const file = env.KEEL_MODEL_PROFILES_FILE?.trim()
  if (file === undefined || file === '') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_PROFILE=${profile.value} 需要 KEEL_MODEL_PROFILES_FILE 指向部署方的 profile JSON。`,
      ),
    )
  }

  const config = loadModelProfilesFile(file)
  if (!config.ok) return config
  if (config.value.profiles[profile.value] === undefined) {
    const available = Object.keys(config.value.profiles).sort().join(', ')
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_PROFILE=${profile.value} 在 ${file} 中不存在；` +
          `可用 profile：${available === '' ? '（空）' : available}。`,
      ),
    )
  }
  return ok({
    profile: profile.value,
    profiles: config.value,
    allowlist: allowlist.value,
  })
}

export interface ResolveModelRouteInput {
  readonly harness: string
  readonly stage: ModelStage
  readonly role: ModelRole
  /** 显式 `--model` / `KEEL_MODEL`；undefined = 不覆盖。 */
  readonly override?: string
  readonly routing: ModelRoutingSettings
}

/**
 * 解析一次 spawn 的最终模型与 thinking。
 *
 * - `override` 最高优先级，且压过 role / stage；
 * - role 覆盖 stage；两者都缺 = 不传模型，由 harness 自己的配置决定；
 * - `thinking` 独立按 role > stage 解析，不因 model 缺项而丢失；
 * - 非 Pi harness 配了 thinking 直接拒绝，不静默忽略。
 */
export function resolveModelRoute(input: ResolveModelRouteInput): Result<ResolvedModelRoute> {
  const harness = asModelHarness(input.harness)
  if (!harness.ok) return harness

  const override = normalizeOverride(input.override)
  if (!override.ok) return override

  if (input.routing.profile === undefined) {
    const allowlisted = checkAllowlist(
      override.value,
      input.routing.allowlist,
      input.stage,
      input.role,
    )
    if (!allowlisted.ok) return allowlisted
    return ok(withOptionalRoute(override.value, undefined))
  }

  const table = profileTable(input.routing, harness.value, input.stage)
  if (!table.ok) return table

  const stageEntry = table.value.stages?.[input.stage]
  const roleEntry = table.value.roles?.[input.role]
  const model = override.value ?? roleEntry?.model ?? stageEntry?.model
  const thinking = roleEntry?.thinking ?? stageEntry?.thinking

  const capability = checkThinking(harness.value, thinking, input.stage, input.role)
  if (!capability.ok) return capability
  const allowlisted = checkAllowlist(model, input.routing.allowlist, input.stage, input.role)
  if (!allowlisted.ok) return allowlisted

  return ok(withOptionalRoute(model, thinking))
}

export interface RoutingPreflightInput {
  readonly harness: string
  readonly routing: ModelRoutingSettings
  /** 显式 `--model` / `KEEL_MODEL`；undefined = 不覆盖。 */
  readonly override?: string
}

/**
 * 启动期预检：配置结构、thinking 能力与 allowlist 必须在认领/spawn 前通过。
 *
 * 配置里的每个 stage / role 条目都会被检查，不只检查当前可能要跑的那一条。
 */
export function preflightModelRouting(input: RoutingPreflightInput): Result<void> {
  const harness = asModelHarness(input.harness)
  if (!harness.ok) return harness
  const override = normalizeOverride(input.override)
  if (!override.ok) return override

  if (input.routing.profile === undefined) {
    const allowlisted = checkAllowlist(
      override.value,
      input.routing.allowlist,
      undefined,
      undefined,
    )
    return allowlisted.ok ? ok(undefined) : allowlisted
  }

  const table = profileTable(input.routing, harness.value, undefined)
  if (!table.ok) return table

  for (const [stage, entry] of Object.entries(table.value.stages ?? {})) {
    const checked = checkRouteEntry(
      harness.value,
      stage as ModelStage,
      entry,
      input.routing.allowlist,
    )
    if (!checked.ok) return checked
  }
  for (const [role, entry] of Object.entries(table.value.roles ?? {})) {
    const checked = checkRouteEntry(
      harness.value,
      undefined,
      entry,
      input.routing.allowlist,
      role as ModelRole,
    )
    if (!checked.ok) return checked
  }

  const allowlisted = checkAllowlist(override.value, input.routing.allowlist, undefined, undefined)
  return allowlisted.ok ? ok(undefined) : allowlisted
}

function parseProfileDefinition(raw: unknown, where: string): Result<ModelProfileDefinition> {
  const profile = asRecord(raw)
  if (profile === undefined) return invalid(`${where} 必须是对象`)
  if (Object.keys(profile).length === 0) {
    return invalid(`${where} 至少需要一个 harness 配置`)
  }

  const parsed: Partial<Record<ModelHarness, ModelRouteTable>> = {}
  for (const [harness, tableRaw] of Object.entries(profile)) {
    if (!isModelHarness(harness)) {
      return invalid(`${where}.${harness} 不是支持的 harness（${MODEL_HARNESSES.join(' | ')}）`)
    }
    const table = parseRouteTable(tableRaw, `${where}.${harness}`)
    if (!table.ok) return table
    parsed[harness] = table.value
  }
  return ok(parsed)
}

function parseRouteTable(raw: unknown, where: string): Result<ModelRouteTable> {
  const table = asRecord(raw)
  if (table === undefined) return invalid(`${where} 必须是对象`)
  const unknownKey = rejectUnknownKeys(table, ['stages', 'roles'], where)
  if (!unknownKey.ok) return unknownKey

  const stages = parseStageEntries(table.stages, `${where}.stages`)
  if (!stages.ok) return stages
  const roles = parseRoleEntries(table.roles, `${where}.roles`)
  if (!roles.ok) return roles

  if (stages.value === undefined && roles.value === undefined) {
    return invalid(`${where} 至少需要 stages 或 roles 中的一项`)
  }
  return ok({
    ...(stages.value === undefined ? {} : { stages: stages.value }),
    ...(roles.value === undefined ? {} : { roles: roles.value }),
  })
}

function parseStageEntries(
  raw: unknown,
  where: string,
): Result<Partial<Record<ModelStage, ModelRouteEntry>> | undefined> {
  if (raw === undefined) return ok(undefined)
  const entries = asRecord(raw)
  if (entries === undefined) return invalid(`${where} 必须是对象`)
  if (Object.keys(entries).length === 0) return invalid(`${where} 不能为空对象`)

  const parsed: Partial<Record<ModelStage, ModelRouteEntry>> = {}
  for (const [stage, entryRaw] of Object.entries(entries)) {
    if (!isModelStage(stage)) {
      return invalid(`${where}.${stage} 不是支持的阶段（${MODEL_STAGES.join(' | ')}）`)
    }
    const entry = parseRouteEntry(entryRaw, `${where}.${stage}`)
    if (!entry.ok) return entry
    parsed[stage] = entry.value
  }
  return ok(parsed)
}

function parseRoleEntries(
  raw: unknown,
  where: string,
): Result<Partial<Record<ModelRole, ModelRouteEntry>> | undefined> {
  if (raw === undefined) return ok(undefined)
  const entries = asRecord(raw)
  if (entries === undefined) return invalid(`${where} 必须是对象`)
  if (Object.keys(entries).length === 0) return invalid(`${where} 不能为空对象`)

  const parsed: Partial<Record<ModelRole, ModelRouteEntry>> = {}
  for (const [role, entryRaw] of Object.entries(entries)) {
    if (!isModelRole(role)) {
      return invalid(`${where}.${role} 不是支持的角色（${MODEL_ROLES.join(' | ')}）`)
    }
    const entry = parseRouteEntry(entryRaw, `${where}.${role}`)
    if (!entry.ok) return entry
    parsed[role] = entry.value
  }
  return ok(parsed)
}

function parseRouteEntry(raw: unknown, where: string): Result<ModelRouteEntry> {
  const entry = asRecord(raw)
  if (entry === undefined) return invalid(`${where} 必须是对象`)
  const unknownKey = rejectUnknownKeys(entry, ['model', 'thinking'], where)
  if (!unknownKey.ok) return unknownKey

  const model = optionalNonEmptyString(entry.model, `${where}.model`)
  if (!model.ok) return model
  const thinking = optionalNonEmptyString(entry.thinking, `${where}.thinking`)
  if (!thinking.ok) return thinking

  if (model.value === undefined && thinking.value === undefined) {
    return invalid(`${where} 至少需要 model 或 thinking，空条目不能表达任何意图`)
  }
  return ok({
    ...(model.value === undefined ? {} : { model: model.value }),
    ...(thinking.value === undefined ? {} : { thinking: thinking.value }),
  })
}

function profileTable(
  routing: ModelRoutingSettings,
  harness: ModelHarness,
  stage: ModelStage | undefined,
): Result<ModelRouteTable> {
  const profile = routing.profile
  if (profile === undefined) {
    return invalid('内部错误：profileTable 需要已选择的 profile')
  }
  const config = routing.profiles
  if (config === undefined) {
    return invalid(`profile=${profile} 缺少已加载的 profiles 配置`)
  }
  const definition = config.profiles[profile]
  if (definition === undefined) {
    return invalid(`profile=${profile} 在 profile 配置中不存在`)
  }
  const table = definition[harness]
  if (table === undefined) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `profile=${profile} 没有配置 harness=${harness}` +
          `${stage === undefined ? '' : `（stage=${stage}）`}。` +
          '选中 profile 时必须为该 harness 显式提供 stages/roles，不能静默当作未配置。',
      ),
    )
  }
  return ok(table)
}

function checkRouteEntry(
  harness: ModelHarness,
  stage: ModelStage | undefined,
  entry: ModelRouteEntry,
  allowlist: readonly string[],
  role?: ModelRole,
): Result<void> {
  const capability = checkThinking(harness, entry.thinking, stage, role)
  if (!capability.ok) return capability
  return checkAllowlist(entry.model, allowlist, stage, role)
}

function checkThinking(
  harness: ModelHarness,
  thinking: string | undefined,
  stage: ModelStage | undefined,
  role?: ModelRole,
): Result<void> {
  if (thinking === undefined || harness === 'pi') return ok(undefined)
  return err(
    makeError(
      'CAPABILITY_UNSUPPORTED',
      `${harness} 不支持 thinking 覆盖${routeLabel(stage, role)}。` +
        '配了 thinking 就必须由支持的 harness 消费，不能静默丢弃。',
    ),
  )
}

function checkAllowlist(
  model: string | undefined,
  allowlist: readonly string[],
  stage: ModelStage | undefined,
  role?: ModelRole,
): Result<void> {
  if (model === undefined || allowlist.length === 0 || allowlist.includes(model)) {
    return ok(undefined)
  }
  return err(
    makeError(
      'CAPABILITY_UNSUPPORTED',
      `模型 ${model}${routeLabel(stage, role)} 不在 KEEL_MODEL_ALLOWLIST 内：` +
        `${allowlist.join(', ')}。不允许静默回退到清单内其它模型。`,
    ),
  )
}

function routeLabel(stage: ModelStage | undefined, role: ModelRole | undefined): string {
  if (stage === undefined) return role === undefined ? '' : `（role=${role}）`
  return role === undefined ? `（stage=${stage}）` : `（stage=${stage}, role=${role}）`
}

function withOptionalRoute(
  model: string | undefined,
  thinking: string | undefined,
): ResolvedModelRoute {
  return {
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
  }
}

function normalizeOverride(raw: string | undefined): Result<string | undefined> {
  if (raw === undefined) return ok(undefined)
  const trimmed = raw.trim()
  if (trimmed === '') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        '模型覆盖为空。空白值不会静默回退到 profile 或 harness 缺省，拒绝。',
      ),
    )
  }
  return ok(trimmed)
}

function optionalNonEmptyString(raw: unknown, where: string): Result<string | undefined> {
  if (raw === undefined) return ok(undefined)
  if (typeof raw !== 'string') return invalid(`${where} 必须是非空字符串`)
  const trimmed = raw.trim()
  if (trimmed === '') return invalid(`${where} 不能为空`)
  return ok(trimmed)
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): Result<void> {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return invalid(`${where}.${key} 不是支持的字段（只接受 ${allowed.join(' | ')}）`)
    }
  }
  return ok(undefined)
}

function asModelHarness(raw: string): Result<ModelHarness> {
  if (isModelHarness(raw)) return ok(raw)
  return invalid(`未知 harness：${raw}（只接受 ${MODEL_HARNESSES.join(' | ')}）`)
}

function isModelHarness(raw: string): raw is ModelHarness {
  return (MODEL_HARNESSES as readonly string[]).includes(raw)
}

function isModelStage(raw: string): raw is ModelStage {
  return (MODEL_STAGES as readonly string[]).includes(raw)
}

function isModelRole(raw: string): raw is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(raw)
}

function invalid<T>(detail: string): Result<T> {
  return err(makeError('CAPABILITY_UNSUPPORTED', detail))
}

export type { RoleId, Stage }
