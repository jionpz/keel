import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectProcess } from '../../timer/patrol.js'
import { buildMacSandboxProfile, prepareManagedOsSandbox } from './os-sandbox.js'

const execFileAsync = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp('/tmp/keel-os-sandbox-test-')
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('buildMacSandboxProfile', () => {
  it('只放行任务目录、模型网关端口，并拒绝宿主目录与 keychain', () => {
    const profile = buildMacSandboxProfile({
      root: '/private/tmp/keel/root',
      home: '/private/tmp/keel/root/home',
      tmpdir: '/private/tmp/keel/root/tmp',
      workspace: '/private/tmp/keel/workspace',
      hostHome: '/Users/operator',
      gitDirs: ['/Users/operator/mycode/repo/.git'],
      runtimePaths: ['/Users/operator/.nvm/versions/node/v24.14.1'],
      networkPorts: [3425],
    })

    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:3425"))')
    expect(profile).toContain(
      '(allow network-bind (local unix-socket (subpath "/private/tmp/keel/root/tmp")))',
    )
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users"))')
    expect(profile).toContain('(subpath "/private/tmp/keel/workspace")')
    expect(profile).toContain('(subpath "/Users/operator/mycode/repo/.git")')
    expect(profile).toContain('(deny mach-lookup (global-name "com.apple.securityd"))')
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))')
    expect(profile).not.toContain('(allow file-read* file-write* (subpath "/Users"))')
  })
})

describe('prepareManagedOsSandbox', () => {
  it.skipIf(process.platform !== 'darwin')(
    '真实 HTTP 可走隔离 TMPDIR 的 Unix socket，目录外、符号链接与 TCP 监听仍拒绝',
    async () => {
      const base = await tempDir()
      const root = join(base, 'root')
      const home = join(root, 'home')
      const tmpdir = join(root, 'tmp')
      const workspace = join(base, 'workspace')
      const outside = join(base, 'outside')
      await Promise.all(
        [home, tmpdir, workspace, outside].map((path) => mkdir(path, { recursive: true })),
      )
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace, stdio: 'pipe' })
      const outsideSocket = join(await realpath(outside), 'sentinel.sock')
      const server = createServer((_request, response) => response.end('HOST_SENTINEL'))
      await new Promise<void>((resolve) => server.listen(outsideSocket, resolve))
      cleanups.push(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
      )
      const realTmpdir = await realpath(tmpdir)
      const linkedSocket = join(realTmpdir, 'linked.sock')
      await symlink(outsideSocket, linkedSocket)
      const prepared = await prepareManagedOsSandbox({ root, home, tmpdir, workspace })
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      const script = `
        const http = require('node:http');
        const socket = ${JSON.stringify(join(realTmpdir, 'inside.sock'))};
        function request(path) {
          return new Promise(resolve => {
            const pending = http.request({ socketPath: path, path: '/' }, response => {
              let body = '';
              response.on('data', chunk => body += chunk);
              response.on('end', () => resolve({ ok: true, body }));
            });
            pending.on('error', error => resolve({ ok: false, code: error.code }));
            pending.end();
          });
        }
        (async () => {
          const server = http.createServer((_request, response) => response.end('HTTP_OK'));
          await new Promise((resolve, reject) => {
            server.on('error', reject);
            server.listen(socket, resolve);
          });
          const inside = await request(socket);
          const outside = await request(${JSON.stringify(outsideSocket)});
          const symlink = await request(${JSON.stringify(linkedSocket)});
          const tcp = await new Promise(resolve => {
            const listener = http.createServer();
            listener.on('error', error => resolve({ ok: false, code: error.code }));
            listener.listen(0, '127.0.0.1', () => listener.close(() => resolve({ ok: true })));
          });
          server.close();
          console.log(JSON.stringify({ inside, outside, symlink, tcp }));
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
      `
      const result = await execFileAsync(
        prepared.value.executable,
        [...prepared.value.prefixArgs, process.execPath, '-e', script],
        {
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: await realpath(home),
            TMPDIR: realTmpdir,
          },
          timeout: 5000,
        },
      )
      expect(JSON.parse(result.stdout)).toEqual({
        inside: { ok: true, body: 'HTTP_OK' },
        outside: { ok: false, code: 'EPERM' },
        symlink: { ok: false, code: 'EPERM' },
        tcp: { ok: false, code: 'EPERM' },
      })
    },
  )

  it('非 macOS 平台明确拒绝，不降级执行', async () => {
    const prepared = await prepareManagedOsSandbox({
      root: '/tmp/keel',
      home: '/tmp/keel/home',
      tmpdir: '/tmp/keel/tmp',
      workspace: '/tmp/keel/workspace',
      platform: 'linux',
    })
    expect(prepared.ok).toBe(false)
    if (prepared.ok) return
    expect(prepared.error.detail).toMatch(/尚未接入/)
  })

  it.skipIf(process.platform !== 'darwin')('真实子进程只能读任务目录和模型端口', async () => {
    const base = await tempDir()
    const root = join(base, 'root')
    const home = join(root, 'home')
    const tmpdir = join(root, 'tmp')
    const workspace = join(base, 'workspace')
    const hostHome = join(base, 'host')
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(tmpdir, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(hostHome, { recursive: true }),
    ])
    await writeFile(join(workspace, 'allowed.txt'), 'WORKSPACE_OK\n')
    await writeFile(join(hostHome, 'secret.txt'), 'HOST_SECRET\n')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace, stdio: 'pipe' })

    const server = createServer((_request, response) => response.end('GATEWAY_OK'))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    )
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('测试服务缺少端口')

    const prepared = await prepareManagedOsSandbox({
      root,
      home,
      tmpdir,
      workspace,
      hostHome,
      networkPorts: [address.port],
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const [realRoot, realHome, realTmpdir, realWorkspace, realHostHome] = await Promise.all([
      realpath(root),
      realpath(home),
      realpath(tmpdir),
      realpath(workspace),
      realpath(hostHome),
    ])
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: realHome,
      TMPDIR: realTmpdir,
      LANG: 'C.UTF-8',
    }
    const run = (script: string) =>
      execFileAsync(
        prepared.value.executable,
        [...prepared.value.prefixArgs, '/bin/zsh', '-c', script],
        { cwd: realWorkspace, env, timeout: 5000 },
      )

    const allowed = await run('cat allowed.txt')
    expect(allowed.stdout).toContain('WORKSPACE_OK')

    await expect(run(`cat ${JSON.stringify(join(realHostHome, 'secret.txt'))}`)).rejects.toThrow()
    await expect(
      run('curl --noproxy "*" -sS -m 2 -o /dev/null https://api.github.com/user'),
    ).rejects.toThrow()

    const gateway = await run(`curl --noproxy "*" -sS -m 2 http://127.0.0.1:${address.port}/`)
    expect(gateway.stdout).toContain('GATEWAY_OK')

    await expect(
      run('/usr/bin/security find-generic-password -s keel-test >/dev/null 2>&1'),
    ).rejects.toThrow()
    expect(realRoot).toContain('/private/tmp/')
  })

  it.skipIf(process.platform !== 'darwin')('linked worktree 的 git 元数据可读写', async () => {
    const base = await tempDir()
    const mainRepo = join(base, 'main')
    const linked = join(base, 'linked')
    const root = join(base, 'root')
    const home = join(root, 'home')
    const tmpdir = join(root, 'tmp')
    const hostHome = join(base, 'host')
    await Promise.all([
      mkdir(mainRepo, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(tmpdir, { recursive: true }),
      mkdir(hostHome, { recursive: true }),
    ])
    const git = (cwd: string, args: readonly string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' })
    git(mainRepo, ['init', '-q', '-b', 'main'])
    git(mainRepo, ['config', 'user.email', 'test@keel.invalid'])
    git(mainRepo, ['config', 'user.name', 'keel test'])
    await writeFile(join(mainRepo, 'README.md'), '# main\n')
    git(mainRepo, ['add', 'README.md'])
    git(mainRepo, ['commit', '-q', '-m', 'base'])
    git(mainRepo, ['worktree', 'add', '-q', '-b', 'linked-branch', linked])
    await writeFile(join(home, '.gitconfig'), '[user]\n\tname = test\n\temail = t@invalid\n')

    const prepared = await prepareManagedOsSandbox({
      root,
      home,
      tmpdir,
      workspace: linked,
      hostHome,
      networkPorts: [3425],
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: await realpath(home),
      TMPDIR: await realpath(tmpdir),
      LANG: 'C.UTF-8',
    }
    const runGit = async (args: readonly string[]) =>
      execFileAsync(
        prepared.value.executable,
        [...prepared.value.prefixArgs, '/usr/bin/git', ...args],
        { cwd: await realpath(linked), env, timeout: 5000 },
      )

    const before = await runGit(['rev-parse', 'HEAD'])
    await runGit(['commit', '--allow-empty', '-q', '-m', 'sandbox commit'])
    const after = await runGit(['rev-parse', 'HEAD'])
    expect(after.stdout.trim()).not.toBe(before.stdout.trim())
  })
})

// 宿主巡检使用 ps 核验 PID 身份；被测沙箱无权充当宿主探针。
it('宿主探针能读取真实子进程启动时间，退出后不再报告存活', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('spawn 没拿到 pid')
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  try {
    const info = inspectProcess(pid)
    expect(info.alive).toBe(true)
    expect(info.startedAt).not.toBeNull()
    expect(Math.abs((info.startedAt?.getTime() ?? 0) - Date.now())).toBeLessThan(10_000)
  } finally {
    child.kill('SIGKILL')
    await exited
  }
  expect(inspectProcess(pid).alive).toBe(false)
})
