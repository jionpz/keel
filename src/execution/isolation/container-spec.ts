import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'

import { findExecutorEnvViolations } from './executor-env.js'

export interface IsolationMount {
  readonly source: string
  readonly target: string
  readonly readOnly: boolean
}

export interface IsolationTmpfs {
  readonly target: string
  readonly options: readonly string[]
}

export interface IsolatedContainerSpec {
  readonly image: string
  readonly workspace: string
  readonly workdir: string
  readonly user: string
  readonly network: string
  readonly readOnlyRoot: boolean
  readonly mounts: readonly IsolationMount[]
  readonly tmpfs: readonly IsolationTmpfs[]
  readonly capDrop: readonly string[]
  readonly noNewPrivileges: boolean
  readonly pidsLimit: number
  readonly env: NodeJS.ProcessEnv
}

export interface IsolationPolicy {
  readonly hostHome: string
  readonly hostGhConfig: string
  readonly hostSshDir: string
  readonly dockerSocket: string
}

export interface IsolationViolation {
  readonly code: string
  readonly detail: string
}

const REQUIRED_TMPFS_OPTIONS = ['rw', 'noexec', 'nosuid', 'nodev'] as const
const SHARED_TEMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'] as const

export function findIsolationViolations(
  spec: IsolatedContainerSpec,
  policy: IsolationPolicy,
): readonly IsolationViolation[] {
  const violations: IsolationViolation[] = []

  if (spec.image.trim() === '') violations.push({ code: 'image', detail: '镜像不能为空' })
  violations.push(...findWorkspacePathViolations(spec.workspace, policy))

  if (spec.workdir !== '/workspace') {
    violations.push({ code: 'workdir', detail: 'workdir 必须是 /workspace' })
  }
  if (!isNonRootUser(spec.user)) {
    violations.push({ code: 'user', detail: '容器必须使用非 root 用户' })
  }
  if (spec.network !== 'none') {
    violations.push({ code: 'network', detail: `network 必须是 none，实际为 ${spec.network}` })
  }
  if (!spec.readOnlyRoot) {
    violations.push({ code: 'rootfs', detail: '容器根文件系统必须只读' })
  }

  if (spec.mounts.length !== 1) {
    violations.push({ code: 'mount-count', detail: '只允许挂载测试工作区' })
  }
  const mount = spec.mounts[0]
  if (mount === undefined) {
    violations.push({ code: 'workspace-mount', detail: '缺少测试工作区挂载' })
  } else {
    if (mount.source !== spec.workspace) {
      violations.push({ code: 'mount-source', detail: '挂载源必须是测试工作区' })
    }
    if (mount.target !== '/workspace') {
      violations.push({ code: 'mount-target', detail: '工作区挂载点必须是 /workspace' })
    }
    if (!mount.readOnly) {
      violations.push({ code: 'mount-readonly', detail: '测试工作区必须只读挂载' })
    }
  }

  const tmpfs = spec.tmpfs.find((entry) => entry.target === '/tmp')
  if (spec.tmpfs.length !== 1 || tmpfs === undefined) {
    violations.push({ code: 'tmpfs', detail: '只允许一个独立 /tmp tmpfs' })
  } else {
    for (const option of REQUIRED_TMPFS_OPTIONS) {
      if (!tmpfs.options.includes(option)) {
        violations.push({ code: 'tmpfs-option', detail: `/tmp tmpfs 缺少 ${option}` })
      }
    }
  }

  if (!spec.capDrop.includes('ALL')) {
    violations.push({ code: 'cap-drop', detail: '必须 cap-drop ALL' })
  }
  if (!spec.noNewPrivileges) {
    violations.push({ code: 'no-new-privileges', detail: '必须启用 no-new-privileges' })
  }
  if (!Number.isInteger(spec.pidsLimit) || spec.pidsLimit < 1 || spec.pidsLimit > 256) {
    violations.push({ code: 'pids-limit', detail: 'pidsLimit 必须在 1..256 之间' })
  }

  for (const detail of findExecutorEnvViolations(spec.env)) {
    violations.push({ code: 'env', detail })
  }

  return violations
}

export async function inspectWorkspaceIsolation(
  workspace: string,
  policy: IsolationPolicy,
): Promise<readonly IsolationViolation[]> {
  const workspacePath = trimTrailingSlash(workspace)
  const [canonicalPolicy, sharedTempRoots] = await Promise.all([
    canonicalizePolicy(policy),
    canonicalizeSharedTempRoots(),
  ])
  const violations: IsolationViolation[] = [
    ...findWorkspacePathViolations(workspacePath, canonicalPolicy, sharedTempRoots),
  ]

  if (!isAbsolutePath(workspacePath) || workspacePath === '/') return violations

  let realWorkspace: string
  try {
    const info = await lstat(workspacePath)
    if (info.isSymbolicLink()) {
      violations.push({
        code: 'workspace-symlink',
        detail: 'workspace 不得是指向其他目录的符号链接',
      })
    }
    realWorkspace = await realpath(workspacePath)
  } catch {
    violations.push({ code: 'workspace-realpath', detail: 'workspace 必须存在且可解析' })
    return uniqueViolations(violations)
  }

  violations.push(...findWorkspacePathViolations(realWorkspace, canonicalPolicy, sharedTempRoots))

  let gitTopLevel: string
  try {
    gitTopLevel = await readGitTopLevel(realWorkspace)
  } catch {
    violations.push({
      code: 'git-toplevel',
      detail: 'workspace 必须是 git 仓库顶层，且 git rev-parse 必须成功',
    })
    return uniqueViolations(violations)
  }

  if (gitTopLevel !== realWorkspace) {
    violations.push({
      code: 'git-toplevel',
      detail: 'workspace 必须是独立 git 顶层，不能是父仓库中的子目录',
    })
  }

  return uniqueViolations(violations)
}

function findWorkspacePathViolations(
  workspace: string,
  policy: IsolationPolicy,
  sharedTempRoots: readonly string[] = SHARED_TEMP_ROOTS,
): readonly IsolationViolation[] {
  const violations: IsolationViolation[] = []
  const normalizedWorkspace = trimTrailingSlash(workspace)

  if (!isAbsolutePath(normalizedWorkspace) || normalizedWorkspace === '/') {
    violations.push({ code: 'workspace', detail: 'workspace 必须是具体的绝对路径' })
  } else if (sharedTempRoots.some((root) => normalizedWorkspace === trimTrailingSlash(root))) {
    violations.push({
      code: 'shared-temp-workspace',
      detail: 'workspace 不能是共享临时目录根，必须是其下的独立 git 顶层',
    })
  }

  for (const protectedPath of [
    { path: policy.hostHome, rejectDescendants: false },
    { path: policy.hostGhConfig, rejectDescendants: true },
    { path: policy.hostSshDir, rejectDescendants: true },
    { path: policy.dockerSocket, rejectDescendants: true },
  ]) {
    const normalizedProtected = trimTrailingSlash(protectedPath.path)
    const isProtectedAncestor = isAncestorOf(normalizedWorkspace, normalizedProtected)
    const isProtectedDescendant =
      protectedPath.rejectDescendants && isAncestorOf(normalizedProtected, normalizedWorkspace)
    if (isProtectedAncestor || isProtectedDescendant) {
      violations.push({
        code: 'protected-workspace',
        detail: `workspace 不得与受保护路径重叠：${normalizedProtected}`,
      })
    }
  }

  return violations
}

async function canonicalizePolicy(policy: IsolationPolicy): Promise<IsolationPolicy> {
  const [hostHome, hostGhConfig, hostSshDir, dockerSocket] = await Promise.all([
    realpathIfPresent(policy.hostHome),
    realpathIfPresent(policy.hostGhConfig),
    realpathIfPresent(policy.hostSshDir),
    realpathIfPresent(policy.dockerSocket),
  ])
  return { hostHome, hostGhConfig, hostSshDir, dockerSocket }
}

async function canonicalizeSharedTempRoots(): Promise<readonly string[]> {
  const canonical = await Promise.all(SHARED_TEMP_ROOTS.map(realpathIfPresent))
  return [...new Set([...SHARED_TEMP_ROOTS, ...canonical])]
}

async function realpathIfPresent(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return trimTrailingSlash(path)
  }
}

function readGitTopLevel(workspace: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', workspace, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: 64 * 1024,
        timeout: 5000,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(stdout.trim())
      },
    )
  })
}

function uniqueViolations(
  violations: readonly IsolationViolation[],
): readonly IsolationViolation[] {
  const seen = new Set<string>()
  return violations.filter((violation) => {
    const key = `${violation.code}\0${violation.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isNonRootUser(user: string): boolean {
  const uid = user.trim().split(':')[0]
  return uid !== undefined && uid !== '' && uid !== '0' && uid !== 'root'
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.split('/').includes('..')
}

function trimTrailingSlash(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

function isAncestorOf(ancestor: string, child: string): boolean {
  return child === ancestor || child.startsWith(`${ancestor}/`)
}
