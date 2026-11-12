import type { Result } from './errors.js'

export interface IssueComment {
  readonly id: number
  readonly body: string
  readonly author: string
  readonly createdAt: string
}

export interface IssueCommentPage {
  readonly comments: readonly IssueComment[]
  readonly truncated: boolean
}

export interface IssueGateway {
  createIssueComment(remoteUrl: string, number: number, body: string): Promise<Result<IssueComment>>
  closeIssue(
    remoteUrl: string,
    number: number,
    reason: 'completed' | 'not_planned',
  ): Promise<Result<void>>
  listIssueComments(
    remoteUrl: string,
    number: number,
    since?: string,
  ): Promise<Result<IssueCommentPage>>
  issueActor(remoteUrl: string): Promise<Result<string>>
}
