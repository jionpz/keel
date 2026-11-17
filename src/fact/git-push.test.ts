import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { GitCliPushGateway } from './git-push.js'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return result.stdout.trim()
}

async function fixture(): Promise<{
  root: string
  remote: string
  head: string
}> {
  const base = await mkdtemp(join(tmpdir(), 'keel-push-'))
  roots.push(base)
  const remote = join(base, 'remote.git')
  const root = join(base, 'work')
  await run('git', ['init', '--bare', remote])
  await run('git', ['init', '-b', 'main', root])
  await git(root, 'config', 'user.name', 'Keel Test')
  await git(root, 'config', 'user.email', 'keel@example.test')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'initial')
  await git(root, 'checkout', '-b', 'ai/ticket-push')
  await writeFile(join(root, 'feature.txt'), 'feature\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'feature')
  return { root, remote: `file://${remote}`, head: await git(root, 'rev-parse', 'HEAD') }
}

describe('git push gateway', () => {
  it('受控网关不采纳 workspace 的 URL 重写和传输命令', async () => {
    const { root, remote, head } = await fixture()
    const marker = join(root, '.git', 'transport-ran')
    const script = join(root, '.git', 'transport')
    await writeFile(script, `#!/bin/sh\nprintf escaped > '${marker}'\nexit 1\n`)
    await chmod(script, 0o700)
    await git(root, 'config', 'protocol.ext.allow', 'always')
    await git(root, 'config', `url.ext::${script}.insteadOf`, remote)
    const gateway = new GitCliPushGateway(null)
    expect(
      await gateway.inspect({
        worktreePath: root,
        remoteUrl: remote,
        headBranch: 'ai/ticket-push',
      }),
    ).toMatchObject({ ok: true, value: { state: 'absent' } })
    expect(
      await gateway.push({
        worktreePath: root,
        remoteUrl: remote,
        headBranch: 'ai/ticket-push',
        headSha: head,
      }),
    ).toMatchObject({ ok: true, value: { headSha: head } })
    expect(await readFile(marker, 'utf8').catch(() => 'ABSENT')).toBe('ABSENT')
  })
  it('受控推送不执行 workspace 中的 pre-push hook', async () => {
    const { root, remote, head } = await fixture()
    const marker = join(root, '.git', 'hook-ran')
    const hook = join(root, '.git', 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\nprintf escaped > '${marker}'\nexit 1\n`)
    await chmod(hook, 0o700)
    const pushed = await new GitCliPushGateway(null).push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'ai/ticket-push',
      headSha: head,
    })
    expect(pushed).toMatchObject({ ok: true, value: { headSha: head } })
    expect(await readFile(marker, 'utf8').catch(() => 'ABSENT')).toBe('ABSENT')
  })
  it('推送准确 SHA，重复投递幂等，不覆盖已存在的不同 SHA', async () => {
    const { root, remote, head } = await fixture()
    const gateway = new GitCliPushGateway(null)
    const first = await gateway.push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'ai/ticket-push',
      headSha: head,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.error.detail)
    expect(first.value).toMatchObject({ headSha: head, created: true })

    const again = await gateway.push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'ai/ticket-push',
      headSha: head,
    })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.value.created).toBe(false)

    await writeFile(join(root, 'second.txt'), 'second\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-m', 'second')
    const next = await git(root, 'rev-parse', 'HEAD')
    const conflict = await gateway.push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'ai/ticket-push',
      headSha: next,
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) expect(conflict.error.kind).toBe('CONFLICT')
  })

  it('受控推送仍可读取 legacy linked worktree 的对象库', async () => {
    const { root, remote, head } = await fixture()
    const linked = join(root, '..', 'linked')
    await git(root, 'worktree', 'add', '-b', 'ai/legacy', linked, head)
    expect(
      await new GitCliPushGateway(null).push({
        worktreePath: linked,
        remoteUrl: remote,
        headBranch: 'ai/legacy',
        headSha: head,
      }),
    ).toMatchObject({ ok: true, value: { headSha: head, created: true } })
  })

  it('拒绝非 ai/* 分支与短 SHA', async () => {
    const { root, remote, head } = await fixture()
    const gateway = new GitCliPushGateway(null)
    const branch = await gateway.push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'main',
      headSha: head,
    })
    expect(branch.ok).toBe(false)
    const sha = await gateway.push({
      worktreePath: root,
      remoteUrl: remote,
      headBranch: 'ai/ticket-push',
      headSha: head.slice(0, 7),
    })
    expect(sha.ok).toBe(false)
  })
})
