/**
 * keel register-repo —— 按 remote_url 幂等注册 repo，可绑定本地项目目录。
 *
 * repo 是只读实体：docs/03-domain-model.md §4 里 control / execution / ingress
 * 三个角色对它都只有 SELECT，仓库注册是管理操作。所以本命令刻意以属主身份写入 ——
 * 这不是绕过 asRole 纪律，而是矩阵里没有对应角色。
 * 反面做法是给 keel_ingress 授 repo INSERT，那等于让外部输入自选目标仓库。
 *
 * 绑定语义（design.md §9.1）：
 *   - 不带 --local-path：保留已有绑定，不写库；
 *   - 带 --local-path：先完整校验（存在 / git 工作树 / origin 匹配），
 *     再在单事务内写入；校验失败时原值不变。
 */

import { randomUUID } from 'node:crypto'
import { asOwner, asOwnerTx } from '../fact/db.js'
import { validateAttachedDir } from '../fact/project-root.js'
import { normalizeRemoteUrl } from '../fact/remote-url.js'
import { workspaceError } from '../fact/workspace-error.js'
import { parseArgs } from './argv.js'

const PG_UNIQUE_VIOLATION = '23505'

export async function registerRepoMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel register-repo <remoteUrl> [--default-branch <name>] [--local-path <dir>]

按 remote_url 幂等注册 repo。remoteUrl 示例:
  https://github.com/owner/repo.git

选项:
  --default-branch <name>  基线分支(默认 main)
  --local-path <dir>       绑定已存在的本地 git 工作树；不传则保持 Keel 托管模式。
                           重复执行时不传该参数会保留原有绑定。`)
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
  const localPathFlag = typeof flags['local-path'] === 'string' ? flags['local-path'] : undefined

  // ── 校验全部在事务外完成：失败时零写入，也不占用事务 ──
  let canonicalPath: string | undefined
  if (localPathFlag !== undefined) {
    const validated = await validateAttachedDir(localPathFlag, remoteUrl)
    if (!validated.ok) {
      console.error(`register-repo: ${validated.error.detail}`)
      process.exitCode = 1
      return
    }
    canonicalPath = validated.value.path
  }

  const normalized = normalizeRemoteUrl(remoteUrl)
  /** UPDATE 撞唯一索引时用它告诉用户「当前是哪个 repo 去抢的」 */
  let updatingRepoId: string | undefined

  try {
    const repoId = await asOwnerTx(async (c) => {
      const existing = await c.query<{ id: string; local_path: string | null }>(
        `SELECT id, local_path FROM repo
         WHERE regexp_replace(regexp_replace(remote_url, '/+$', ''), '\\.git$', '', 'i') = $1
         FOR UPDATE`,
        [normalized],
      )
      const row = existing.rows[0]

      if (row === undefined) {
        const id = randomUUID()
        await c.query(
          `INSERT INTO repo (id, provider, remote_url, default_branch, local_path)
           VALUES ($1, 'github', $2, $3, $4)`,
          [id, remoteUrl, defaultBranch, canonicalPath ?? null],
        )
        return id
      }

      // 没传 flag，或传入的就是当前值：不写库，保留原绑定
      if (canonicalPath === undefined || row.local_path === canonicalPath) return row.id

      updatingRepoId = row.id
      await c.query(`UPDATE repo SET local_path = $1 WHERE id = $2`, [canonicalPath, row.id])
      return row.id
    })

    console.log(`repoId: ${repoId}`)
    if (canonicalPath !== undefined) console.log(`localPath: ${canonicalPath}`)
  } catch (e) {
    if (pgCode(e) === PG_UNIQUE_VIOLATION && canonicalPath !== undefined) {
      const occupant = await findOccupant(canonicalPath)
      console.error(
        `register-repo: ${
          workspaceError('local_path_taken', {
            path: canonicalPath,
            repo: updatingRepoId ?? '(new)',
            occupied_by: occupant ?? '(unknown)',
          }).detail
        }`,
      )
      process.exitCode = 1
      return
    }
    throw e
  }
}

/** 冲突后反查占用者：唯一索引只告诉我们「撞了」，用户需要知道撞的是谁 */
async function findOccupant(localPath: string): Promise<string | undefined> {
  const rows = await asOwner((c) =>
    c.query<{ id: string }>(`SELECT id FROM repo WHERE local_path = $1`, [localPath]),
  )
  return rows.rows[0]?.id
}

function pgCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined
}
