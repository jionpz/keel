import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findIsolationViolations,
  type IsolatedContainerSpec,
  type IsolationMount,
  type IsolationPolicy,
  type IsolationTmpfs,
  inspectWorkspaceIsolation,
} from './container-spec.js'

const POLICY: IsolationPolicy = {
  hostHome: '/Users/operator',
  hostGhConfig: '/Users/operator/.config/gh',
  hostSshDir: '/Users/operator/.ssh',
  dockerSocket: '/var/run/docker.sock',
}

function spec(over: Partial<IsolatedContainerSpec> = {}): IsolatedContainerSpec {
  return {
    image: 'keel-jt02a-isolation:test',
    workspace: '/tmp/jt02a/workspace',
    workdir: '/workspace',
    user: '65534:65534',
    network: 'none',
    readOnlyRoot: true,
    mounts: [
      {
        source: '/tmp/jt02a/workspace',
        target: '/workspace',
        readOnly: true,
      },
    ],
    tmpfs: [{ target: '/tmp', options: ['rw', 'noexec', 'nosuid', 'nodev'] }],
    capDrop: ['ALL'],
    noNewPrivileges: true,
    pidsLimit: 64,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
    },
    ...over,
  }
}

describe('findIsolationViolations', () => {
  it('接受完整的隔离规格', () => {
    expect(findIsolationViolations(spec(), POLICY)).toEqual([])
  })

  it.each(['bridge', 'host', 'default'])('拒绝网络模式 %s', (network) => {
    const violations = findIsolationViolations(spec({ network }), POLICY)
    expect(violations.some((v) => v.code === 'network')).toBe(true)
  })

  it('拒绝额外挂载宿主 HOME、gh 配置、SSH 或 Docker socket', () => {
    for (const source of [
      POLICY.hostHome,
      POLICY.hostGhConfig,
      POLICY.hostSshDir,
      POLICY.dockerSocket,
    ]) {
      const mounts: readonly IsolationMount[] = [
        ...spec().mounts,
        { source, target: '/host', readOnly: true },
      ]
      const violations = findIsolationViolations(spec({ mounts }), POLICY)
      expect(violations.some((v) => v.code === 'mount-count')).toBe(true)
    }
  })

  it('拒绝可写工作区挂载与可写根文件系统', () => {
    const mounts: readonly IsolationMount[] = [
      { source: '/tmp/jt02a/workspace', target: '/workspace', readOnly: false },
    ]
    const writable = findIsolationViolations(spec({ mounts, readOnlyRoot: false }), POLICY)
    expect(writable.some((v) => v.code === 'mount-readonly')).toBe(true)
    expect(writable.some((v) => v.code === 'rootfs')).toBe(true)
  })

  it('拒绝 root 用户', () => {
    for (const user of ['0', 'root', '0:0', 'root:root']) {
      const violations = findIsolationViolations(spec({ user }), POLICY)
      expect(violations.some((v) => v.code === 'user')).toBe(true)
    }
  })

  it('拒绝缺少 /tmp tmpfs 或缺少 noexec 的 tmpfs', () => {
    const missing: readonly IsolationTmpfs[] = []
    const unsafe: readonly IsolationTmpfs[] = [{ target: '/tmp', options: ['rw', 'nosuid'] }]
    expect(
      findIsolationViolations(spec({ tmpfs: missing }), POLICY).some((v) => v.code === 'tmpfs'),
    ).toBe(true)
    expect(
      findIsolationViolations(spec({ tmpfs: unsafe }), POLICY).some(
        (v) => v.code === 'tmpfs-option',
      ),
    ).toBe(true)
  })

  it('拒绝凭据环境变量与缺少安全选项', () => {
    const violations = findIsolationViolations(
      spec({
        env: { PATH: '/usr/bin', GH_TOKEN: 'sentinel' },
        capDrop: [],
        noNewPrivileges: false,
      }),
      POLICY,
    )
    expect(violations.some((v) => v.code === 'env')).toBe(true)
    expect(violations.some((v) => v.code === 'cap-drop')).toBe(true)
    expect(violations.some((v) => v.code === 'no-new-privileges')).toBe(true)
  })

  it('拒绝只有 PATH 的 PATH-only 环境', () => {
    const violations = findIsolationViolations(
      spec({
        env: { PATH: '/usr/bin' },
      }),
      POLICY,
    )
    expect(violations.some((v) => v.code === 'env' && v.detail.includes('HOME'))).toBe(true)
    expect(violations.some((v) => v.code === 'env' && v.detail.includes('TMPDIR'))).toBe(true)
  })

  it('拒绝把宿主 HOME 或其祖先作为工作区', () => {
    for (const workspace of [POLICY.hostHome, '/Users']) {
      const mounts: readonly IsolationMount[] = [
        { source: workspace, target: '/workspace', readOnly: true },
      ]
      const violations = findIsolationViolations(spec({ workspace, mounts }), POLICY)
      expect(violations.some((v) => v.code === 'protected-workspace')).toBe(true)
    }
  })

  it('拒绝 gh、SSH 与 Docker socket 的受保护路径后代', () => {
    for (const workspace of [
      `${POLICY.hostGhConfig}/task`,
      `${POLICY.hostSshDir}/task`,
      '/var/run',
    ]) {
      const mounts: readonly IsolationMount[] = [
        { source: workspace, target: '/workspace', readOnly: true },
      ]
      const violations = findIsolationViolations(spec({ workspace, mounts }), POLICY)
      expect(violations.some((v) => v.code === 'protected-workspace')).toBe(true)
    }
  })

  it('允许宿主 HOME 的普通后代，不把 HOME 后代误判为受保护路径', () => {
    const workspace = `${POLICY.hostHome}/code/task`
    const mounts: readonly IsolationMount[] = [
      { source: workspace, target: '/workspace', readOnly: true },
    ]
    const violations = findIsolationViolations(spec({ workspace, mounts }), POLICY)
    expect(violations.some((v) => v.code === 'protected-workspace')).toBe(false)
  })

  it('拒绝共享临时目录根，但允许其下的 workspace 子目录', () => {
    for (const workspace of ['/tmp', '/var/tmp', '/dev/shm']) {
      const mounts: readonly IsolationMount[] = [
        { source: workspace, target: '/workspace', readOnly: true },
      ]
      const violations = findIsolationViolations(spec({ workspace, mounts }), POLICY)
      expect(violations.some((v) => v.code === 'shared-temp-workspace')).toBe(true)
    }

    for (const workspace of ['/tmp/task', '/var/tmp/task', '/dev/shm/task']) {
      const mounts: readonly IsolationMount[] = [
        { source: workspace, target: '/workspace', readOnly: true },
      ]
      const violations = findIsolationViolations(spec({ workspace, mounts }), POLICY)
      expect(violations.some((v) => v.code === 'shared-temp-workspace')).toBe(false)
    }
  })
})

describe('inspectWorkspaceIsolation', () => {
  let sandbox: string
  let policy: IsolationPolicy

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'keel-jt02a-')))
    policy = {
      hostHome: join(sandbox, 'home'),
      hostGhConfig: join(sandbox, 'home', '.config', 'gh'),
      hostSshDir: join(sandbox, 'home', '.ssh'),
      dockerSocket: join(sandbox, 'run', 'docker.sock'),
    }
    mkdirSync(policy.hostHome, { recursive: true })
    mkdirSync(policy.hostGhConfig, { recursive: true })
    mkdirSync(policy.hostSshDir, { recursive: true })
    mkdirSync(join(sandbox, 'run'), { recursive: true })
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('接受独立的 git 顶层', async () => {
    const workspace = join(sandbox, 'repo')
    initRepo(workspace)

    expect(await inspectWorkspaceIsolation(workspace, policy)).toEqual([])
  })

  it('接受共享临时根下的真实 git 顶层', async () => {
    const sharedRoot = mkdtempSync(join('/tmp', 'keel-jt02a-shared-'))
    try {
      const workspace = join(sharedRoot, 'repo')
      initRepo(workspace)

      expect(await inspectWorkspaceIsolation(workspace, policy)).toEqual([])
    } finally {
      rmSync(sharedRoot, { recursive: true, force: true })
    }
  })

  it('拒绝 ~/.ssh/task 与 ~/.config/gh/... 这类受保护路径后代', async () => {
    for (const workspace of [
      join(policy.hostSshDir, 'task'),
      join(policy.hostGhConfig, 'accounts', 'task'),
    ]) {
      mkdirSync(workspace, { recursive: true })
      const violations = await inspectWorkspaceIsolation(workspace, policy)
      expect(violations.some((v) => v.code === 'protected-workspace')).toBe(true)
    }
  })

  it('拒绝指向 SSH 目录的符号链接别名', async () => {
    const alias = join(sandbox, 'ssh-alias')
    symlinkSync(policy.hostSshDir, alias)

    const violations = await inspectWorkspaceIsolation(alias, policy)
    expect(violations.some((v) => v.code === 'workspace-symlink')).toBe(true)
    expect(violations.some((v) => v.code === 'protected-workspace')).toBe(true)
  })

  it('拒绝父 git 仓库中的普通子目录', async () => {
    const parent = join(sandbox, 'parent')
    const workspace = join(parent, 'nested')
    initRepo(parent)
    mkdirSync(workspace)

    const violations = await inspectWorkspaceIsolation(workspace, policy)
    expect(violations.some((v) => v.code === 'git-toplevel')).toBe(true)
  })
})

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', path], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
}
