import { describe, expect, it } from 'vitest'
import {
  buildExecutorEnv,
  EXECUTOR_ENV_ALLOWLIST,
  findExecutorEnvViolations,
  isForbiddenExecutorEnvKey,
} from './executor-env.js'

const SOURCE: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  TERM: 'dumb',
  NO_COLOR: '1',
  HOME: '/Users/operator',
  TMPDIR: '/var/folders/operator',
  KEEL_GITHUB_TOKEN: 'sentinel-keel',
  GITHUB_TOKEN: 'sentinel-github',
  GH_TOKEN: 'sentinel-gh',
  GH_ENTERPRISE_TOKEN: 'sentinel-gh-enterprise',
  GITHUB_ENTERPRISE_TOKEN: 'sentinel-github-enterprise',
  ANTHROPIC_API_KEY: 'sentinel-anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sentinel-auth',
  OPENAI_API_KEY: 'sentinel-openai',
  AWS_SECRET_ACCESS_KEY: 'sentinel-aws',
  NPM_TOKEN: 'sentinel-npm',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'sentinel-claude-session',
  CODEX_THREAD_ID: 'sentinel-codex-session',
  PI_AGENT_DIR: '/Users/operator/.pi/agent',
  OMP_HOME: '/Users/operator/.omp',
  XDG_CONFIG_HOME: '/Users/operator/.config',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  GIT_ASKPASS: '/usr/local/bin/gh',
}

describe('buildExecutorEnv', () => {
  it('只保留 allowlist 与显式注入的 HOME、TMPDIR，不继承凭据或宿主会话变量', () => {
    const env = buildExecutorEnv(SOURCE, {
      home: '/tmp/executor-home',
      tmpdir: '/tmp',
    })

    expect(env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'dumb',
      NO_COLOR: '1',
      HOME: '/tmp/executor-home',
      TMPDIR: '/tmp',
    })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
  })

  it('未显式提供 HOME 与 TMPDIR 时拒绝构造 PATH-only 环境', () => {
    expect(() => buildExecutorEnv(SOURCE)).toThrow(/HOME/)
    expect(() => buildExecutorEnv(SOURCE, { home: '/tmp/executor-home' })).toThrow(/TMPDIR/)
  })

  it('HOME 与 TMPDIR 显式注入且不改输入', () => {
    const before = { ...SOURCE }
    const env = buildExecutorEnv(SOURCE, {
      home: '/tmp/executor-home',
      tmpdir: '/tmp',
    })

    expect(env.HOME).toBe('/tmp/executor-home')
    expect(env.TMPDIR).toBe('/tmp')
    expect(SOURCE).toEqual(before)
  })

  it('拒绝相对路径作为容器 HOME', () => {
    expect(() => buildExecutorEnv(SOURCE, { home: 'relative/home' })).toThrow(/\/tmp/)
    expect(() => buildExecutorEnv(SOURCE, { home: '/Users/operator' })).toThrow(/\/tmp/)
  })
})

describe('isForbiddenExecutorEnvKey', () => {
  it.each([
    'KEEL_GITHUB_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'SSH_AUTH_SOCK',
    'GIT_ASKPASS',
    'CLAUDE_CODE_SESSION_ID',
  ])('拒绝 %s', (key) => {
    expect(isForbiddenExecutorEnvKey(key)).toBe(true)
  })

  it('allowlist 自身不命中危险模式', () => {
    expect(EXECUTOR_ENV_ALLOWLIST.filter(isForbiddenExecutorEnvKey)).toEqual([])
  })
})

describe('findExecutorEnvViolations', () => {
  it('拒绝缺少 HOME 或 TMPDIR 的 PATH-only 环境', () => {
    const violations = findExecutorEnvViolations({ PATH: '/usr/bin' })
    expect(violations.some((message) => message.includes('HOME'))).toBe(true)
    expect(violations.some((message) => message.includes('TMPDIR'))).toBe(true)
  })

  it('接受 sanitized env 与显式容器路径', () => {
    const env = buildExecutorEnv(SOURCE, {
      home: '/tmp/executor-home',
      tmpdir: '/tmp',
    })
    expect(findExecutorEnvViolations(env)).toEqual([])
  })

  it('拒绝泄漏的凭据、宿主会话变量与宿主 HOME', () => {
    const violations = findExecutorEnvViolations({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'sentinel',
      CLAUDECODE: '1',
      HOME: '/Users/operator',
    })

    expect(violations.some((v) => v.includes('GITHUB_TOKEN'))).toBe(true)
    expect(violations.some((v) => v.includes('CLAUDECODE'))).toBe(true)
    expect(violations.some((v) => v.includes('HOME'))).toBe(true)
  })
})
