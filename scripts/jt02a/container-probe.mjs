import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const config = JSON.parse(process.argv[2] ?? '{}')
const checks = []
const add = (id, pass, detail) => checks.push({ id, pass, detail })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs ?? 5000,
  })
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? null,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: Buffer.byteLength(result.stderr ?? ''),
  }
}

function failed(result) {
  return result.status !== 0
}

function summary(result) {
  return `status=${String(result.status)} signal=${String(result.signal)} error=${String(
    result.error,
  )} stdout_bytes=${result.stdoutBytes} stderr_bytes=${result.stderrBytes}`
}

function mountInfo(target) {
  const line = readFileSync('/proc/mounts', 'utf8')
    .split('\n')
    .find((entry) => entry.split(/\s+/)[1] === target)
  if (line === undefined) return null
  const fields = line.split(/\s+/)
  return {
    source: fields[0] ?? '',
    type: fields[2] ?? '',
    options: (fields[3] ?? '').split(','),
  }
}

const expectedKeys = Object.keys(config.expectedEnv).sort()
const actualKeys = Object.keys(process.env).sort()
const exactEnv =
  expectedKeys.length === actualKeys.length &&
  expectedKeys.every(
    (key, index) => key === actualKeys[index] && process.env[key] === config.expectedEnv[key],
  )
add(
  'env-exact-allowlist',
  exactEnv,
  `expected=${expectedKeys.join(',')} actual=${actualKeys.join(',')}`,
)

const forbiddenPresent = config.forbiddenEnvKeys.filter((key) => Object.hasOwn(process.env, key))
add(
  'credential-env-absent',
  forbiddenPresent.length === 0,
  forbiddenPresent.length === 0 ? 'none' : `present=${forbiddenPresent.join(',')}`,
)

const credentialLike =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY|COOKIE|SESSION|AUTH|ASKPASS)(?:_|$)|(?:^|_)GITHUB(?:_|$)|^GH_|^SSH_/i
const suspected = actualKeys.filter((key) => credentialLike.test(key))
add(
  'no-credential-like-env',
  suspected.length === 0,
  suspected.length === 0 ? 'none' : `present=${suspected.join(',')}`,
)

const forbiddenValues = Array.isArray(config.forbiddenEnvValues) ? config.forbiddenEnvValues : []
const actualValues = Object.values(process.env).filter((value) => typeof value === 'string')
const leakedCanaries = forbiddenValues.filter(
  (value) => typeof value === 'string' && actualValues.some((actual) => actual.includes(value)),
)
const sshKeys = actualKeys.filter((key) => /(?:^|_)SSH(?:_|$)/i.test(key))
const githubKeys = actualKeys.filter((key) => /(?:^|_)GITHUB(?:_|$)|^GH_/i.test(key))
const tokenKeys = actualKeys.filter((key) =>
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_KEY|PRIVATE_KEY|COOKIE|SESSION|AUTH|ASKPASS)(?:_|$)/i.test(
    key,
  ),
)
add(
  'environment-dump-canary-absent',
  leakedCanaries.length === 0 && tokenKeys.length === 0,
  `canary_matches=${leakedCanaries.length} token_keys=${tokenKeys.join(',')}`,
)
add(
  'environment-dump-ssh-absent',
  sshKeys.length === 0,
  sshKeys.length === 0 ? 'none' : `present=${sshKeys.join(',')}`,
)
add(
  'environment-dump-github-absent',
  githubKeys.length === 0,
  githubKeys.length === 0 ? 'none' : `present=${githubKeys.join(',')}`,
)

const uid = typeof process.getuid === 'function' ? process.getuid() : null
const gid = typeof process.getgid === 'function' ? process.getgid() : null
add('non-root', uid !== null && uid !== 0 && gid !== null && gid !== 0, `uid=${uid} gid=${gid}`)

let homeOk = false
try {
  mkdirSync(process.env.HOME, { recursive: true })
  homeOk = realpathSync(process.env.HOME) === '/tmp/home'
} catch {
  homeOk = false
}
add('isolated-home', homeOk, `HOME=${String(process.env.HOME)}`)

const tmpMount = mountInfo('/tmp')
add(
  'tmpfs-tmp',
  tmpMount?.type === 'tmpfs' &&
    ['rw', 'noexec', 'nosuid', 'nodev'].every((option) => tmpMount.options.includes(option)),
  tmpMount === null ? 'missing' : `type=${tmpMount.type} options=${tmpMount.options.join(',')}`,
)

const workspaceMount = mountInfo('/workspace')
add(
  'workspace-readonly-mount',
  workspaceMount?.options.includes('ro') === true,
  workspaceMount === null ? 'missing' : `options=${workspaceMount.options.join(',')}`,
)

let workspaceReadable = false
try {
  workspaceReadable = readFileSync('/workspace/README.md', 'utf8').includes('JT-02A')
} catch {
  workspaceReadable = false
}
const gitStatus = run('git', [
  '-c',
  'safe.directory=/workspace',
  '-C',
  '/workspace',
  'status',
  '--porcelain',
])
add(
  'workspace-readable-control',
  workspaceReadable && gitStatus.status === 0,
  `readme=${workspaceReadable} git=${summary(gitStatus)}`,
)

let writeDenied = false
try {
  writeFileSync('/workspace/.jt02a-write-probe', 'should-not-exist', { flag: 'wx' })
  try {
    unlinkSync('/workspace/.jt02a-write-probe')
  } catch {}
} catch {
  writeDenied = true
}
add('workspace-write-denied', writeDenied, writeDenied ? 'denied' : 'write succeeded')

const ghConfig = join(process.env.HOME, '.config', 'gh')
add(
  'gh-config-absent',
  !existsSync(ghConfig) && !existsSync('/root/.config/gh'),
  `home_config=${existsSync(ghConfig)} root_config=${existsSync('/root/.config/gh')}`,
)

const ghControl = run('gh', ['--version'])
add('gh-version-control', ghControl.status === 0, summary(ghControl))

const ghToken = run('gh', ['auth', 'token'])
add('gh-auth-token-denied', failed(ghToken) && ghToken.stdoutBytes === 0, summary(ghToken))

const gitControl = run('git', ['--version'])
add('git-version-control', gitControl.status === 0, summary(gitControl))

const gitPush = run(
  'git',
  [
    '-c',
    'safe.directory=/workspace',
    '-c',
    'credential.helper=',
    '-C',
    '/workspace',
    'push',
    'origin',
    'HEAD:refs/heads/jt02a-probe',
  ],
  { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 8000 },
)
add('git-push-denied', failed(gitPush), summary(gitPush))

const curlControl = run('curl', ['--version'])
add('curl-version-control', curlControl.status === 0, summary(curlControl))

const githubApi = run(
  'curl',
  ['--fail', '--silent', '--show-error', '--max-time', '5', 'https://api.github.com/user'],
  { timeoutMs: 7000 },
)
add('github-api-denied', failed(githubApi), summary(githubApi))

const routes = readFileSync('/proc/net/route', 'utf8')
  .split('\n')
  .slice(1)
  .filter((line) => line.trim() !== '')
const defaultRoutes = routes.filter((line) => line.split(/\s+/)[1] === '00000000')
add('no-default-route', defaultRoutes.length === 0, `default_routes=${defaultRoutes.length}`)

const protectedMounts = ['/root', '/home', '/Users']
const visibleProtectedMounts = protectedMounts.filter((target) => mountInfo(target) !== null)
add(
  'no-host-config-mount',
  visibleProtectedMounts.length === 0,
  visibleProtectedMounts.length === 0 ? 'none' : `mounts=${visibleProtectedMounts.join(',')}`,
)

const passed = checks.every((check) => check.pass)
process.stdout.write(
  `${JSON.stringify({
    schema_version: 1,
    probe: 'jt02a-container',
    node_version: process.version,
    passed,
    checks,
    environment_dump: {
      keys: actualKeys,
      canary_value_matches: leakedCanaries.length,
      ssh_key_matches: sshKeys,
      github_key_matches: githubKeys,
      credential_key_matches: suspected,
    },
  })}\n`,
)
process.exit(passed ? 0 : 1)
