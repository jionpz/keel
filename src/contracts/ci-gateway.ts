/**
 * CI 外部事实源网关。
 *
 * CI 是 Keel 的外部事实源（docs/09-roadmap.md §3），系统本身不产生它。
 * 本接口把“等待/读取 GitHub Checks + Commit Status”包装成 Control Plane 可依赖的薄边界。
 */

import type { Result } from './errors.js'

export interface CiWaitInput {
  readonly repoId: string
  /** 远程仓库 URL，例如 https://github.com/owner/repo.git */
  readonly remoteUrl: string
  /** PR head 的 commit SHA */
  readonly headSha: string
  /** 已知 PR 编号时传入，便于直接查 PR checks */
  readonly prNumber?: number
}

export interface CiGateway {
  /**
   * 等待 CI 到达终态。
   *
   * 返回 'passed' | 'failed'；超时或不可恢复错误按失败处理（由调用方决定是否重试/升人工）。
   */
  waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>>
}
