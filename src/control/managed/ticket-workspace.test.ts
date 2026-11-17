import { execFileSync } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertPrivateGitDirectory } from '../../shared/private-git.js'
import {
  createTicketRepository,
  diffDigest,
  inspectTicketWorktree,
  workingTreeChangedFiles,
} from './ticket-workspace.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim()

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'keel-private-git-')))
  roots.push(base)
  const repo = join(base, 'source')
  await mkdir(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@invalid')
  await writeFile(join(repo, 'README.md'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  return { base, repo, head: git(repo, 'rev-parse', 'HEAD') }
}

it('从 linked source 建立独立副本，真实提交不改宿主 refs/config/worktree 管理记录', async () => {
  const { base, repo, head } = await fixture()
  const linked = join(base, 'linked')
  git(repo, 'worktree', 'add', '-b', 'linked', linked)
  const refs = git(repo, 'show-ref')
  const config = await readFile(join(repo, '.git', 'config'), 'utf8')
  const worktrees = git(repo, 'worktree', 'list', '--porcelain')
  const copy = join(base, 'copy')
  await createTicketRepository(linked, copy, 'ai/private', head)
  expect(await inspectTicketWorktree(copy)).toMatchObject({
    ok: true,
    value: { head, branch: 'ai/private', clean: true },
  })
  await assertPrivateGitDirectory(copy)
  await writeFile(join(copy, 'README.md'), 'implementation\n')
  git(copy, 'add', '.')
  git(copy, 'commit', '-m', 'implementation')
  expect(git(copy, 'rev-parse', 'HEAD')).not.toBe(head)
  expect(git(repo, 'show-ref')).toBe(refs)
  expect(await readFile(join(repo, '.git', 'config'), 'utf8')).toBe(config)
  expect(git(repo, 'worktree', 'list', '--porcelain')).toBe(worktrees)
  expect(await inspectTicketWorktree(linked)).toMatchObject({ ok: false })
})

it('复制前驱时不执行源仓库配置的传输命令', async () => {
  const { base, repo, head } = await fixture()
  const marker = join(base, 'transport-ran')
  const script = join(repo, '.git', 'transport')
  await writeFile(script, `#!/bin/sh\nprintf escaped > '${marker}'\nexit 1\n`)
  await chmod(script, 0o700)
  git(repo, 'config', 'protocol.ext.allow', 'always')
  git(repo, 'config', `url.ext::${script}.insteadOf`, repo)
  const copy = join(base, 'copy')
  await createTicketRepository(repo, copy, 'ai/private', head)
  expect(await inspectTicketWorktree(copy)).toMatchObject({ ok: true, value: { head } })
  expect(await readFile(marker, 'utf8').catch(() => 'ABSENT')).toBe('ABSENT')
})

it('从借用对象库的源仓库复制时也不借用或硬链接对象', async () => {
  const { base, repo, head } = await fixture()
  const borrowed = join(base, 'borrowed')
  git(repo, 'clone', '--shared', repo, borrowed)
  const copy = join(base, 'copy')
  await createTicketRepository(borrowed, copy, 'ai/private', head)
  await assertPrivateGitDirectory(copy)
  // 将源移走后，副本仍能独立读取完整对象历史。
  const { rename } = await import('node:fs/promises')
  await rename(repo, join(base, 'moved-source'))
  expect(git(copy, 'show', 'HEAD:README.md')).toBe('base')
})

it('宿主检查不执行 workspace 配置的 fsmonitor 或外部 diff，不读取 replace 伪造历史', async () => {
  const { repo, base, head } = await fixture()
  await writeFile(join(repo, 'README.md'), 'implementation\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'implementation')
  const commit = git(repo, 'rev-parse', 'HEAD')
  const marker = join(base, 'host-sentinel')
  const monitor = join(repo, '.git', 'monitor')
  await writeFile(monitor, `#!/bin/sh\nprintf escaped > '${marker}'\nprintf token\n`)
  await chmod(monitor, 0o700)
  git(repo, 'config', 'core.fsmonitor', monitor)
  git(repo, 'config', 'diff.external', monitor)
  expect(await inspectTicketWorktree(repo)).toMatchObject({ ok: true, value: { clean: true } })
  const before = await diffDigest(repo, head, commit)
  expect(before).toMatchObject({ ok: true })
  git(repo, 'replace', commit, head)
  expect(await diffDigest(repo, head, commit)).toEqual(before)
  expect(await workingTreeChangedFiles(repo, head)).toMatchObject({
    ok: true,
    value: ['README.md'],
  })
  expect(await readFile(marker, 'utf8').catch(() => 'ABSENT')).toBe('ABSENT')
})

it.each(['symlink', 'hardlink', 'alternates', 'commondir'] as const)(
  '拒绝 %s 共享路径并保留原始现场',
  async (kind) => {
    const { repo, base } = await fixture()
    const outside = join(base, 'outside')
    await writeFile(outside, 'sentinel\n')
    if (kind === 'symlink') await symlink(outside, join(repo, '.git', 'shared'))
    if (kind === 'hardlink') await link(outside, join(repo, '.git', 'shared'))
    if (kind === 'alternates') {
      await mkdir(join(repo, '.git', 'objects', 'info'), { recursive: true })
      await writeFile(join(repo, '.git', 'objects', 'info', 'alternates'), '/tmp/borrowed\n')
    }
    if (kind === 'commondir') await writeFile(join(repo, '.git', 'commondir'), '/tmp/common\n')
    expect(await inspectTicketWorktree(repo)).toMatchObject({ ok: false })
    expect(await readFile(outside, 'utf8')).toBe('sentinel\n')
  },
)
