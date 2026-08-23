/**
 * Git 托管方网关 —— 创建 PR 等写操作。
 *
 * 与 HarnessAdapter 一样，Control Plane 只依赖接口，不依赖具体实现。
 * v0.1 的 GitHub 实现放在 src/fact/github-provider.ts；本文件不包含实现。
 */

import type { Result } from './errors.js'

export interface PullRequestInput {
  readonly repoId: string
  /** 远程仓库 URL，例如 https://github.com/owner/repo.git */
  readonly remoteUrl: string
  /** PR 目标分支（通常是 repo.default_branch） */
  readonly baseBranch: string
  /** PR 源分支（必须是 ai/* 命名空间） */
  readonly headBranch: string
  readonly title: string
  readonly body: string
}

export interface PullRequestInfo {
  readonly number: number
  readonly url: string
  /** true = 本次新建；false = 该 head 分支已有 PR，复用 */
  readonly created: boolean
}

/**
 * 创建 PR 的网关。
 *
 * 必须幂等：同一 head 分支已有 PR 时返回已有 PR，而不是再建一个。
 */
export interface PullRequestGateway {
  createPullRequest(input: PullRequestInput): Promise<Result<PullRequestInfo>>
}
