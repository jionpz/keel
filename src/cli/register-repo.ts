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
 *
 * Issue label 语义（08-29-ingress-poller design.md §2.2）：
 *   - 新建 repo：--issue-label ?? 'keel'；
 *   - 已存在：不带 flag 保留原值，带了且不同才 UPDATE；
 *   - 空白值在写库前拒绝 —— 不让空 label 退化成「列出全部 open issue」。
 */

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { asOwner, asOwnerTx } from '../fact/db.js'
import { validateAttachedDir } from '../fact/project-root.js'
import { normalizeRemoteUrl } from '../fact/remote-url.js'
import { workspaceError } from '../fact/workspace-error.js'
import { parseArgs } from './argv.js'

const PG_UNIQUE_VIOLATION = '23505'

/**
 * `--default-branch` 的取值纪律（与 `--model` / `--wall-clock` 同一套）：
 * 省略 → `main`；空白 / 只写标志 → 拒绝，不静默回退。
 *
 * 纯数字分支名（如 `2024`）会被 argv 解析成 number，仍是合法名称 ——
 * 旧的 `typeof === 'string'` 判断会把它静默换成 `main`，那等于写错基线分支。
 */
function resolveDefaultBranch(raw: string | number | boolean | undefined): Result<string> {
  if (raw === undefined) return ok('main')
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        '--default-branch 需要一个非空分支名（只写标志等同于空白，不会静默回退 main）。',
      ),
    )
  }
  const trimmed = String(raw).trim()
  if (trimmed === '') {
    return err(
      makeError('CAPABILITY_UNSUPPORTED', '--default-branch 不能为空白（不会静默回退 main）。'),
    )
  }
  return ok(trimmed)
}

export async function registerRepoMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel register-repo <remoteUrl> [--default-branch <name>] [--local-path <dir>]
                          [--issue-label <name>]

按 remote_url 幂等注册 repo。remoteUrl 示例:
  https://github.com/owner/repo.git

选项:
  --default-branch <name>  基线分支(默认 main;空白值拒绝)
  --local-path <dir>       绑定已存在的本地 git 工作树；不传则保持 Keel 托管模式。
                           重复执行时不传该参数会保留原有绑定。
  --issue-label <name>     poller 扫描用的 Issue label(默认 keel)。
                           重复执行时不传该参数会保留原值。`)
    return
  }
  const remoteUrl = positionals[0]
  if (remoteUrl === undefined) {
    console.error('register-repo: 缺少 remoteUrl')
    process.exitCode = 1
    return
  }
  const defaultBranchFlag = resolveDefaultBranch(flags['default-branch'])
  if (!defaultBranchFlag.ok) {
    console.error(`register-repo: ${defaultBranchFlag.error.detail}`)
    process.exitCode = 1
    return
  }
  const defaultBranch = defaultBranchFlag.value
  const localPathFlag = typeof flags['local-path'] === 'string' ? flags['local-path'] : undefined

  // 空白 label 会让 poller 列出该仓库全部 open issue，跨过 label 闸门。
  // 在写库前拒绝，不依赖数据库约束报错（那里的错误信息对用户不可操作）。
  let issueLabel: string | undefined
  const rawIssueLabel = flags['issue-label']
  if (rawIssueLabel !== undefined) {
    // 纯数字 label（如 2024）会被 argv 解析成 number，仍是合法名称
    if (typeof rawIssueLabel !== 'string' && typeof rawIssueLabel !== 'number') {
      console.error('register-repo: --issue-label 需要一个非空 label 名称')
      process.exitCode = 1
      return
    }
    issueLabel = String(rawIssueLabel).trim()
    if (issueLabel === '') {
      console.error('register-repo: --issue-label 不能为空白')
      process.exitCode = 1
      return
    }
  }

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
      const existing = await c.query<{
        id: string
        local_path: string | null
        issue_label: string
      }>(
        `SELECT id, local_path, issue_label FROM repo
         WHERE regexp_replace(regexp_replace(remote_url, '/+$', ''), '\\.git$', '', 'i') = $1
         FOR UPDATE`,
        [normalized],
      )
      const row = existing.rows[0]

      if (row === undefined) {
        const id = randomUUID()
        await c.query(
          `INSERT INTO repo (id, provider, remote_url, default_branch, local_path, issue_label)
           VALUES ($1, 'github', $2, $3, $4, $5)`,
          [id, remoteUrl, defaultBranch, canonicalPath ?? null, issueLabel ?? 'keel'],
        )
        return id
      }

      // 每个 flag 独立判断「不传即保留 / 传了且不同才写」：
      // 只改 label 的调用不能被 local_path 的缺省值顺带覆盖，反之亦然。
      const nextPath = canonicalPath !== undefined && row.local_path !== canonicalPath
      const nextLabel = issueLabel !== undefined && row.issue_label !== issueLabel
      if (!nextPath && !nextLabel) return row.id

      updatingRepoId = row.id
      if (nextPath) {
        await c.query(`UPDATE repo SET local_path = $1 WHERE id = $2`, [canonicalPath, row.id])
      }
      if (nextLabel) {
        await c.query(`UPDATE repo SET issue_label = $1 WHERE id = $2`, [issueLabel, row.id])
      }
      return row.id
    })

    console.log(`repoId: ${repoId}`)
    if (canonicalPath !== undefined) console.log(`localPath: ${canonicalPath}`)
    if (issueLabel !== undefined) console.log(`issueLabel: ${issueLabel}`)
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
