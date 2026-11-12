import type { Result } from './errors.js'

/**
 * PM 的仓库信号查询。
 *
 * 只读取仓库里已经发生的事实，不触发任何写操作。`now` 由调用方注入，
 * 保证同一份上下文可以按同一个时间窗口复现。
 */
export interface RepoSignalsQuery {
  readonly remoteUrl: string
  readonly defaultBranch: string
  /** 来源 issue 编号；manual feedback 没有编号时为 null */
  readonly issueNumber: number | null
  readonly issueTitle: string
  readonly issueBody: string
  readonly sinceDays: number
  readonly now: string
  readonly maxCommits: number
  readonly maxIssues: number
  readonly maxPullRequests: number
}

export interface RepoSignalCommit {
  readonly sha: string
  readonly title: string
  readonly committedAt: string
  readonly url: string
}

export interface RepoSignalItem {
  readonly number: number
  readonly title: string
  readonly state: 'open' | 'closed'
  readonly url: string
  readonly isPullRequest: boolean
  /** 仅 PR 有意义；search API 的 merged_at 非空即为已合并 */
  readonly merged: boolean
}

/**
 * 一次查询的事实快照。
 *
 * `commits` 与 `issues` / `pullRequests` 是关键词过滤后的相关项；
 * `referencedCommits` / `referencedPullRequests` 是明确引用本 issue 号的项。
 * 两者刻意分开：关键词相似只是线索，引用编号才是更强的关系证据。
 */
export interface RepoSignals {
  readonly commits: readonly RepoSignalCommit[]
  readonly issues: readonly RepoSignalItem[]
  readonly pullRequests: readonly RepoSignalItem[]
  readonly referencedCommits: readonly RepoSignalCommit[]
  readonly referencedPullRequests: readonly RepoSignalItem[]
}

/** 只读仓库信号源。失败由调用方降级为空，不阻塞 PM。 */
export interface RepoSignalsSource {
  load(query: RepoSignalsQuery): Promise<Result<RepoSignals>>
}
