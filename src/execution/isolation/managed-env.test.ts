import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findExecutorEnvViolations } from './executor-env.js'
import { prepareManagedExecutorEnv } from './managed-env.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp('/tmp/keel-managed-env-test-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function sourceEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/Users/operator',
    TMPDIR: '/var/folders/operator',
    KEEL_GITHUB_TOKEN: 'sentinel-keel',
    GITHUB_TOKEN: 'sentinel-github',
    GH_TOKEN: 'sentinel-gh',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    CLAUDE_CODE_SESSION_ID: 'sentinel-session',
  }
}

const PI_MODELS = {
  providers: {
    magpie: {
      api: 'openai-completions',
      apiKey: 'magpie',
      baseUrl: 'http://127.0.0.1:3425/v1',
      models: [{ id: 'demo/model', name: 'demo' }],
    },
    external: {
      api: 'openai-completions',
      apiKey: 'public',
      baseUrl: 'https://example.invalid/v1',
      models: [{ id: 'demo/external', name: 'external' }],
    },
  },
}

describe('prepareManagedExecutorEnv', () => {
  it('Pi：每次执行独立 HOME/TMPDIR，模型配置只保留本机网关 provider', async () => {
    const rootBase = await tempRoot()
    const prepared = await prepareManagedExecutorEnv({
      harness: 'pi',
      model: 'demo/model',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      piModels: PI_MODELS,
      rootBase,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    cleanups.push(() => prepared.value.dispose())

    expect(prepared.value.home.startsWith('/tmp/')).toBe(true)
    expect(prepared.value.env.HOME).toBe(prepared.value.home)
    expect(prepared.value.env.TMPDIR).toBe(prepared.value.tmpdir)
    expect(prepared.value.env.KEEL_GITHUB_TOKEN).toBeUndefined()
    expect(prepared.value.env.GITHUB_TOKEN).toBeUndefined()
    expect(prepared.value.env.SSH_AUTH_SOCK).toBeUndefined()
    expect(findExecutorEnvViolations(prepared.value.env)).toEqual([])

    const models = JSON.parse(
      await readFile(join(prepared.value.home, '.pi', 'agent', 'models.json'), 'utf8'),
    ) as { providers: Record<string, unknown> }
    expect(Object.keys(models.providers)).toEqual(['magpie'])
    expect(JSON.stringify(models)).not.toContain('sentinel')

    const gitconfig = await readFile(join(prepared.value.home, '.gitconfig'), 'utf8')
    expect(gitconfig).toContain('helper =')
    expect(gitconfig).not.toContain('GITHUB_TOKEN')
  })

  it('Pi：拒绝外网 baseUrl 与真实 key', async () => {
    const rootBase = await tempRoot()
    const external = await prepareManagedExecutorEnv({
      harness: 'pi',
      model: 'demo/external',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      piModels: PI_MODELS,
      rootBase,
    })
    expect(external.ok).toBe(false)
    if (external.ok) return
    expect(external.error.detail).toMatch(/本机网关/)

    const realKey = await prepareManagedExecutorEnv({
      harness: 'pi',
      model: 'demo/model',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      piModels: {
        providers: {
          magpie: {
            ...PI_MODELS.providers.magpie,
            apiKey: 'sk-real-secret-must-not-be-copied',
          },
        },
      },
      rootBase,
    })
    expect(realKey.ok).toBe(false)
    if (realKey.ok) return
    expect(realKey.error.detail).toMatch(/apiKey/)
  })

  it('Claude：只复制本机网关 env，不复制宿主会话或 GitHub 凭据', async () => {
    const rootBase = await tempRoot()
    const prepared = await prepareManagedExecutorEnv({
      harness: 'claude',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      claudeSettings: {
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
          ANTHROPIC_AUTH_TOKEN: 'magpie',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto/deepseek-v4.1-flash:max',
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
          GITHUB_TOKEN: 'sentinel-must-not-copy',
        },
      },
      rootBase,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    cleanups.push(() => prepared.value.dispose())

    const settings = JSON.parse(
      await readFile(join(prepared.value.home, '.claude', 'settings.json'), 'utf8'),
    ) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3425')
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('magpie')
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toContain('deepseek')
    expect(settings.env.GITHUB_TOKEN).toBeUndefined()
    expect(JSON.stringify(settings)).not.toContain('sentinel')
  })

  it('Claude：拒绝非本机网关地址', async () => {
    const rootBase = await tempRoot()
    const prepared = await prepareManagedExecutorEnv({
      harness: 'claude',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      claudeSettings: {
        env: {
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          ANTHROPIC_AUTH_TOKEN: 'magpie',
        },
      },
      rootBase,
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.error.detail).toMatch(/本机网关/)
  })

  it('OMP：只复制选中的本机网关 provider，拒绝 keychain 命令', async () => {
    const rootBase = await tempRoot()
    const ompModels = [
      'providers:',
      '  magpie:',
      '    api: openai-completions',
      '    apiKey: magpie',
      '    baseUrl: http://127.0.0.1:3425/v1',
      '    models:',
      '      - id: demo/model',
      '        name: demo',
      '  external:',
      '    api: openai-completions',
      '    apiKey: "!security find-generic-password -w"',
      '    baseUrl: https://example.invalid/v1',
      '    models:',
      '      - id: demo/external',
      '        name: external',
      '',
    ].join('\n')

    const prepared = await prepareManagedExecutorEnv({
      harness: 'omp',
      model: 'magpie/demo/model',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      ompModels,
      rootBase,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    cleanups.push(() => prepared.value.dispose())

    const written = await readFile(join(prepared.value.home, '.omp', 'agent', 'models.yml'), 'utf8')
    expect(written).toContain('magpie:')
    expect(written).not.toContain('external:')
    expect(written).not.toContain('security find-generic-password')

    const rejected = await prepareManagedExecutorEnv({
      harness: 'omp',
      model: 'external/demo/external',
      sourceEnv: sourceEnv(),
      hostHome: join(rootBase, 'host'),
      ompModels,
      rootBase,
    })
    expect(rejected.ok).toBe(false)
    if (rejected.ok) return
    expect(rejected.error.detail).toMatch(/本机网关|keychain/)
  })

  it('拒绝 /tmp 之外的执行根目录', async () => {
    const prepared = await prepareManagedExecutorEnv({
      harness: 'pi',
      model: 'demo/model',
      sourceEnv: sourceEnv(),
      piModels: PI_MODELS,
      rootBase: '/var/tmp',
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.error.detail).toMatch(/\/tmp/)
  })
})
