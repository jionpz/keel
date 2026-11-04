/**
 * 读一个 task 的仓库信息，准备好项目与基线，返回可直接注入 driver 的 workspace 绑定。
 *
 * 抽出来的原因：`keel run-task` 与 `keel decide … approve` 都需要同一件事 ——
 * T-014 的 `CreateBranch` 只有在注入了 workspace 时才会真的建 worktree；
 * 不注入就只记意图，之后驱动 develop 时没有工作树可用。
 * 两份接线一旦分叉，「批准后能跑」就会变成一个只有一条路径成立的事实。
 *
 * 读 task + repo 用 `keel_control` 身份：`asOwner` 按 `fact/db.ts` 的纪律只留给
 * 测试装置与迁移，生产命令不该用属主权限读生产数据。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { WorkspaceBinding } from '../control/driver/effects.js'
import { asRole } from '../fact/db.js'
import { GitWorkspace, type ProjectBinding } from '../fact/git-workspace.js'

export async function loadTaskWorkspace(taskId: string): Promise<Result<WorkspaceBinding>> {
  const info = await asRole('keel_control', (c) =>
    c.query<{
      repo_id: string
      base_branch: string
      remote_url: string
      local_path: string | null
    }>(
      `SELECT t.repo_id, t.base_branch, r.remote_url, r.local_path
       FROM task t JOIN repo r ON r.id = t.repo_id WHERE t.id = $1`,
      [taskId],
    ),
  )
  const row = info.rows[0]
  if (row === undefined) {
    return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))
  }

  // 持久项目根 → 绑定项目 → 同步基线。失败即不推进。
  const git = new GitWorkspace()
  const projectBinding: ProjectBinding =
    row.local_path === null
      ? { mode: 'managed', repoId: row.repo_id }
      : { mode: 'attached', repoId: row.repo_id, localPath: row.local_path }
  const prepared = await git.prepareProject(projectBinding, row.remote_url, row.base_branch)
  if (!prepared.ok) return prepared

  return ok({ git, repoId: row.repo_id, project: prepared.value })
}
