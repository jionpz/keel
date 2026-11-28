import { expect, it } from 'vitest'
import { type ReliabilityTaskEvidence, summarizeReliability } from './reliability-metrics.js'

const start = '2026-11-01T00:00:00Z'
const during = '2026-11-01T00:10:00Z'
const end = '2026-11-01T01:00:00Z'
const window = { start, end }

it('从同一观察窗的回放证据计算可靠性指标，保留未知量与重复投递', () => {
  const firstAttempt = {
    id: 'run-one',
    startedAt: during,
    repeatedWithoutProgress: false,
    tokensIn: 32,
    tokensOut: 3,
  }
  const incident = {
    key: 'pr-7-head-A-failure',
    failedAt: during,
    recoveredAt: during,
    sameTarget: true,
    extraCodeAttempts: 0,
    humanIntervened: false,
  }
  const approval = { submissionId: 'answer-1', recoveryKey: 'failure-B-r1', submittedAt: during }
  const delivered: ReliabilityTaskEvidence = {
    taskId: 'delivered',
    claimedAt: start,
    deliveredAt: during,
    humanIntervened: false,
    attempts: [firstAttempt, firstAttempt],
    incidents: [incident, incident, { ...incident, key: 'second', recoveredAt: end }],
    approvals: [],
    terminal: { at: during, remoteAgreement: true },
  }
  const waiting: ReliabilityTaskEvidence = {
    taskId: 'waiting',
    claimedAt: during,
    deliveredAt: null,
    humanIntervened: null,
    attempts: [
      {
        ...firstAttempt,
        id: 'run-two',
        repeatedWithoutProgress: true,
        tokensOut: null,
      },
      { ...firstAttempt, id: 'run-outside', startedAt: end },
    ],
    incidents: [{ ...incident, key: 'third', sameTarget: null }],
    approvals: [approval, approval, { ...approval, submissionId: 'answer-2' }],
    terminal: { at: during, remoteAgreement: null },
  }
  expect(
    summarizeReliability(window, [
      delivered,
      waiting,
      { ...waiting, taskId: 'outside', claimedAt: end },
    ]),
  ).toEqual({
    window,
    deliveryWithoutIntervention: { numerator: 1, denominator: 2, unknown: 0 },
    retriesWithoutProgress: { count: 1, unknown: 0 },
    taskTokens: [
      { taskId: 'delivered', tokens: 35, knownTokens: 35, unknownAttempts: 0 },
      { taskId: 'waiting', tokens: null, knownTokens: 32, unknownAttempts: 1 },
    ],
    externalCiRecoveryWithoutIntervention: { numerator: 1, denominator: 3, unknown: 1 },
    repeatApprovals: 1,
    terminalRemoteAgreement: { numerator: 1, denominator: 2, unknown: 1 },
  })
})
