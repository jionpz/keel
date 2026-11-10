import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { indexManagedWorkspace, readManagedFiles } from './managed-files.js'

const roots: string[] = []
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keel-managed-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed files', () => {
  it('拒绝作为工作区根路径的软链接', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'actual'))
    await symlink(path.join(root, 'actual'), path.join(root, 'alias'))
    expect((await indexManagedWorkspace(path.join(root, 'alias'))).ok).toBe(false)
    expect((await readManagedFiles(path.join(root, 'alias'), [])).ok).toBe(false)
  })

  it('索引安全文件并返回真实字节摘要', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'docs'))
    await writeFile(path.join(root, 'docs', 'b.txt'), '你好\n')
    await writeFile(path.join(root, 'a.txt'), 'a')
    await mkdir(path.join(root, 'node_modules'))
    await writeFile(path.join(root, 'node_modules', 'ignored'), 'x')
    await writeFile(path.join(root, '.hidden'), 'x')
    await writeFile(path.join(root, 'credentials.json'), 'x')
    await symlink(path.join(root, 'a.txt'), path.join(root, 'link'))
    expect(await indexManagedWorkspace(root)).toEqual({ ok: true, value: ['a.txt', 'docs/b.txt'] })
    expect(await readManagedFiles(root, ['docs/b.txt'])).toEqual({
      ok: true,
      value: [
        {
          path: 'docs/b.txt',
          content: '你好\n',
          digest: createHash('sha256').update('你好\n').digest('hex'),
        },
      ],
    })
  })

  it('拒绝越界、隐藏文件、凭据与软链接', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'safe.txt'), 'ok')
    await symlink(path.join(root, 'safe.txt'), path.join(root, 'link'))
    await symlink(root, path.join(root, 'dirlink'))
    for (const name of [
      '../x',
      '/tmp/x',
      'a\\b',
      '.hidden',
      'x/.hidden',
      'node_modules/a',
      'dist/a',
      'coverage/a',
      '.env',
      'env.local',
      'credentials.json',
      'secrets.txt',
      'private.pem',
      'private.key',
      'link',
      'dirlink/safe.txt',
    ]) {
      const result = await readManagedFiles(root, [name])
      expect(result.ok, name).toBe(false)
      if (!result.ok) expect(result.error.kind, name).toBe('PERMISSION_DENIED')
    }
  })

  it('拒绝二进制、非法 UTF-8、超限文件和请求', async () => {
    const root = await fixture()
    await writeFile(path.join(root, 'nul'), Buffer.from([65, 0, 66]))
    await writeFile(path.join(root, 'invalid'), Buffer.from([0xff]))
    await writeFile(path.join(root, 'large'), Buffer.alloc(65537, 65))
    await writeFile(path.join(root, 'full'), Buffer.alloc(65536, 65))
    for (const name of ['nul', 'invalid']) {
      const result = await readManagedFiles(root, [name])
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('PERMISSION_DENIED')
    }
    for (const names of [['large'], Array(5).fill('full'), Array(9).fill('full')]) {
      const result = await readManagedFiles(root, names)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('CONTEXT_BUDGET_EXCEEDED')
    }
  })

  it('索引超出 1000 项时报错', async () => {
    const root = await fixture()
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => writeFile(path.join(root, `file${i}`), '')),
    )
    const result = await indexManagedWorkspace(root)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('CONTEXT_BUDGET_EXCEEDED')
  })
})
