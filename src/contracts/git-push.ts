import type { Result } from './errors.js'

export interface GitPushInput {
  readonly worktreePath: string
  readonly remoteUrl: string
  readonly headBranch: string
  readonly headSha: string
}

export interface GitPushResult {
  readonly headSha: string
  readonly created: boolean
}

export interface GitPushInspectInput {
  readonly worktreePath: string
  readonly remoteUrl: string
  readonly headBranch: string
}

export interface GitPushInspectResult {
  readonly state: 'absent' | 'present'
  readonly headSha: string | null
}

export interface GitPushGateway {
  push(input: GitPushInput): Promise<Result<GitPushResult>>
  inspect(input: GitPushInspectInput): Promise<Result<GitPushInspectResult>>
}
