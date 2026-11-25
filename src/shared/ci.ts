export interface CiFailureEvidence {
  readonly key: string
  readonly checks: readonly {
    readonly name: string
    readonly conclusion: string
    readonly summary?: string
  }[]
  readonly jobs: readonly { readonly name: string; readonly failedSteps: readonly string[] }[]
  readonly url?: string
}

export const EMPTY_DEVELOP_DIFF = 'develop 声称 implemented，但工作区在 git 上没有任何改动'
