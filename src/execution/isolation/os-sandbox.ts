import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'

export type OsSandboxBackend = 'macos-sandbox-exec'

export interface ManagedOsSandbox {
  readonly backend: OsSandboxBackend
  readonly executable: string
  readonly profilePath: string
  /** 传给 sandbox-exec 的前缀参数；adapter 再把真实 bin/argv 接在后面。 */
  readonly prefixArgs: readonly string[]
}

export interface PrepareOsSandboxOptions {
  readonly workspace: string
  readonly root: string
  readonly home: string
  readonly tmpdir: string
  readonly hostHome?: string
  readonly networkPorts?: readonly number[]
  readonly platform?: NodeJS.Platform
  readonly executable?: string
}

export interface MacSandboxProfileOptions {
  readonly root: string
  readonly home: string
  readonly tmpdir: string
  readonly workspace: string
  readonly hostHome: string
  readonly gitDirs: readonly string[]
  readonly runtimePaths: readonly string[]
  readonly networkPorts: readonly number[]
}

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const DEFAULT_MODEL_GATEWAY_PORT = 3425

const SYSTEM_READ_PATHS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/private/etc',
  '/private/var/db/dyld',
  '/dev',
  '/opt/homebrew',
  '/usr/local',
] as const

const HOST_DENY_PATHS = [
  '/Users',
  '/Applications',
  '/Volumes',
  '/Network',
  '/opt',
  '/private/tmp',
  '/private/var/folders',
  '/private/var/tmp',
] as const

const KEYCHAIN_MACH_SERVICES = [
  'com.apple.securityd',
  'com.apple.trustd',
  'com.apple.SecurityServer',
] as const

export async function prepareManagedOsSandbox(
  options: PrepareOsSandboxOptions,
): Promise<Result<ManagedOsSandbox>> {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `managed 写执行缺少可证明的文件系统/网络沙箱：当前平台 ${platform} 尚未接入。拒绝在宿主用户权限下降级执行。`,
      ),
    )
  }

  const executable = options.executable ?? DEFAULT_SANDBOX_EXEC
  try {
    await access(executable, constants.X_OK)
  } catch {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `找不到可执行的 ${executable}；managed 写执行拒绝在无沙箱状态下运行`,
      ),
    )
  }

  try {
    const [root, home, tmpdir, workspace, hostHome] = await Promise.all([
      canonicalPath(options.root),
      canonicalPath(options.home),
      canonicalPath(options.tmpdir),
      canonicalPath(options.workspace),
      canonicalPath(options.hostHome ?? homedir()),
    ])
    const gitDirs = await resolveGitDirs(workspace)
    const runtimePaths = await resolveRuntimePaths(hostHome)
    const networkPorts = normalizePorts(options.networkPorts ?? [DEFAULT_MODEL_GATEWAY_PORT])
    const profilePath = join(options.root, 'sandbox.sb')
    const profile = buildMacSandboxProfile({
      root,
      home,
      tmpdir,
      workspace,
      hostHome,
      gitDirs,
      runtimePaths,
      networkPorts,
    })
    await writeFile(profilePath, profile, { mode: 0o400 })
    return ok({
      backend: 'macos-sandbox-exec',
      executable,
      profilePath,
      prefixArgs: ['-f', profilePath],
    })
  } catch (error) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `无法建立 managed 操作系统沙箱：${error instanceof Error ? error.message : String(error)}`,
      ),
    )
  }
}

export function buildMacSandboxProfile(options: MacSandboxProfileOptions): string {
  const rootPaths = uniquePaths([options.root, options.home, options.tmpdir, options.workspace])
  const readWritePaths = uniquePaths([...rootPaths, ...options.gitDirs])
  const readOnlyPaths = uniquePaths([...SYSTEM_READ_PATHS, ...options.runtimePaths])
  const metadataPaths = uniquePaths([
    ...rootPaths,
    ...readWritePaths,
    ...readOnlyPaths,
    ...rootPaths.flatMap((path) => ancestorsOf(path)),
    ...readWritePaths.flatMap((path) => ancestorsOf(path)),
    ...readOnlyPaths.flatMap((path) => ancestorsOf(path)),
  ])
  const ports = normalizePorts(options.networkPorts)

  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* (subpath ${sbplString(options.hostHome)}))`,
    ...HOST_DENY_PATHS.map((path) => `(deny file-read* file-write* (subpath ${sbplString(path)}))`),
    `(allow file-read-metadata ${metadataPaths.map((path) => `(literal ${sbplString(path)})`).join(' ')})`,
  ]

  if (rootPaths.some((path) => path === '/tmp' || path.startsWith('/tmp/'))) {
    lines.push('(allow file-read-data (literal "/tmp") (literal "/private/tmp"))')
  }

  for (const path of readOnlyPaths) {
    lines.push(`(allow file-read* (subpath ${sbplString(path)}))`)
  }
  for (const path of readWritePaths) {
    lines.push(`(allow file-read* file-write* (subpath ${sbplString(path)}))`)
  }

  lines.push(
    ...KEYCHAIN_MACH_SERVICES.map(
      (service) => `(deny mach-lookup (global-name ${sbplString(service)}))`,
    ),
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny file-read* (literal "/usr/bin/security"))',
    '(deny network*)',
    ...ports.map(
      (port) => `(allow network-outbound (remote ip ${sbplString(`localhost:${port}`)}))`,
    ),
  )

  return `${lines.join('\n')}\n`
}

export function sandboxCommand(
  sandbox: ManagedOsSandbox,
  bin: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: sandbox.executable,
    args: [...sandbox.prefixArgs, bin, ...args],
  }
}

async function canonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.split('/').includes('..')) {
    throw new Error(`沙箱路径必须是规范绝对路径：${path}`)
  }
  return realpath(path)
}

async function resolveGitDirs(workspace: string): Promise<readonly string[]> {
  const dotGit = join(workspace, '.git')
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(dotGit)
  } catch {
    throw new Error(`workspace 必须是 git 仓库：${workspace}`)
  }

  if (info.isDirectory()) return [await realpath(dotGit)]
  if (!info.isFile()) throw new Error(`无法识别 workspace 的 .git：${dotGit}`)

  const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'))
  if (pointer?.[1] === undefined) throw new Error(`workspace 的 .git 文件缺少 gitdir 指针`)
  const gitDir = await realpath(resolve(workspace, pointer[1]))
  const commonDir = await readCommonDir(gitDir)
  return uniquePaths([gitDir, commonDir])
}

async function readCommonDir(gitDir: string): Promise<string> {
  try {
    const pointer = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()
    return await realpath(resolve(gitDir, pointer))
  } catch {
    return gitDir
  }
}

async function resolveRuntimePaths(hostHome: string): Promise<readonly string[]> {
  const execPath = process.execPath
  const realExecPath = await realpath(execPath).catch(() => execPath)
  const execDirs = [dirname(execPath), dirname(realExecPath), dirname(dirname(realExecPath))]
  const homeRuntimePaths = [
    join(hostHome, '.nvm', 'versions'),
    join(hostHome, '.bun'),
    join(hostHome, '.local', 'bin'),
    join(hostHome, 'Library', 'pnpm'),
  ]
  const existingHomePaths = await Promise.all(
    homeRuntimePaths.map(async (path) => ((await exists(path)) ? path : undefined)),
  )
  return uniquePaths([
    ...execDirs,
    ...existingHomePaths.filter((path): path is string => path !== undefined),
  ])
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function normalizePorts(ports: readonly number[]): readonly number[] {
  const normalized = [...new Set(ports)]
  for (const port of normalized) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`沙箱网络端口无效：${port}`)
    }
  }
  return normalized
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths.filter((path) => path !== ''))]
}

function ancestorsOf(path: string): readonly string[] {
  const parts = path.split('/').filter(Boolean)
  const ancestors: string[] = ['/']
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    ancestors.push(current)
  }
  return ancestors
}

function sbplString(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('沙箱 profile 路径不能包含换行')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
