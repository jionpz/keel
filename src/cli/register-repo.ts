/**
 * keel register-repo —— 按 remote_url 幂等注册 repo。
 *
 * repo 是只读实体：docs/03-domain-model.md §4 里 control / execution / ingress
 * 三个角色对它都只有 SELECT，仓库注册是管理操作。所以本命令刻意以属主身份写入 ——
 * 这不是绕过 asRole 纪律，而是矩阵里没有对应角色。
 * 反面做法是给 keel_ingress 授 repo INSERT，那等于让外部输入自选目标仓库。
 */

import { randomUUID } from 'node:crypto'
import { asOwner } from '../fact/db.js'
import { normalizeRemoteUrl } from '../fact/remote-url.js'
import { parseArgs } from './argv.js'

export async function registerRepoMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel register-repo <remoteUrl> [--default-branch <name>]

按 remote_url 幂等注册 repo。remoteUrl 示例:
  https://github.com/owner/repo.git`)
    return
  }
  const remoteUrl = positionals[0]
  if (remoteUrl === undefined) {
    console.error('register-repo: 缺少 remoteUrl')
    process.exitCode = 1
    return
  }
  const defaultBranch =
    typeof flags['default-branch'] === 'string' ? flags['default-branch'] : 'main'

  const normalized = normalizeRemoteUrl(remoteUrl)
  const repoId = await asOwner(async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM repo WHERE regexp_replace(regexp_replace(remote_url, '/+$', ''), '\\.git$', '', 'i') = $1`,
      [normalized],
    )
    const row = existing.rows[0]
    if (row !== undefined) return row.id

    const id = randomUUID()
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1, 'github', $2, $3)`,
      [id, remoteUrl, defaultBranch],
    )
    return id
  })

  console.log(`repoId: ${repoId}`)
}
