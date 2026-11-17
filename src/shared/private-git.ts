import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** managed 写执行只接受仓库内的私有 Git 管理目录，不自动迁移旧现场。 */
export async function assertPrivateGitDirectory(workspace: string): Promise<void> {
  const gitDir = join(workspace, '.git')
  const info = await lstat(gitDir)
  if (!info.isDirectory() || (await realpath(gitDir)) !== gitDir)
    throw new Error('managed workspace 必须使用独立 Git 副本；拒绝 linked worktree 或外置 gitdir')
  await inspectEntries(gitDir)
  if (
    await lstat(join(gitDir, 'commondir')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  )
    throw new Error('managed workspace 不得共享 Git common directory')
  for (const name of ['alternates', 'http-alternates']) {
    const content = await readFile(join(gitDir, 'objects', 'info', name), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      },
    )
    if (content.trim() !== '') throw new Error('managed workspace 不得借用其他仓库的对象库')
  }
}

async function inspectEntries(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    const entry = join(path, name)
    const info = await lstat(entry)
    if (info.isSymbolicLink()) throw new Error('managed Git 管理目录内不得有符号链接')
    if (info.isDirectory()) await inspectEntries(entry)
    else if (!info.isFile() || info.nlink !== 1)
      throw new Error('managed Git 管理目录内不得有硬链接或特殊文件')
  }
}
