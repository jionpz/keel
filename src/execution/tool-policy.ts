import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { sha256CanonicalJson } from '../shared/canonical-json.js'
import type { Stage } from '../shared/ids.js'

export const TOOL_CAPABILITIES = [
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write',
  'bash',
  'delegate',
  'web_search',
  'web_fetch',
] as const

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number]

export interface ToolProfile {
  readonly role: string
  readonly capabilities: readonly ToolCapability[]
  readonly optional_capabilities: readonly ToolCapability[]
}

export interface HarnessToolMapping {
  readonly native: readonly string[]
  readonly fallback?: string
  readonly extension?: boolean
}

export interface ToolPolicyDocument {
  readonly protocol_version: '1.0'
  readonly source_commit: string
  readonly stages: Readonly<Record<string, string>>
  readonly profiles: Readonly<Record<string, ToolProfile>>
  readonly harnesses: Readonly<Record<string, Readonly<Record<string, HarnessToolMapping>>>>
  readonly content_digest: string
}

export interface ToolDegradation {
  readonly capability: ToolCapability
  readonly expected_native: readonly string[]
  readonly fallback_native: string
  readonly reason: string
}

export interface ToolResolution {
  readonly stage: string | null
  readonly role: string
  readonly profile: string
  readonly harness: string
  readonly native_tools: readonly string[]
  readonly permissions: {
    readonly allowed_tools: readonly string[]
    readonly mode: 'deny_unlisted'
  }
  readonly degradations: readonly ToolDegradation[]
  readonly missing_optional: readonly ToolCapability[]
}

export interface ResolveToolPolicyOptions {
  readonly stage?: string
  readonly role?: string
  readonly harness: string
  readonly inventory: readonly string[]
  readonly allowShellFallback?: boolean
}

export const KEEL_STAGE_PROFILE: Readonly<Record<Stage, string>> = {
  pm: 'analyst',
  brainstorm: 'planner',
  critic: 'reviewer',
  rfc_draft: 'planner',
  develop: 'developer',
  qa: 'verifier',
  review: 'reviewer',
}

const TOP_LEVEL_KEYS = new Set([
  'protocol_version',
  'source_commit',
  'stages',
  'profiles',
  'harnesses',
  'content_digest',
])
const PROFILE_KEYS = new Set(['role', 'capabilities', 'optional_capabilities'])
const HARNESS_TOOL_KEYS = new Set(['native', 'fallback', 'extension'])
const SEARCH_CAPABILITIES = new Set<ToolCapability>(['grep', 'find', 'ls'])
const CAPABILITY_SET = new Set<string>(TOOL_CAPABILITIES)
const OMP_TOOL_MAPPING: Readonly<Record<string, HarnessToolMapping>> = {
  read: { native: ['read'] },
  grep: { native: ['grep'] },
  find: { native: ['glob'] },
  ls: { native: ['bash'] },
  edit: { native: ['edit'] },
  write: { native: ['write'] },
  bash: { native: ['bash'] },
  delegate: { native: ['task'] },
  web_search: { native: ['web_search'] },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseCapability(raw: unknown, field: string): Result<ToolCapability> {
  if (typeof raw !== 'string' || !CAPABILITY_SET.has(raw)) {
    return err(makeError('SCHEMA_VIOLATION', `${field} 含未知工具能力：${String(raw)}`))
  }
  return ok(raw as ToolCapability)
}

function parseCapabilities(raw: unknown, field: string): Result<readonly ToolCapability[]> {
  if (!Array.isArray(raw)) {
    return err(makeError('SCHEMA_VIOLATION', `${field} 必须是数组`))
  }
  const out: ToolCapability[] = []
  for (const item of raw) {
    const parsed = parseCapability(item, field)
    if (!parsed.ok) return parsed
    if (out.includes(parsed.value)) {
      return err(makeError('SCHEMA_VIOLATION', `${field} 含重复能力：${parsed.value}`))
    }
    out.push(parsed.value)
  }
  return ok(out)
}

function parseStringList(raw: unknown, field: string): Result<readonly string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return err(makeError('SCHEMA_VIOLATION', `${field} 必须是非空字符串数组`))
  }
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      return err(makeError('SCHEMA_VIOLATION', `${field} 含空白或非字符串项`))
    }
    if (out.includes(item)) {
      return err(makeError('SCHEMA_VIOLATION', `${field} 含重复项：${item}`))
    }
    out.push(item)
  }
  return ok(out)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, field: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return err(makeError('SCHEMA_VIOLATION', `${field} 含未知字段：${key}`))
    }
  }
  return ok(undefined)
}

export function parseToolPolicy(value: unknown): Result<ToolPolicyDocument> {
  if (!isRecord(value)) {
    return err(makeError('SCHEMA_VIOLATION', '工具策略必须是 JSON 对象'))
  }
  const unknown = rejectUnknownKeys(value, TOP_LEVEL_KEYS, '工具策略')
  if (!unknown.ok) return unknown
  if (value.protocol_version !== '1.0') {
    return err(makeError('SCHEMA_VIOLATION', '工具策略 protocol_version 必须是 1.0'))
  }
  if (typeof value.source_commit !== 'string' || value.source_commit.trim() === '') {
    return err(makeError('SCHEMA_VIOLATION', 'source_commit 必须是非空字符串'))
  }
  if (typeof value.content_digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.content_digest)) {
    return err(makeError('SCHEMA_VIOLATION', 'content_digest 必须是 64 位小写十六进制'))
  }
  if (!isRecord(value.stages) || Object.keys(value.stages).length === 0) {
    return err(makeError('SCHEMA_VIOLATION', 'stages 必须是非空对象'))
  }
  if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0) {
    return err(makeError('SCHEMA_VIOLATION', 'profiles 必须是非空对象'))
  }
  if (!isRecord(value.harnesses) || Object.keys(value.harnesses).length === 0) {
    return err(makeError('SCHEMA_VIOLATION', 'harnesses 必须是非空对象'))
  }

  const stages: Record<string, string> = {}
  for (const [stage, profile] of Object.entries(value.stages)) {
    if (stage.trim() === '' || typeof profile !== 'string' || profile.trim() === '') {
      return err(makeError('SCHEMA_VIOLATION', 'stages 的键和值都必须是非空字符串'))
    }
    stages[stage] = profile
  }

  const profiles: Record<string, ToolProfile> = {}
  for (const [name, raw] of Object.entries(value.profiles)) {
    if (!isRecord(raw)) {
      return err(makeError('SCHEMA_VIOLATION', `profiles.${name} 必须是对象`))
    }
    const keys = rejectUnknownKeys(raw, PROFILE_KEYS, `profiles.${name}`)
    if (!keys.ok) return keys
    if (typeof raw.role !== 'string' || raw.role.trim() === '') {
      return err(makeError('SCHEMA_VIOLATION', `profiles.${name}.role 必须是非空字符串`))
    }
    const capabilities = parseCapabilities(raw.capabilities, `profiles.${name}.capabilities`)
    if (!capabilities.ok) return capabilities
    const optional = parseCapabilities(
      raw.optional_capabilities,
      `profiles.${name}.optional_capabilities`,
    )
    if (!optional.ok) return optional
    const overlap = capabilities.value.find((cap) => optional.value.includes(cap))
    if (overlap !== undefined) {
      return err(makeError('SCHEMA_VIOLATION', `profiles.${name} 同时把 ${overlap} 列为必需和可选`))
    }
    profiles[name] = {
      role: raw.role,
      capabilities: capabilities.value,
      optional_capabilities: optional.value,
    }
  }

  for (const [stage, profile] of Object.entries(stages)) {
    if (profiles[profile] === undefined) {
      return err(makeError('SCHEMA_VIOLATION', `阶段 ${stage} 引用了不存在的 profile：${profile}`))
    }
  }

  const harnesses: Record<string, Record<string, HarnessToolMapping>> = {}
  for (const [harness, raw] of Object.entries(value.harnesses)) {
    if (!isRecord(raw)) {
      return err(makeError('SCHEMA_VIOLATION', `harnesses.${harness} 必须是对象`))
    }
    const mapping: Record<string, HarnessToolMapping> = {}
    for (const [capability, rawMapping] of Object.entries(raw)) {
      if (!CAPABILITY_SET.has(capability)) {
        return err(makeError('SCHEMA_VIOLATION', `harnesses.${harness} 含未知能力：${capability}`))
      }
      if (!isRecord(rawMapping)) {
        return err(makeError('SCHEMA_VIOLATION', `harnesses.${harness}.${capability} 必须是对象`))
      }
      const keys = rejectUnknownKeys(
        rawMapping,
        HARNESS_TOOL_KEYS,
        `harnesses.${harness}.${capability}`,
      )
      if (!keys.ok) return keys
      const native = parseStringList(rawMapping.native, `harnesses.${harness}.${capability}.native`)
      if (!native.ok) return native
      let fallback: string | undefined
      if (rawMapping.fallback !== undefined) {
        if (typeof rawMapping.fallback !== 'string' || rawMapping.fallback.trim() === '') {
          return err(
            makeError(
              'SCHEMA_VIOLATION',
              `harnesses.${harness}.${capability}.fallback 必须是非空字符串`,
            ),
          )
        }
        if (capability === 'bash') {
          return err(
            makeError('SCHEMA_VIOLATION', `harnesses.${harness}.bash 不能有 shell fallback`),
          )
        }
        if (native.value.includes(rawMapping.fallback)) {
          return err(
            makeError(
              'SCHEMA_VIOLATION',
              `harnesses.${harness}.${capability}.fallback 不能同时是原生候选`,
            ),
          )
        }
        fallback = rawMapping.fallback
      }
      let extension: boolean | undefined
      if (rawMapping.extension !== undefined) {
        if (typeof rawMapping.extension !== 'boolean') {
          return err(
            makeError(
              'SCHEMA_VIOLATION',
              `harnesses.${harness}.${capability}.extension 必须是布尔值`,
            ),
          )
        }
        extension = rawMapping.extension
      }
      mapping[capability] = {
        native: native.value,
        ...(fallback === undefined ? {} : { fallback }),
        ...(extension === undefined ? {} : { extension }),
      }
    }
    const shellTools = mapping.bash?.native ?? []
    for (const [capability, mappingValue] of Object.entries(mapping)) {
      if (mappingValue.fallback !== undefined && !shellTools.includes(mappingValue.fallback)) {
        return err(
          makeError(
            'SCHEMA_VIOLATION',
            `harnesses.${harness}.${capability}.fallback 必须是该 harness 的 shell 工具`,
          ),
        )
      }
    }
    harnesses[harness] = mapping
  }

  const { content_digest: digest, ...body } = value
  if (sha256CanonicalJson(body) !== digest) {
    return err(makeError('SCHEMA_VIOLATION', 'content_digest 与实际内容不一致'))
  }

  return ok({
    protocol_version: '1.0',
    source_commit: value.source_commit,
    stages,
    profiles,
    harnesses,
    content_digest: digest,
  })
}

export async function loadToolPolicy(path: string): Promise<Result<ToolPolicyDocument>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return err(makeError('NOT_FOUND', `工具策略文件不存在或不可读：${path}`))
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return err(makeError('SCHEMA_VIOLATION', `工具策略不是合法 JSON：${path}`))
  }
  return parseToolPolicy(raw)
}

export function resolveToolPolicyPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.KEEL_TOOL_POLICY
  if (configured !== undefined && configured.trim() !== '') return resolve(cwd, configured)
  return fileURLToPath(new URL('../../config/jstack-tools.json', import.meta.url))
}

export async function loadConfiguredToolPolicy(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<Result<ToolPolicyDocument>> {
  const path = resolveToolPolicyPath(env, cwd)
  const loaded = await loadToolPolicy(path)
  if (!loaded.ok) {
    return err(
      makeError(
        loaded.error.kind,
        `${loaded.error.detail}。运行 jstack tools export 并写入该文件，或设置 KEEL_TOOL_POLICY。`,
        loaded.error,
      ),
    )
  }
  return loaded
}

export function readToolShellFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KEEL_TOOL_SHELL_FALLBACK === '1'
}

function profileFor(
  stage: string,
  role: string | undefined,
  policy: ToolPolicyDocument,
): Result<string> {
  if (role !== undefined) {
    if (policy.profiles[role] === undefined) {
      return err(makeError('CAPABILITY_UNSUPPORTED', `未知工具 profile：${role}`))
    }
    return ok(role)
  }
  const profile = policy.stages[stage]
  if (profile === undefined) {
    return err(makeError('CAPABILITY_UNSUPPORTED', `阶段 ${stage} 没有工具 profile`))
  }
  return ok(profile)
}

function harnessMapping(
  policy: ToolPolicyDocument,
  harness: string,
): Result<Readonly<Record<string, HarnessToolMapping>>> {
  const mapped = policy.harnesses[harness]
  if (mapped !== undefined) return ok(mapped)
  if (harness === 'omp') return ok(OMP_TOOL_MAPPING)
  return err(makeError('CAPABILITY_UNSUPPORTED', `工具策略没有 harness 映射：${harness}`))
}

export function resolveToolPolicy(
  policy: ToolPolicyDocument,
  opts: ResolveToolPolicyOptions,
): Result<ToolResolution> {
  const stage = opts.stage ?? null
  if (stage === null && opts.role === undefined) {
    return err(makeError('CAPABILITY_UNSUPPORTED', '解析工具必须给 stage 或 role'))
  }
  const profileName = profileFor(stage ?? '', opts.role, policy)
  if (!profileName.ok) return profileName
  const profile = policy.profiles[profileName.value]
  if (profile === undefined) {
    return err(makeError('SCHEMA_VIOLATION', `profile 缺失：${profileName.value}`))
  }
  const mapping = harnessMapping(policy, opts.harness)
  if (!mapping.ok) return mapping
  const inventory = new Set(opts.inventory)
  const native: string[] = []
  const degradations: ToolDegradation[] = []
  const missingOptional: ToolCapability[] = []
  const shellAllowed = opts.allowShellFallback === true

  const add = (name: string) => {
    if (!native.includes(name)) native.push(name)
  }
  const pick = (capability: ToolCapability): string | null => {
    const candidates = mapping.value[capability]?.native ?? []
    for (const candidate of candidates) {
      if (inventory.has(candidate)) return candidate
    }
    return null
  }

  for (const capability of profile.capabilities) {
    const direct = pick(capability)
    if (direct !== null) {
      add(direct)
      continue
    }
    const expected = mapping.value[capability]?.native ?? []
    const fallback = mapping.value[capability]?.fallback
    if (fallback !== undefined && shellAllowed && inventory.has(fallback)) {
      add(fallback)
      if (SEARCH_CAPABILITIES.has(capability)) {
        degradations.push({
          capability,
          expected_native: expected,
          fallback_native: fallback,
          reason: '当前 harness 清单没有原生搜索工具，调用方显式允许 Bash 回退',
        })
      } else {
        degradations.push({
          capability,
          expected_native: expected,
          fallback_native: fallback,
          reason: '当前 harness 清单没有原生工具，调用方显式允许 shell 回退',
        })
      }
      continue
    }
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `profile ${profileName.value} 需要 ${capability}，但 harness ${opts.harness} ` +
          `的候选 ${expected.join(', ') || '(无)'} 都不在 inventory 中` +
          (fallback === undefined
            ? '，也没有可用的 fallback'
            : `，fallback ${fallback} ${shellAllowed ? '也不在 inventory 中' : '需要显式允许'}`) +
          '：' +
          `${opts.inventory.join(', ') || '(空)'}。不会静默丢弃或按品牌猜测。`,
      ),
    )
  }

  for (const capability of profile.optional_capabilities) {
    const direct = pick(capability)
    if (direct === null) {
      missingOptional.push(capability)
      continue
    }
    add(direct)
  }

  return ok({
    stage,
    role: profile.role,
    profile: profileName.value,
    harness: opts.harness,
    native_tools: native,
    permissions: { allowed_tools: native, mode: 'deny_unlisted' },
    degradations,
    missing_optional: missingOptional,
  })
}

export function resolveKeelStageToolPolicy(
  policy: ToolPolicyDocument,
  stage: Stage,
  opts: Omit<ResolveToolPolicyOptions, 'stage'>,
): Result<ToolResolution> {
  const profile = KEEL_STAGE_PROFILE[stage]
  return resolveToolPolicy(policy, { ...opts, role: profile })
}
