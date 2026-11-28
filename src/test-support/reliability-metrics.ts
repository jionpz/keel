export interface ReliabilityWindow {
  readonly start: string
  readonly end: string
}

interface AttemptEvidence {
  readonly id: string
  readonly startedAt: string
  readonly repeatedWithoutProgress: boolean | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
}

interface CiIncidentEvidence {
  readonly key: string
  readonly failedAt: string
  readonly recoveredAt: string | null
  readonly sameTarget: boolean | null
  readonly extraCodeAttempts: number | null
  readonly humanIntervened: boolean | null
}

interface ApprovalEvidence {
  readonly submissionId: string
  readonly recoveryKey: string
  readonly submittedAt: string
}

export interface ReliabilityTaskEvidence {
  readonly taskId: string
  readonly claimedAt: string
  readonly deliveredAt: string | null
  readonly humanIntervened: boolean | null
  readonly attempts: readonly AttemptEvidence[]
  readonly incidents: readonly CiIncidentEvidence[]
  readonly approvals: readonly ApprovalEvidence[]
  readonly terminal: {
    readonly at: string
    readonly remoteAgreement: boolean | null
  } | null
}

interface Rate {
  readonly numerator: number
  readonly denominator: number
  readonly unknown: number
}

function rate(values: readonly (boolean | null)[]): Rate {
  return {
    numerator: values.filter((value) => value === true).length,
    denominator: values.length,
    unknown: values.filter((value) => value === null).length,
  }
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
  return [...new Map(values.map((value) => [key(value), value])).values()]
}

export function summarizeReliability(
  window: ReliabilityWindow,
  evidence: readonly ReliabilityTaskEvidence[],
) {
  const start = Date.parse(window.start)
  const end = Date.parse(window.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error('可靠性指标需要有效的观察窗口')
  const inWindow = (timestamp: string | null) => {
    if (timestamp === null) return false
    const time = Date.parse(timestamp)
    return time >= start && time < end
  }
  const tasks = uniqueBy(evidence, ({ taskId }) => taskId).filter(({ claimedAt }) =>
    inWindow(claimedAt),
  )

  const delivery = tasks.map((task) =>
    inWindow(task.deliveredAt)
      ? task.humanIntervened === null
        ? null
        : !task.humanIntervened
      : false,
  )

  const usage = tasks.map((task) => {
    const attempts = uniqueBy(task.attempts, ({ id }) => id).filter(({ startedAt }) =>
      inWindow(startedAt),
    )
    const knownTokens = attempts.reduce(
      (total, { tokensIn, tokensOut }) => total + (tokensIn ?? 0) + (tokensOut ?? 0),
      0,
    )
    const unknownAttempts = attempts.filter(
      ({ tokensIn, tokensOut }) => tokensIn === null || tokensOut === null,
    ).length
    return {
      taskId: task.taskId,
      tokens: unknownAttempts === 0 ? knownTokens : null,
      knownTokens,
      unknownAttempts,
      retries: rate(attempts.map(({ repeatedWithoutProgress }) => repeatedWithoutProgress)),
    }
  })

  const ciRecovery = tasks.flatMap((task) =>
    uniqueBy(task.incidents, ({ key }) => key)
      .filter(({ failedAt }) => inWindow(failedAt))
      .map((incident) => {
        if (!inWindow(incident.recoveredAt)) return false
        if (
          incident.sameTarget === null ||
          incident.extraCodeAttempts === null ||
          incident.humanIntervened === null
        )
          return null
        return incident.sameTarget && incident.extraCodeAttempts === 0 && !incident.humanIntervened
      }),
  )

  const repeatApprovals = tasks.reduce((total, task) => {
    const approvals = uniqueBy(task.approvals, ({ submissionId }) => submissionId).filter(
      ({ submittedAt }) => inWindow(submittedAt),
    )
    return total + approvals.length - new Set(approvals.map(({ recoveryKey }) => recoveryKey)).size
  }, 0)

  const remoteAgreement = tasks.flatMap(({ terminal }) =>
    terminal === null || !inWindow(terminal.at) ? [] : [terminal.remoteAgreement],
  )

  return {
    window,
    deliveryWithoutIntervention: rate(delivery),
    retriesWithoutProgress: usage.reduce(
      (count, { retries }) => ({
        count: count.count + retries.numerator,
        unknown: count.unknown + retries.unknown,
      }),
      { count: 0, unknown: 0 },
    ),
    taskTokens: usage.map(({ taskId, tokens, knownTokens, unknownAttempts }) => ({
      taskId,
      tokens,
      knownTokens,
      unknownAttempts,
    })),
    externalCiRecoveryWithoutIntervention: rate(ciRecovery),
    repeatApprovals,
    terminalRemoteAgreement: rate(remoteAgreement),
  }
}
