import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { PR_BINDING_FILTER } from '../../fact/task-pull-request.js'
import type { CiFailureEvidence } from '../../shared/ci.js'
import { type RecoveryAttempt, type RecoveryBinding, selectRecovery } from '../recovery-policy.js'
import type { WorkspaceBinding } from './effects.js'
import { MAX_DEV_ATTEMPTS } from './facts.js'

interface CiRepairReceipt {
  readonly binding: RecoveryBinding
  readonly fingerprint: string
  readonly evidence_seq: string
  readonly failure_key: string
  readonly pr_number: number
  readonly repo_id: string
}

type CiRepairApproval =
  | { readonly allowed: true; readonly receipt: CiRepairReceipt }
  | { readonly allowed: false; readonly reason: string }

interface CiReviewEvidence {
  readonly seq: string
  readonly head_sha: string | null
  readonly pr_number: string | null
  readonly ci_failure: CiFailureEvidence | null
}

const stage = 'legacy-ci'

function fingerprint(evidence: CiFailureEvidence): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        checks: evidence.checks.map(({ name, conclusion }) => `${name}:${conclusion}`).sort(),
        jobs: evidence.jobs
          .map(({ name, failedSteps }) => [name, ...[...failedSteps].sort()])
          .sort(),
      }),
    )
    .digest('hex')
}

function repairBinding(
  taskId: string,
  pr: { repo_id: string; number: string },
  headSha: string,
): RecoveryBinding {
  return {
    commit: headSha,
    packageDigest: 'legacy-v01',
    workspace: `${pr.repo_id}/${taskId}/pull/${pr.number}`,
  }
}

export async function readCiRepairApproval(
  c: PoolClient,
  taskId: string,
  hasNote: boolean,
  workspace: WorkspaceBinding | undefined,
): Promise<CiRepairApproval> {
  if (!hasNote) return { allowed: false, reason: 'CI 定向返工须填写修复理由。' }

  const current = await c.query<CiReviewEvidence & { repo_id: string; number: string }>(
    `WITH binding AS (
       SELECT seq, payload->>'pr_number' AS number
       FROM event WHERE task_id=$1 AND ${PR_BINDING_FILTER}
       ORDER BY seq DESC LIMIT 1
     ), evidence AS (
       SELECT seq, payload FROM event
       WHERE task_id=$1 AND (
           (type='TaskStatusChanged' AND payload->>'transition'='T-026'
             AND payload->>'source'='github')
           OR type='CiRecoveryObservation'
         )
         AND seq > COALESCE((SELECT max(seq) FROM event
           WHERE task_id=$1 AND type='TaskStatusChanged'
             AND payload->>'transition' IN ('T-016','T-017','T-021','T-045')), 0)
       ORDER BY seq DESC LIMIT 1
     )
     SELECT task.repo_id, binding.number, evidence.seq,
            evidence.payload->>'head_sha' AS head_sha, evidence.payload->>'pr_number' AS pr_number,
            evidence.payload->'ci_failure' AS ci_failure
     FROM task JOIN binding ON true JOIN evidence ON evidence.seq > binding.seq
     WHERE task.id=$1`,
    [taskId],
  )
  const observed = current.rows[0]
  if (
    observed === undefined ||
    observed.head_sha === null ||
    !/^[a-f0-9]{40}$/i.test(observed.head_sha) ||
    (observed.pr_number !== null && observed.pr_number !== observed.number) ||
    observed.ci_failure === null
  )
    return { allowed: false, reason: '缺少绑定当前 PR 和 SHA 的 CI 失败证据。' }

  if (workspace !== undefined) {
    const head = await workspace.git.headSha(workspace.project, taskId)
    if (workspace.repoId !== observed.repo_id || !head.ok || head.value !== observed.head_sha)
      return { allowed: false, reason: '工作分支与当前 CI 失败目标不符。' }
  }

  const evidence = observed.ci_failure
  if (
    !evidence.checks.some(({ conclusion }) => conclusion === 'failure') ||
    !evidence.jobs.some(({ failedSteps }) => failedSteps.length > 0)
  )
    return { allowed: false, reason: 'CI 失败证据不足以定位返工，需先核实失败原因。' }

  const used = await c.query<{
    receipt: CiRepairReceipt | null
    prior_head: string | null
    prior_failure: CiFailureEvidence | null
    prior_pr: string | null
  }>(
    `SELECT approval.payload->'ci_repair' AS receipt,
            previous.payload->>'head_sha' AS prior_head,
            previous.payload->'ci_failure' AS prior_failure,
            COALESCE(previous.payload->>'pr_number', (
              SELECT payload->>'pr_number' FROM event
              WHERE task_id=$1 AND seq < approval.seq AND ${PR_BINDING_FILTER}
              ORDER BY seq DESC LIMIT 1
            )) AS prior_pr
     FROM event approval
     LEFT JOIN LATERAL (
       SELECT payload FROM event
       WHERE task_id=$1 AND type='TaskStatusChanged'
         AND payload->>'transition'='T-026' AND payload->>'source'='github'
         AND seq < approval.seq
       ORDER BY seq DESC LIMIT 1
     ) previous ON NOT (approval.payload ? 'ci_repair')
     WHERE approval.task_id=$1 AND approval.type='TaskStatusChanged'
       AND approval.payload->>'transition'='T-014'
       AND (approval.payload ? 'ci_repair' OR EXISTS (
         SELECT 1 FROM event decision WHERE task_id=$1 AND type='HumanDecision'
           AND payload->>'ci_repair_transition_seq'=approval.seq::text
       ))`,
    [taskId],
  )
  const history: RecoveryAttempt[] = []
  for (const attempt of used.rows) {
    if (attempt.receipt !== null) {
      history.push({
        action: 'rework',
        stage,
        binding: attempt.receipt.binding,
        fingerprint: attempt.receipt.fingerprint,
      })
    } else if (attempt.prior_head !== null && attempt.prior_failure !== null && attempt.prior_pr) {
      history.push({
        action: 'rework',
        stage,
        binding: repairBinding(
          taskId,
          { repo_id: observed.repo_id, number: attempt.prior_pr },
          attempt.prior_head,
        ),
        fingerprint: fingerprint(attempt.prior_failure),
      })
    }
  }

  const binding = repairBinding(taskId, observed, observed.head_sha)
  const failureFingerprint = fingerprint(evidence)
  const evidenceRef = `event:${observed.seq}`
  const selection = selectRecovery({
    stage,
    binding,
    failure: { kind: 'unknown', fingerprint: failureFingerprint, evidenceRef },
    history,
    remaining: {
      code: MAX_DEV_ATTEMPTS - used.rows.length,
      observation: 0,
      infrastructure: 0,
      verification: 0,
    },
    authorization: {
      action: 'rework',
      stage,
      binding,
      fingerprint: failureFingerprint,
      evidenceRef,
    },
  })
  if (selection.action !== 'rework') {
    return {
      allowed: false,
      reason:
        selection.reason === 'no_progress'
          ? '当前 CI 目标和失败证据已派发过定向返工。'
          : 'CI 定向返工预算已用尽。',
    }
  }
  return {
    allowed: true,
    receipt: {
      binding,
      fingerprint: failureFingerprint,
      evidence_seq: observed.seq,
      failure_key: evidence.key,
      pr_number: Number(observed.number),
      repo_id: observed.repo_id,
    },
  }
}
