import type { Result } from './errors.js'

export type RequiredCheckSource = 'check_run' | 'commit_status'

export interface RequiredCheckFact {
  readonly name: string
  readonly source: RequiredCheckSource
  readonly conclusion: string
  readonly externalId: string | null
  readonly detailsUrl: string | null
}

export interface RequiredCheckObservationInput {
  readonly repoId: string
  readonly remoteUrl: string
  readonly prNumber: number
  readonly requiredChecks: readonly string[]
  readonly observedAt: string
}

export interface RequiredCheckSnapshot {
  readonly repoId: string
  readonly repo: string
  readonly remoteUrl: string
  readonly prNumber: number
  readonly prUrl: string
  readonly prState: 'open' | 'closed'
  readonly headBranch: string
  readonly baseBranch: string
  readonly headSha: string
  readonly observedAt: string
  readonly checks: readonly RequiredCheckFact[]
}

export interface RequiredCheckGateway {
  observeRequiredChecks(
    input: RequiredCheckObservationInput,
  ): Promise<Result<RequiredCheckSnapshot>>
}
