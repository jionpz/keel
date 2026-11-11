import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import { buildExecutorEnv } from './executor-env.js'
import { type ManagedOsSandbox, prepareManagedOsSandbox } from './os-sandbox.js'

export type ManagedHarness = 'pi' | 'claude' | 'omp'

export interface ManagedExecutorEnv {
  /** 每次执行的独立根目录，位于 /tmp 下。 */
  readonly root: string
  readonly home: string
  readonly tmpdir: string
  /** 只含 allowlist、HOME、TMPDIR 的子进程环境。 */
  readonly env: NodeJS.ProcessEnv
  /** Pi 子代理扩展的隔离副本；没有安装时为空。 */
  readonly piExtensions: readonly string[]
  /** 操作系统级文件系统/网络边界；未指定 workspace 时为 undefined。 */
  readonly sandbox?: ManagedOsSandbox
  dispose(): Promise<void>
}

export interface PrepareManagedEnvOptions {
  readonly harness: ManagedHarness
  readonly model?: string
  /** 默认 process.env；测试可注入 sentinel。 */
  readonly sourceEnv?: NodeJS.ProcessEnv
  /** 宿主 HOME，只用于读取模型配置；默认 os.homedir()。 */
  readonly hostHome?: string
  readonly rootBase?: string
  /** 任务 worktree；提供时强制建立操作系统沙箱。 */
  readonly workspace?: string
  /** 沙箱允许访问的本机端口；默认 3425（模型网关）。 */
  readonly sandboxNetworkPorts?: readonly number[]
  /** 测试注入；默认读宿主 ~/.pi/agent/models.json。 */
  readonly piModels?: unknown
  /** 测试注入；默认读宿主 ~/.claude/settings.json。 */
  readonly claudeSettings?: unknown
  /** 测试注入；默认读宿主 ~/.omp/agent/models.yml。 */
  readonly ompModels?: string
}

const SAFE_PLACEHOLDER_KEYS = new Set([
  '',
  'magpie',
  'public',
  'local',
  'dummy',
  'test',
  'probe',
  'probe-key',
  'none',
])

/**
 * 为一次 managed 执行构造隔离环境。
 *
 * 关键约束：
 * - 环境只由 `buildExecutorEnv` 生成，不继承宿主 process.env；
 * - HOME/TMPDIR 每次执行独立，位于 /tmp；
 * - 模型配置只复制本机网关的必要字段，拒绝 keychain 命令和外网 baseUrl；
 * - 不复制宿主 ~/.ssh、~/.config/gh、GitHub token 或 Claude/Pi 的 OAuth 状态。
 */
export async function prepareManagedExecutorEnv(
  options: PrepareManagedEnvOptions,
): Promise<Result<ManagedExecutorEnv>> {
  const rootBase = options.rootBase ?? '/tmp'
  if (rootBase !== '/tmp' && !rootBase.startsWith('/tmp/')) {
    return err(makeError('CAPABILITY_UNSUPPORTED', `managed 执行根目录必须在 /tmp：${rootBase}`))
  }

  let root: string
  try {
    root = await mkdtemp(join(rootBase, 'keel-exec-'))
  } catch (error) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `无法创建 managed 执行目录：${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
  const home = join(root, 'home')
  const tmpdir = join(root, 'tmp')

  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
    await mkdir(tmpdir, { recursive: true, mode: 0o700 })
    const env = buildExecutorEnv(options.sourceEnv ?? process.env, { home, tmpdir })
    await writeGitConfig(home)

    let piExtensions: readonly string[] = []
    switch (options.harness) {
      case 'pi':
        piExtensions = await preparePiConfig(
          home,
          options.hostHome ?? homedir(),
          options.model,
          options.piModels,
        )
        break
      case 'claude':
        await prepareClaudeConfig(
          home,
          tmpdir,
          options.hostHome ?? homedir(),
          options.claudeSettings,
        )
        break
      case 'omp':
        await prepareOmpConfig(
          home,
          options.hostHome ?? homedir(),
          options.model,
          options.ompModels,
        )
        break
    }

    let sandbox: ManagedOsSandbox | undefined
    if (options.workspace !== undefined) {
      const preparedSandbox = await prepareManagedOsSandbox({
        workspace: options.workspace,
        root,
        home,
        tmpdir,
        hostHome: options.hostHome ?? homedir(),
        ...(options.sandboxNetworkPorts === undefined
          ? {}
          : { networkPorts: options.sandboxNetworkPorts }),
      })
      if (!preparedSandbox.ok) throw preparedSandbox.error
      sandbox = preparedSandbox.value
    }

    return ok({
      root,
      home,
      tmpdir,
      env,
      piExtensions,
      ...(sandbox === undefined ? {} : { sandbox }),
      dispose: async () => {
        await rm(root, { recursive: true, force: true, maxRetries: 3 })
      },
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        error instanceof Error ? error.message : '无法构造 managed 执行环境',
      ),
    )
  }
}

async function writeGitConfig(home: string): Promise<void> {
  await writeFile(
    join(home, '.gitconfig'),
    [
      '[user]',
      '\tname = Keel Managed Executor',
      '\temail = keel-managed@invalid',
      '[credential]',
      '\thelper =',
      '[core]',
      '\taskpass =',
      '[commit]',
      '\tgpgsign = false',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
}

async function preparePiConfig(
  home: string,
  hostHome: string,
  requestedModel: string | undefined,
  injectedModels: unknown,
): Promise<readonly string[]> {
  const agentDir = join(home, '.pi', 'agent')
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  const hostAgentDir = join(hostHome, '.pi', 'agent')
  const models = injectedModels ?? (await readJson(join(hostAgentDir, 'models.json')))
  const settings = await readJson(join(hostAgentDir, 'settings.json')).catch(() => undefined)
  const modelId = requestedModel ?? stringField(settings, 'defaultModel')
  if (modelId === undefined || modelId.trim() === '') {
    throw new Error('Pi managed 执行需要显式模型，或宿主 settings.json 的 defaultModel')
  }

  const providers = objectField(models, 'providers')
  if (providers === undefined) throw new Error('Pi models.json 缺少 providers')
  const candidates = Object.entries(providers).flatMap(([name, provider]) => {
    const model = findModel(provider, modelId)
    return model === undefined ? [] : [{ name, provider, model }]
  })
  if (candidates.length === 0) {
    throw new Error(`Pi models.json 中找不到模型 ${modelId}`)
  }
  const candidate = candidates.find((entry) =>
    isLoopbackUrl(stringField(entry.provider, 'baseUrl')),
  )
  if (candidate === undefined) {
    throw new Error(`模型 ${modelId} 没有配置本机网关 baseUrl；managed 写执行拒绝外网模型凭据`)
  }
  const baseUrl = stringField(candidate.provider, 'baseUrl')
  if (baseUrl === undefined) throw new Error(`Pi provider ${candidate.name} 缺少 baseUrl`)
  const apiKey = stringField(candidate.provider, 'apiKey')
  assertSafeApiKey(apiKey, `Pi provider ${candidate.name}`)

  const minimalProvider: Record<string, unknown> = {
    api: stringField(candidate.provider, 'api') ?? 'openai-completions',
    baseUrl,
    models: [candidate.model],
  }
  if (apiKey !== undefined) minimalProvider.apiKey = apiKey
  const compat = objectField(candidate.provider, 'compat')
  if (compat !== undefined) minimalProvider.compat = compat

  await writeJson(join(agentDir, 'models.json'), {
    providers: { [candidate.name]: minimalProvider },
  })
  const minimalSettings: Record<string, unknown> = {
    defaultProvider: candidate.name,
    defaultModel: modelId,
  }
  const thinking = stringField(settings, 'defaultThinkingLevel')
  if (thinking !== undefined) minimalSettings.defaultThinkingLevel = thinking
  await writeJson(join(agentDir, 'settings.json'), minimalSettings)

  return copyPiSubagents(hostAgentDir, agentDir)
}

async function copyPiSubagents(hostAgentDir: string, agentDir: string): Promise<readonly string[]> {
  const hostNpmDir = join(hostAgentDir, 'npm', 'node_modules')
  const isolatedNpmDir = join(agentDir, 'npm', 'node_modules')
  const source = join(hostNpmDir, '@tintinweb', 'pi-subagents')
  const dest = join(isolatedNpmDir, '@tintinweb', 'pi-subagents')
  try {
    await cp(source, dest, { recursive: true, force: true, dereference: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw new Error(
      `无法复制 Pi 子代理扩展到隔离 HOME：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  await copyNpmDependencies(hostNpmDir, isolatedNpmDir, dest, new Set())
  for (const candidate of [join(dest, 'dist', 'index.js'), join(dest, 'src', 'index.ts')]) {
    try {
      await readFile(candidate)
      return [candidate]
    } catch {
      // 继续找另一种入口
    }
  }
  return []
}

async function copyNpmDependencies(
  hostNpmDir: string,
  isolatedNpmDir: string,
  packageDir: string,
  seen: Set<string>,
): Promise<void> {
  const manifest = await readJson(join(packageDir, 'package.json')).catch(() => undefined)
  const dependencies = objectField(manifest, 'dependencies')
  if (dependencies === undefined) return
  for (const name of Object.keys(dependencies)) {
    if (seen.has(name)) continue
    seen.add(name)
    const source = join(hostNpmDir, name)
    const dest = join(isolatedNpmDir, name)
    try {
      await cp(source, dest, { recursive: true, force: true, dereference: true })
    } catch (error) {
      if (isNotFound(error)) {
        throw new Error(`Pi 子代理扩展依赖 ${name} 不在宿主 Pi agent 目录中`)
      }
      throw error
    }
    await copyNpmDependencies(hostNpmDir, isolatedNpmDir, dest, seen)
  }
}

async function prepareClaudeConfig(
  home: string,
  tmpdir: string,
  hostHome: string,
  injectedSettings: unknown,
): Promise<void> {
  const settings = injectedSettings ?? (await readJson(join(hostHome, '.claude', 'settings.json')))
  const hostEnv = objectField(settings, 'env') ?? {}
  const baseUrl = stringField(hostEnv, 'ANTHROPIC_BASE_URL')
  if (baseUrl === undefined || !isLoopbackUrl(baseUrl)) {
    throw new Error('Claude managed 执行要求 ANTHROPIC_BASE_URL 指向本机网关')
  }
  const authToken = stringField(hostEnv, 'ANTHROPIC_AUTH_TOKEN')
  const apiKey = stringField(hostEnv, 'ANTHROPIC_API_KEY')
  assertSafeApiKey(authToken ?? apiKey, 'Claude 网关凭据')

  const allowedPrefixes = [
    'ANTHROPIC_DEFAULT_',
    'CLAUDE_CODE_MAX_',
    'CLAUDE_CODE_AUTO_',
    'CLAUDE_CODE_DISABLE_',
    'ENABLE_TOOL_SEARCH',
  ]
  const safeEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
  }
  if (authToken !== undefined) safeEnv.ANTHROPIC_AUTH_TOKEN = authToken
  if (apiKey !== undefined) safeEnv.ANTHROPIC_API_KEY = apiKey
  for (const [key, value] of Object.entries(hostEnv)) {
    if (typeof value !== 'string') continue
    if (
      key === 'ANTHROPIC_BASE_URL' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'ANTHROPIC_API_KEY'
    ) {
      continue
    }
    if (key === 'ANTHROPIC_MODEL' || key === 'ANTHROPIC_SMALL_FAST_MODEL') {
      safeEnv[key] = value
      continue
    }
    if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) safeEnv[key] = value
  }

  const claudeDir = join(home, '.claude')
  await mkdir(claudeDir, { recursive: true, mode: 0o700 })
  const claudeTmpDir = join(tmpdir, 'claude')
  await mkdir(claudeTmpDir, { recursive: true, mode: 0o700 })
  safeEnv.CLAUDE_CODE_TMPDIR = claudeTmpDir
  await writeJson(join(claudeDir, 'settings.json'), {
    env: safeEnv,
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false,
  })
  await writeJson(join(home, '.claude.json'), { hasCompletedOnboarding: true })
}

async function prepareOmpConfig(
  home: string,
  hostHome: string,
  requestedModel: string | undefined,
  injectedModels: string | undefined,
): Promise<void> {
  const hostAgentDir = join(hostHome, '.omp', 'agent')
  const modelsText = injectedModels ?? (await readFile(join(hostAgentDir, 'models.yml'), 'utf8'))
  const hostConfig = await readFile(join(hostAgentDir, 'config.yml'), 'utf8').catch(() => '')
  const defaultModel = requestedModel ?? yamlDefaultModel(hostConfig)
  if (defaultModel === undefined || defaultModel.trim() === '') {
    throw new Error('OMP managed 执行需要显式模型，或宿主 config.yml 的 modelRoles.default')
  }

  const parts = defaultModel.split('/')
  const providerHint = parts.length > 1 ? parts[0] : undefined
  const modelPart = parts.length > 1 ? parts.slice(1).join('/') : defaultModel
  const blocks = parseOmpProviders(modelsText)
  const candidates = [...blocks.entries()].filter(([, block]) => block.includes(`id: ${modelPart}`))
  if (candidates.length === 0) throw new Error(`OMP models.yml 中找不到模型 ${defaultModel}`)
  const candidate =
    candidates.find(([name]) => name === providerHint) ??
    candidates.find(([, block]) => isLoopbackUrl(blockBaseUrl(block)))
  if (candidate === undefined) {
    throw new Error(`模型 ${defaultModel} 没有配置本机网关 baseUrl；managed 写执行拒绝外网模型凭据`)
  }
  const [providerName, block] = candidate
  const baseUrl = blockBaseUrl(block)
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(`OMP provider ${providerName} 的 baseUrl 不是本机网关`)
  }
  assertSafeApiKey(blockApiKey(block), `OMP provider ${providerName}`)

  const agentDir = join(home, '.omp', 'agent')
  await mkdir(agentDir, { recursive: true, mode: 0o700 })
  await writeFile(
    join(agentDir, 'models.yml'),
    ['# isolated by keel managed executor', 'providers:', `  ${providerName}:`, block, ''].join(
      '\n',
    ),
    { mode: 0o600 },
  )
  await writeFile(
    join(agentDir, 'config.yml'),
    ['setupVersion: 2', 'modelRoles:', `  default: ${defaultModel}`, ''].join('\n'),
    { mode: 0o600 },
  )
}

function parseOmpProviders(text: string): Map<string, string> {
  const lines = text.split('\n')
  const out = new Map<string, string>()
  let current: string | undefined
  let buffer: string[] = []
  for (const line of lines) {
    const provider = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (provider !== null) {
      if (current !== undefined) out.set(current, buffer.join('\n'))
      current = provider[1] ?? ''
      buffer = []
      continue
    }
    if (current !== undefined) buffer.push(line)
  }
  if (current !== undefined) out.set(current, buffer.join('\n'))
  return out
}

function blockBaseUrl(block: string): string | undefined {
  const matched = /^ {4}baseUrl:\s*(\S+)\s*$/m.exec(block)
  return matched?.[1]
}

function blockApiKey(block: string): string | undefined {
  const matched = /^ {4}apiKey:\s*(.+?)\s*$/m.exec(block)
  return matched?.[1]?.replace(/^['"]|['"]$/g, '')
}

function yamlDefaultModel(config: string): string | undefined {
  const matched = /^ {2}default:\s*(\S+)\s*$/m.exec(config)
  return matched?.[1]
}

function findModel(provider: unknown, modelId: string): unknown {
  const models = arrayField(provider, 'models')
  if (models === undefined) return undefined
  for (const model of models) if (stringField(model, 'id') === modelId) return model
  return undefined
}

function assertSafeApiKey(value: string | undefined, label: string): void {
  if (value === undefined) return
  if (value.startsWith('!')) {
    throw new Error(`${label} 使用 keychain/命令读取密钥；managed 写执行拒绝复制此类配置`)
  }
  if (!SAFE_PLACEHOLDER_KEYS.has(value.trim())) {
    throw new Error(
      `${label} 的 apiKey 不是本机网关占位值；managed 写执行拒绝把真实密钥写进隔离 HOME`,
    )
  }
}

function isLoopbackUrl(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'object' && found !== null && !Array.isArray(found)
    ? (found as Record<string, unknown>)
    : undefined
}

function arrayField(value: unknown, key: string): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return Array.isArray(found) ? found : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}
