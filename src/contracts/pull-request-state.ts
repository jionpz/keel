/**
 * PR 合并/关闭状态的外部事实源。
 *
 * CI 通过只说明代码可交付，不说明交付已完成；对用户而言，
 * 「完成」是 PR 已合并。Control Plane 通过本接口观察 PR 的最终状态，
 * 再把外部事实转成 `PRMerged` / `PRClosed` 事件。
 *
 * 与 `PullRequestGateway` 分开：创建 PR 是写操作，本接口只读。
 * v0.1 的 GitHub 实现：`src/fact/github-provider.ts`。
 */

import type { Result } from './errors.js'

export interface PullRequestStateInput {
  readonly repoId: string
  /** 远程仓库 URL，例如 https://github.com/owner/repo.git */
  readonly remoteUrl: string
  readonly number: number
}

export interface PullRequestState {
  readonly number: number
  readonly url: string
  readonly state: 'open' | 'closed'
  readonly merged: boolean
  /** GitHub 返回的合并时间；未合并时为 null */
  readonly mergedAt: string | null
  /** GitHub 返回的 merge commit SHA；未合并或响应缺失时为 null */
  readonly mergeSha: string | null
  /** GitHub 返回的关闭时间；仍 open 时为 null */
  readonly closedAt: string | null
  /** PR 当前 head SHA；响应缺失时为 null */
  readonly headSha: string | null
}

export interface PullRequestStateGateway {
  getPullRequest(input: PullRequestStateInput): Promise<Result<PullRequestState>>
}
