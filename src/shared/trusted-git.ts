import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 宿主传输只读取控制层创建的配置；不可信 workspace 的 URL 重写、代理、
 * SSH/remote helper、include 和 hooks 均不能进入宿主传输进程。
 * 调用方按需用 GIT_OBJECT_DIRECTORY 只读指定源对象库，不加载源配置或 refs。
 */
export async function withTrustedGitDirectory<T>(
  action: (gitDir: string) => Promise<T>,
): Promise<T> {
  const gitDir = await mkdtemp(join(tmpdir(), 'keel-git-transport-'))
  try {
    await Promise.all([
      mkdir(join(gitDir, 'objects')),
      mkdir(join(gitDir, 'refs')),
      writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n'),
      writeFile(
        join(gitDir, 'config'),
        '[core]\nrepositoryformatversion = 0\nbare = true\nhooksPath = /dev/null\n',
      ),
    ])
    return await action(gitDir)
  } finally {
    await rm(gitDir, { recursive: true, force: true })
  }
}
