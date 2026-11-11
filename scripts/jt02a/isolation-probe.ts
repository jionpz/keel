#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findIsolationViolations,
  type IsolatedContainerSpec,
  type IsolationPolicy,
  inspectWorkspaceIsolation,
} from '../../src/execution/isolation/container-spec.js'
import {
  buildExecutorEnv,
  isForbiddenExecutorEnvKey,
} from '../../src/execution/isolation/executor-env.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '../..')
const IMAGE = 'keel-jt02a-isolation:gh-2.96.0'
const GH_VERSION = '2.96.0'
const GITHUB_REPOSITORY_URL = 'https://github.com/jionpz/keel.git'
const DOCKERFILE = join(SCRIPT_DIR, 'Dockerfile')
const CONTAINER_PROBE = readFileSync(join(SCRIPT_DIR, 'container-probe.mjs'), 'utf8')
const DOCKER_INFRASTRUCTURE_MOUNTS = new Set(['/etc/hosts', '/etc/hostname', '/etc/resolv.conf'])

interface Check {
  readonly id: string
  readonly pass: boolean
  readonly detail: string
}

interface DockerMount {
  readonly Type?: string
  readonly Source?: string
  readonly Destination?: string
  readonly RW?: boolean
}

interface DockerInspect {
  readonly Id?: string
  readonly Image?: string
  readonly Config?: {
    readonly User?: string
    readonly WorkingDir?: string
    readonly Env?: readonly string[]
    readonly Entrypoint?: readonly string[]
    readonly Cmd?: readonly string[]
  }
  readonly HostConfig?: {
    readonly NetworkMode?: string
    readonly ReadonlyRootfs?: boolean
    readonly Binds?: readonly string[] | null
    readonly Tmpfs?: Readonly<Record<string, string>>
    readonly CapAdd?: readonly string[] | null
    readonly CapDrop?: readonly string[] | null
    readonly Devices?: readonly unknown[] | null
    readonly SecurityOpt?: readonly string[] | null
    readonly PidsLimit?: number
    readonly Privileged?: boolean
  }
  readonly Mounts?: readonly DockerMount[]
}

interface ContainerProbeResult {
  readonly passed?: boolean
  readonly checks?: readonly Check[]
}

function fail(message: string): never {
  console.error(`jt02a: ${message}`)
  process.exit(1)
}

function docker(args: readonly string[], input?: string) {
  return spawnSync('docker', [...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 4 * 1024 * 1024,
  })
}

function readDocker(args: readonly string[], label: string): string {
  const result = docker(args)
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim()
    throw new Error(`${label} 失败：${detail}`)
  }
  return result.stdout.trim()
}

function parseEnv(entries: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of entries ?? []) {
    const equals = entry.indexOf('=')
    if (equals < 0) continue
    env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return env
}

function inspectChecks(
  spec: IsolatedContainerSpec,
  inspect: DockerInspect,
  workspace: string,
  policy: IsolationPolicy,
): Check[] {
  const host = inspect.HostConfig ?? {}
  const config = inspect.Config ?? {}
  const expectedEnvArgs = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`)
  const actualEnvArgs = (config.Cmd ?? []).filter((arg) => /^[A-Z_][A-Z0-9_]*=/.test(arg))
  const mounts = inspect.Mounts ?? []
  const mountedDestinations = mounts.map((mount) => mount.Destination ?? '')
  const workspaceMounts = mounts.filter((mount) => mount.Destination === '/workspace')
  const infrastructureMounts = mounts.filter((mount) =>
    DOCKER_INFRASTRUCTURE_MOUNTS.has(mount.Destination ?? ''),
  )
  const invalidInfrastructureMounts = infrastructureMounts.filter(
    (mount) => !isDockerGeneratedInfrastructureMount(mount, inspect.Id ?? ''),
  )
  const unexpectedMounts = mounts.filter((mount) => {
    const destination = mount.Destination ?? ''
    if (destination === '/workspace') return false
    if (DOCKER_INFRASTRUCTURE_MOUNTS.has(destination)) return false
    if (destination === '/tmp' && mount.Type === 'tmpfs') return false
    return true
  })
  const outsideWorkspaceBinds = mounts.filter(
    (mount) => mount.Type === 'bind' && !DOCKER_INFRASTRUCTURE_MOUNTS.has(mount.Destination ?? ''),
  )
  const protectedMounts = mounts.filter((mount) => {
    if (mount.Destination === '/workspace' && mount.Source === workspace) return false
    const source = mount.Source ?? ''
    return [policy.hostHome, policy.hostGhConfig, policy.hostSshDir, policy.dockerSocket].some(
      (protectedPath) => source === protectedPath || source.startsWith(`${protectedPath}/`),
    )
  })
  const forbiddenEnv = Object.keys(parseEnv(config.Env)).filter(isForbiddenExecutorEnvKey)

  return [
    {
      id: 'network-none',
      pass: host.NetworkMode === 'none',
      detail: `NetworkMode=${String(host.NetworkMode)}`,
    },
    {
      id: 'readonly-rootfs',
      pass: host.ReadonlyRootfs === true,
      detail: `ReadonlyRootfs=${String(host.ReadonlyRootfs)}`,
    },
    {
      id: 'non-root-user',
      pass: config.User === spec.user,
      detail: `User=${String(config.User)}`,
    },
    {
      id: 'workspace-workdir',
      pass: config.WorkingDir === '/workspace',
      detail: `WorkingDir=${String(config.WorkingDir)}`,
    },
    {
      id: 'workspace-mount-exact',
      pass:
        workspaceMounts.length === 1 &&
        outsideWorkspaceBinds.length === 1 &&
        workspaceMounts[0]?.Type === 'bind' &&
        workspaceMounts[0]?.Source === workspace &&
        workspaceMounts[0]?.RW === false,
      detail: `workspace_mounts=${workspaceMounts.length} task_binds=${outsideWorkspaceBinds.length} type=${String(
        workspaceMounts[0]?.Type,
      )} readonly=${String(workspaceMounts[0]?.RW === false)}`,
    },
    {
      id: 'no-dangerous-mount',
      pass:
        unexpectedMounts.length === 0 &&
        invalidInfrastructureMounts.length === 0 &&
        protectedMounts.length === 0,
      detail:
        unexpectedMounts.length === 0 &&
        invalidInfrastructureMounts.length === 0 &&
        protectedMounts.length === 0
          ? `mounts=${mountedDestinations.join(',')}`
          : `unexpected=${unexpectedMounts.map((mount) => mount.Destination ?? '').join(',')} invalid_infra=${invalidInfrastructureMounts.length} protected=${protectedMounts.length}`,
    },
    {
      id: 'docker-infrastructure-mounts-exact',
      pass: invalidInfrastructureMounts.length === 0,
      detail:
        infrastructureMounts.length === 0
          ? 'none'
          : `targets=${infrastructureMounts
              .map((mount) => mount.Destination ?? '')
              .join(',')} invalid=${invalidInfrastructureMounts.length}`,
    },
    {
      id: 'tmp-tmpfs',
      pass: host.Tmpfs?.['/tmp'] === 'rw,noexec,nosuid,nodev',
      detail: `Tmpfs=${String(host.Tmpfs?.['/tmp'])}`,
    },
    {
      id: 'cap-add-none',
      pass: (host.CapAdd ?? []).length === 0,
      detail: `CapAdd=${(host.CapAdd ?? []).join(',')}`,
    },
    {
      id: 'cap-drop-all',
      pass: (host.CapDrop ?? []).includes('ALL'),
      detail: `CapDrop=${(host.CapDrop ?? []).join(',')}`,
    },
    {
      id: 'devices-none',
      pass: (host.Devices ?? []).length === 0,
      detail: `Devices=${(host.Devices ?? []).length}`,
    },
    {
      id: 'binds-none',
      pass: (host.Binds ?? []).length === 0,
      detail: `Binds=${(host.Binds ?? []).join(',')}`,
    },
    {
      id: 'no-new-privileges',
      pass: (host.SecurityOpt ?? []).includes('no-new-privileges:true'),
      detail: `SecurityOpt=${(host.SecurityOpt ?? []).join(',')}`,
    },
    {
      id: 'pids-limit',
      pass: host.PidsLimit === spec.pidsLimit,
      detail: `PidsLimit=${String(host.PidsLimit)}`,
    },
    {
      id: 'not-privileged',
      pass: host.Privileged === false,
      detail: `Privileged=${String(host.Privileged)}`,
    },
    {
      id: 'env-args-exact',
      pass:
        actualEnvArgs.length === expectedEnvArgs.length &&
        expectedEnvArgs.every((entry) => actualEnvArgs.includes(entry)),
      detail: `expected=${expectedEnvArgs.length} actual=${actualEnvArgs.length}`,
    },
    {
      id: 'no-credential-env',
      pass: forbiddenEnv.length === 0,
      detail: forbiddenEnv.length === 0 ? 'none' : `present=${forbiddenEnv.join(',')}`,
    },
  ]
}

function isDockerGeneratedInfrastructureMount(mount: DockerMount, containerId: string): boolean {
  if (containerId === '' || mount.Type !== 'bind' || mount.RW !== false) return false
  const destination = mount.Destination ?? ''
  const name = destination.slice(destination.lastIndexOf('/') + 1)
  const source = mount.Source ?? ''
  return source.includes(`/containers/${containerId}/`) && source.endsWith(`/${name}`)
}

function redactedSpec(spec: IsolatedContainerSpec) {
  return {
    ...spec,
    workspace: '<evidence>/workspace',
    mounts: spec.mounts.map((mount) => ({ ...mount, source: '<evidence>/workspace' })),
  }
}

function writeEvidence(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<number> {
  const dockerVersion = docker(['version', '--format', '{{.Server.Version}}'])
  if (dockerVersion.error !== undefined || dockerVersion.status !== 0) {
    fail(
      `Docker 不可用，无法执行 JT-02A 隔离探针：${
        dockerVersion.error?.message ?? dockerVersion.stderr.trim()
      }`,
    )
  }

  const build = spawnSync(
    'docker',
    ['build', '--build-arg', `GH_VERSION=${GH_VERSION}`, '-t', IMAGE, '-f', DOCKERFILE, SCRIPT_DIR],
    { stdio: 'inherit' },
  )
  if (build.error !== undefined || build.status !== 0) {
    fail(`隔离探针镜像构建失败：${build.error?.message ?? `exit ${String(build.status)}`}`)
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const evidenceDir = join(ROOT, '.keel', 'jt02a-isolation', stamp)
  const evidencePath = join(evidenceDir, 'probe.json')
  const workspace = join(evidenceDir, 'workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o755 })
  chmodSync(evidenceDir, 0o755)
  chmodSync(workspace, 0o755)

  writeFileSync(
    join(workspace, 'README.md'),
    '# JT-02A 隔离探针夹具\n\n只读工作区，用于验证环境、凭据、文件系统与网络边界。\n',
    { encoding: 'utf8', mode: 0o644 },
  )
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  for (const args of [
    ['init', '-q', '-b', 'main', workspace],
    ['-C', workspace, 'config', 'user.name', 'JT-02A Probe'],
    ['-C', workspace, 'config', 'user.email', 'jt02a-probe@example.invalid'],
    ['-C', workspace, 'add', 'README.md'],
    ['-C', workspace, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture'],
    ['-C', workspace, 'remote', 'add', 'origin', GITHUB_REPOSITORY_URL],
  ] as const) {
    const result = spawnSync('git', [...args], {
      encoding: 'utf8',
      env: gitEnv,
    })
    if (result.error !== undefined || result.status !== 0) {
      fail(`构造测试工作区失败：${result.error?.message ?? result.stderr.trim()}`)
    }
  }

  const workspaceReal = realpathSync(workspace)
  const sourceEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    HOME: homedir(),
    TMPDIR: '/var/folders/jt02a-probe',
    KEEL_GITHUB_TOKEN: 'jt02a-sentinel-not-a-token',
    GITHUB_TOKEN: 'jt02a-sentinel-not-a-token',
    GH_TOKEN: 'jt02a-sentinel-not-a-token',
    GH_ENTERPRISE_TOKEN: 'jt02a-sentinel-not-a-token',
    GITHUB_ENTERPRISE_TOKEN: 'jt02a-sentinel-not-a-token',
    ANTHROPIC_API_KEY: 'jt02a-sentinel-not-a-key',
    ANTHROPIC_AUTH_TOKEN: 'jt02a-sentinel-not-a-token',
    OPENAI_API_KEY: 'jt02a-sentinel-not-a-key',
    AWS_SECRET_ACCESS_KEY: 'jt02a-sentinel-not-a-secret',
    NPM_TOKEN: 'jt02a-sentinel-not-a-token',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'jt02a-sentinel-session',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/jt02a-sentinel.sock',
    CODEX_THREAD_ID: 'jt02a-sentinel-session',
    PI_AGENT_DIR: join(homedir(), '.pi', 'agent'),
    OMP_HOME: join(homedir(), '.omp'),
    XDG_CONFIG_HOME: join(homedir(), '.config'),
    SSH_AUTH_SOCK: '/tmp/jt02a-sentinel-agent.sock',
    GIT_ASKPASS: '/usr/local/bin/gh',
  }
  const env = buildExecutorEnv(sourceEnv, { home: '/tmp/home', tmpdir: '/tmp' })
  const policy: IsolationPolicy = {
    hostHome: homedir(),
    hostGhConfig: join(homedir(), '.config', 'gh'),
    hostSshDir: join(homedir(), '.ssh'),
    dockerSocket: '/var/run/docker.sock',
  }
  const spec: IsolatedContainerSpec = {
    image: IMAGE,
    workspace: workspaceReal,
    workdir: '/workspace',
    user: '65534:65534',
    network: 'none',
    readOnlyRoot: true,
    mounts: [{ source: workspaceReal, target: '/workspace', readOnly: true }],
    tmpfs: [{ target: '/tmp', options: ['rw', 'noexec', 'nosuid', 'nodev'] }],
    capDrop: ['ALL'],
    noNewPrivileges: true,
    pidsLimit: 64,
    env,
  }
  const violations = [
    ...findIsolationViolations(spec, policy),
    ...(await inspectWorkspaceIsolation(workspaceReal, policy)),
  ]
  if (violations.length > 0) {
    fail(
      `隔离规格未通过门禁：${violations.map((item) => `${item.code}(${item.detail})`).join('; ')}`,
    )
  }

  const containerName = `keel-jt02a-${process.pid}-${Date.now()}`
  const probeConfig = {
    expectedEnv: env,
    forbiddenEnvKeys: Object.keys(sourceEnv).filter(isForbiddenExecutorEnvKey),
    forbiddenEnvValues: [
      ...new Set(
        Object.entries(sourceEnv)
          .filter(([key]) => isForbiddenExecutorEnvKey(key))
          .map(([, value]) => value)
          .filter((value): value is string => value !== undefined && value !== ''),
      ),
    ],
  }
  const create = docker([
    'create',
    '--name',
    containerName,
    '--interactive',
    '--network',
    spec.network,
    '--user',
    spec.user,
    '--workdir',
    spec.workdir,
    '--read-only',
    '--tmpfs',
    `/tmp:${spec.tmpfs[0]?.options.join(',') ?? ''}`,
    '--mount',
    `type=bind,src=${workspaceReal},dst=/workspace,readonly`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    String(spec.pidsLimit),
    '--entrypoint',
    '/usr/bin/env',
    IMAGE,
    '-i',
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    'node',
    '--input-type=module',
    '-',
    JSON.stringify(probeConfig),
  ])
  if (create.error !== undefined || create.status !== 0) {
    fail(`创建隔离容器失败：${create.error?.message ?? create.stderr.trim()}`)
  }

  let started: ReturnType<typeof docker> | undefined
  let inspect: DockerInspect = {}
  let inspectError = ''
  let probe: ContainerProbeResult = {}
  let startSummary = ''
  let hostChecks: Check[] = []

  try {
    started = docker(['start', '--attach', '--interactive', containerName], CONTAINER_PROBE)
    startSummary = `status=${String(started.status)} error=${
      started.error?.message ?? 'none'
    } stdout_bytes=${Buffer.byteLength(started.stdout ?? '')} stderr_bytes=${Buffer.byteLength(
      started.stderr ?? '',
    )}`
    try {
      probe = JSON.parse(started.stdout.trim()) as ContainerProbeResult
    } catch {
      probe = {}
    }

    const inspectText = readDocker(['inspect', containerName], '检查容器配置')
    const parsed = JSON.parse(inspectText) as DockerInspect[]
    inspect = parsed[0] ?? {}
    hostChecks = inspectChecks(spec, inspect, workspaceReal, policy)
    if (hostChecks.some((check) => !check.pass)) inspectError = '宿主配置检查失败'
  } catch (error) {
    inspectError = error instanceof Error ? error.message : String(error)
  } finally {
    docker(['rm', '--force', containerName])
  }

  const containerChecks = probe.checks ?? []
  const checks = [...hostChecks, ...containerChecks]
  const passed =
    started?.status === 0 &&
    probe.passed === true &&
    containerChecks.length > 0 &&
    hostChecks.every((check) => check.pass) &&
    inspectError === ''
  const evidence = {
    schema_version: 1,
    task: 'JT-02A',
    generated_at: new Date().toISOString(),
    result: passed ? 'pass' : 'fail',
    image: { ref: IMAGE, gh_version: GH_VERSION, id: inspect.Image ?? null },
    isolation_spec: redactedSpec(spec),
    docker: {
      server_version: dockerVersion.stdout.trim(),
      container_id: inspect.Id ?? null,
      start: startSummary,
      inspect: {
        network_mode: inspect.HostConfig?.NetworkMode ?? null,
        readonly_rootfs: inspect.HostConfig?.ReadonlyRootfs ?? null,
        user: inspect.Config?.User ?? null,
        working_dir: inspect.Config?.WorkingDir ?? null,
        mount_count: inspect.Mounts?.length ?? 0,
        workspace_mount_readonly:
          (inspect.Mounts ?? []).find((mount) => mount.Destination === '/workspace')?.RW === false,
        tmpfs: inspect.HostConfig?.Tmpfs ?? null,
        cap_drop: inspect.HostConfig?.CapDrop ?? [],
        cap_add: inspect.HostConfig?.CapAdd ?? [],
        devices: inspect.HostConfig?.Devices?.length ?? 0,
        binds: inspect.HostConfig?.Binds ?? [],
        security_opt: inspect.HostConfig?.SecurityOpt ?? [],
        pids_limit: inspect.HostConfig?.PidsLimit ?? null,
        privileged: inspect.HostConfig?.Privileged ?? null,
        mount_destinations: (inspect.Mounts ?? []).map((mount) => mount.Destination ?? ''),
        env_keys: Object.keys(parseEnv(inspect.Config?.Env)).sort(),
      },
      inspect_error: inspectError === '' ? null : inspectError,
    },
    checks,
    container_probe: probe,
  }
  writeEvidence(evidencePath, evidence)

  console.log(`JT-02A isolation probe: ${passed ? 'PASS' : 'FAIL'}`)
  console.log(`evidence: ${relative(ROOT, evidencePath)}`)
  if (!passed) {
    for (const check of checks.filter((item) => !item.pass)) {
      console.error(`- ${check.id}: ${check.detail}`)
    }
  }
  return passed ? 0 : 1
}

process.exit(await main())
