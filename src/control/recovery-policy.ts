import type { ErrorKind } from '../contracts/errors.js'

export interface RecoveryBinding {
  readonly commit: string | null
  readonly packageDigest: string
  readonly workspace: string
}

export interface RecoveryFailure {
  readonly kind:
    | 'observation'
    | 'infrastructure'
    | 'unknown'
    | 'environment'
    | 'guard'
    | 'permission'
    | 'protocol'
    | 'terminal'
  readonly error?: ErrorKind
  readonly fingerprint: string
  readonly evidenceRef: string
}

const recoveryBudgets = {
  observe: 'observation',
  retry_stage: 'infrastructure',
  reverify: 'verification',
  rework: 'code',
} as const

type AutomaticRecovery = keyof typeof recoveryBudgets
type RecoveryBudget = (typeof recoveryBudgets)[AutomaticRecovery]

export interface RecoveryAttempt {
  readonly action: AutomaticRecovery
  readonly stage: string
  readonly binding: RecoveryBinding
  readonly fingerprint: string
}

export interface RecoveryAuthorization {
  readonly action: 'rework'
  readonly stage: string
  readonly binding: RecoveryBinding
  readonly fingerprint: string
  readonly evidenceRef: string
}

export interface RecoveryInput {
  readonly stage: string
  readonly binding: RecoveryBinding
  readonly failure: RecoveryFailure
  readonly history: readonly RecoveryAttempt[]
  readonly remaining: Readonly<Record<RecoveryBudget, number>>
  readonly authorization?: RecoveryAuthorization
}

type RecoveryReason =
  | 'transient_observation'
  | 'transient_infrastructure'
  | 'verify_same_commit'
  | 'confirmed_guard_failure'
  | 'authorized_rework'
  | 'budget_exhausted'
  | 'no_progress'
  | 'environment_failure'
  | 'unknown_failure'
  | 'permission_failure'
  | 'protocol_failure'
  | 'terminal_failure'

export type RecoverySelection =
  | {
      readonly action: AutomaticRecovery
      readonly reason: RecoveryReason
      readonly evidenceRef: string
      readonly budget: RecoveryBudget
    }
  | {
      readonly action: 'decide' | 'stop'
      readonly reason: RecoveryReason
      readonly evidenceRef: string
      readonly budget: null
    }

function sameBinding(left: RecoveryBinding, right: RecoveryBinding): boolean {
  return (
    left.commit === right.commit &&
    left.packageDigest === right.packageDigest &&
    left.workspace === right.workspace
  )
}

export function selectRecovery(input: RecoveryInput): RecoverySelection {
  const { stage, binding, failure, history, remaining, authorization } = input
  const { evidenceRef } = failure
  const stop = (reason: RecoveryReason): RecoverySelection => ({
    action: 'stop',
    reason,
    evidenceRef,
    budget: null,
  })
  const decide = (reason: RecoveryReason): RecoverySelection => ({
    action: 'decide',
    reason,
    evidenceRef,
    budget: null,
  })
  const choose = (action: AutomaticRecovery, reason: RecoveryReason): RecoverySelection => {
    const budget = recoveryBudgets[action]
    if (remaining[budget] <= 0) return decide('budget_exhausted')
    const repeated = history.some(
      (attempt) =>
        attempt.action === action &&
        attempt.stage === stage &&
        sameBinding(attempt.binding, binding) &&
        (action === 'reverify' ||
          action === 'rework' ||
          attempt.fingerprint === failure.fingerprint),
    )
    return repeated ? decide('no_progress') : { action, reason, evidenceRef, budget }
  }

  if (
    failure.kind === 'permission' ||
    failure.error === 'AUTH_FAILED' ||
    failure.error === 'PERMISSION_DENIED'
  )
    return stop('permission_failure')
  if (
    failure.kind === 'protocol' ||
    failure.error === 'PROTOCOL_ERROR' ||
    failure.error === 'SCHEMA_VIOLATION'
  )
    return stop('protocol_failure')
  if (failure.kind === 'terminal') return stop('terminal_failure')
  if (failure.kind === 'observation') return choose('observe', 'transient_observation')
  if (failure.kind === 'infrastructure') return choose('retry_stage', 'transient_infrastructure')
  if (binding.commit === null)
    return decide(failure.kind === 'environment' ? 'environment_failure' : 'unknown_failure')
  if (failure.kind === 'guard') return choose('rework', 'confirmed_guard_failure')
  if (
    failure.kind === 'unknown' &&
    authorization?.stage === stage &&
    sameBinding(authorization.binding, binding) &&
    authorization.fingerprint === failure.fingerprint &&
    authorization.evidenceRef === evidenceRef
  )
    return choose('rework', 'authorized_rework')
  const selection = choose('reverify', 'verify_same_commit')
  if (selection.action === 'decide')
    return decide(failure.kind === 'environment' ? 'environment_failure' : selection.reason)
  return selection
}
