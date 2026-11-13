import { posix } from 'node:path'

export const EXECUTOR_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'NO_COLOR',
] as const

const FORBIDDEN_ENV_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY|COOKIE|SESSION|AUTH|ASKPASS)(?:_|$)|(?:^|_)GITHUB(?:_|$)|^GH_|^SSH_/i
const REQUIRED_EXECUTOR_ENV_KEYS = ['HOME', 'TMPDIR'] as const

export interface ExecutorEnvOptions {
  readonly home?: string
  readonly tmpdir?: string
}

export function isForbiddenExecutorEnvKey(key: string): boolean {
  return FORBIDDEN_ENV_KEY.test(key)
}

export function buildExecutorEnv(
  source: NodeJS.ProcessEnv,
  options: ExecutorEnvOptions = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of EXECUTOR_ENV_ALLOWLIST) {
    if (isForbiddenExecutorEnvKey(key)) continue
    const value = source[key]
    if (value !== undefined && value.trim() !== '') env[key] = value
  }
  if (options.home !== undefined) {
    assertTmpPath(options.home, 'home', false)
    env.HOME = options.home
    env.KEEL_HOME = posix.join(options.home, '.keel')
  }
  if (options.tmpdir !== undefined) {
    assertTmpPath(options.tmpdir, 'tmpdir', true)
    env.TMPDIR = options.tmpdir
  }
  const violations = findExecutorEnvViolations(env)
  if (violations.length > 0) {
    throw new Error(`执行器环境无效：${violations.join('; ')}`)
  }
  return env
}

export function findExecutorEnvViolations(env: NodeJS.ProcessEnv): readonly string[] {
  const allowed = new Set<string>([...EXECUTOR_ENV_ALLOWLIST, 'HOME', 'TMPDIR', 'KEEL_HOME'])
  const violations: string[] = []
  const presentKeys = new Set<string>()

  for (const [key, value] of Object.entries(env)) {
    presentKeys.add(key)
    if (isForbiddenExecutorEnvKey(key)) {
      violations.push(`${key}：凭据或宿主会话变量不得进入执行器`)
      continue
    }
    if (!allowed.has(key)) {
      violations.push(`${key}：不在执行器 allowlist`)
      continue
    }
    if (value === undefined || value.trim() === '') {
      violations.push(`${key}：不能为空`)
      continue
    }
    if ((key === 'HOME' || key === 'TMPDIR') && !isTmpPath(value, key === 'TMPDIR')) {
      violations.push(`${key}：必须位于容器 /tmp`)
    }
    if (key === 'KEEL_HOME' && value !== posix.join(env.HOME ?? '', '.keel')) {
      violations.push('KEEL_HOME：必须使用隔离 HOME 下的 .keel')
    }
  }

  for (const key of REQUIRED_EXECUTOR_ENV_KEYS) {
    if (!presentKeys.has(key)) {
      violations.push(`${key}：必须显式提供，且位于容器 /tmp`)
    }
  }

  return violations
}

function assertTmpPath(value: string, field: string, allowRoot: boolean): void {
  if (!isTmpPath(value, allowRoot)) {
    throw new Error(`${field} 必须是容器 /tmp 下路径：${value}`)
  }
}

function isTmpPath(value: string, allowRoot: boolean): boolean {
  return (
    posix.isAbsolute(value) &&
    (allowRoot ? value === '/tmp' || value.startsWith('/tmp/') : value.startsWith('/tmp/')) &&
    !value.split('/').includes('..')
  )
}
