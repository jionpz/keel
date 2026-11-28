import type { RepoVerificationContract } from '../generated/managed.js'
import type { Result } from './errors.js'

export type ProjectCheck = RepoVerificationContract['checks'][number]
export type LocalProjectCheck = Extract<ProjectCheck, { kind: 'local' }>

export interface ProjectRule {
  readonly path: string
  readonly digest: string
  readonly content: string
}

export interface ProjectVerificationBinding {
  readonly baseline: string
  readonly contract: RepoVerificationContract | null
  readonly rules: readonly ProjectRule[]
}

export interface ProjectCheckResult {
  readonly id: string
  readonly argv: readonly string[]
  readonly exit_code: number
  readonly output_excerpt: string
}

export type ProjectVerificationRunner = (input: {
  readonly workspace: string
  readonly checks: readonly LocalProjectCheck[]
  readonly signal?: AbortSignal
  readonly timeoutMs: number
}) => Promise<Result<readonly ProjectCheckResult[]>>
