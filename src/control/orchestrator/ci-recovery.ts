import type { CiGateway, CiObservation, CiWaitInput } from '../../contracts/ci-gateway.js'
import type { ErrorKind } from '../../contracts/errors.js'
import { asRole } from '../../fact/db.js'
import { PR_BINDING_FILTER } from '../../fact/task-pull-request.js'
import { ensureTraceId } from '../../fact/trace.js'
import { CURRENT_CI_REVIEW_SQL } from '../driver/facts.js'

// Actions 接受重跑后，旧的红灯可能暂时仍可见。留出它发布新一轮检查的时间。
const RERUN_SETTLE_MS = 2 * 60_000

const latestReviewSeq = `SELECT seq FROM event
  WHERE task_id=$1 AND type='TaskStatusChanged' AND payload->>'to'='S-HUMAN_REVIEW'
  ORDER BY seq DESC LIMIT 1`

export async function readCiRepairForDevelop(
  taskId: string,
): Promise<{ head_sha: string; repo_id: string; refreshed_evidence: string | null } | undefined> {
  const result = await asRole('keel_control', (c) =>
    c.query<{ head_sha: string; repo_id: string; refreshed_evidence: string | null }>(
      `WITH origin AS (
         SELECT payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
           AND payload->>'transition' IN ('T-014','T-016','T-017','T-019','T-021','T-022','T-045')
         ORDER BY seq DESC LIMIT 1
       )
       SELECT origin.payload #>> '{ci_repair,binding,commit}' AS head_sha,
              origin.payload #>> '{ci_repair,repo_id}' AS repo_id,
              left(observation.payload::text, 4000) AS refreshed_evidence
       FROM origin LEFT JOIN event observation
         ON observation.seq::text=origin.payload #>> '{ci_repair,evidence_seq}'
        AND observation.task_id=$1 AND observation.type='CiRecoveryObservation'
       WHERE origin.payload ? 'ci_repair'`,
      [taskId],
    ),
  )
  return result.rows[0]
}

export async function readCiReviewSeq(taskId: string): Promise<string | undefined> {
  const result = await asRole('keel_control', (c) =>
    c.query<{ seq: string | null }>(
      `SELECT CASE WHEN (${CURRENT_CI_REVIEW_SQL}) THEN (${latestReviewSeq}) END AS seq`,
      [taskId],
    ),
  )
  return result.rows[0]?.seq ?? undefined
}

export async function recordCiReviewObservation(
  target: {
    readonly taskId: string
    readonly reviewSeq: string
    readonly prNumber: number
    readonly headSha?: string
  },
  observation: CiObservation | { readonly state: 'unavailable'; readonly error: ErrorKind },
  now: string,
): Promise<void> {
  const { taskId, reviewSeq, prNumber, headSha } = target
  const payload = JSON.stringify({
    state: observation.state,
    source: 'github',
    pr_number: prNumber,
    head_sha: headSha,
    ...(observation.state === 'failed' ? { ci_failure: observation.evidence } : {}),
    ...(observation.state === 'unavailable' ? { error: observation.error } : {}),
  })
  await asRole('keel_control', async (c) => {
    const task = await c.query(
      `SELECT id FROM task WHERE id=$1 AND status='S-HUMAN_REVIEW' AND control_mode='auto' FOR UPDATE`,
      [taskId],
    )
    if (task.rowCount === 0) return
    const prior = await c.query<{ should_record: boolean }>(
      `SELECT ($2::bigint=(${latestReviewSeq})
        AND $3::text=(SELECT payload->>'pr_number' FROM event
          WHERE task_id=$1 AND ${PR_BINDING_FILTER} ORDER BY seq DESC LIMIT 1)
        AND ($4::jsonb IS DISTINCT FROM (SELECT CASE WHEN type='CiRecoveryObservation'
          THEN payload ELSE jsonb_strip_nulls(jsonb_build_object(
            'state', CASE WHEN payload ? 'ci_failure' THEN 'failed' ELSE 'unreported' END,
            'source', 'github',
            'pr_number', COALESCE((payload->>'pr_number')::integer, $3::text::integer),
            'head_sha', payload->>'head_sha',
            'ci_failure', payload->'ci_failure')) END
          FROM event WHERE task_id=$1 AND (type='CiRecoveryObservation'
            OR (type='TaskStatusChanged' AND payload->>'transition'='T-026'
              AND payload->>'source'='github'))
          ORDER BY seq DESC LIMIT 1))) AS should_record`,
      [taskId, reviewSeq, prNumber, payload],
    )
    if (prior.rows[0]?.should_record !== true) return
    const trace = await ensureTraceId(c, taskId, now)
    await c.query(
      `INSERT INTO event (task_id,type,payload,trace_id,occurred_at)
       VALUES ($1,'CiRecoveryObservation',$2::jsonb,$3,$4)`,
      [taskId, payload, trace, now],
    )
  })
}

export async function shouldWaitForCiRerun(
  taskId: string,
  gateway: CiGateway,
  input: CiWaitInput,
  failure: Extract<CiObservation, { state: 'failed' }>,
  now: string,
): Promise<boolean> {
  const attempt = await asRole('keel_control', async (c) => {
    // 在单一事务内锁 task、查预算、登记授权。进程退出或并行 poller 都不会重复 POST。
    const task = await c.query(
      `SELECT id FROM task WHERE id=$1 AND status='S-PR_OPEN' AND control_mode='auto' FOR UPDATE`,
      [taskId],
    )
    if (task.rowCount === 0) return 'stop'
    const history = await c.query<{
      type: string
      key: string | null
      reason: string | null
      occurred_at: Date
    }>(
      `SELECT type, payload->>'failure_key' AS key, payload->>'reason' AS reason, occurred_at
       FROM event WHERE task_id=$1 AND type IN ('CiRerunClaimed','CiRerunUnconfirmed')
         AND payload->>'head_sha'=$2 AND payload->>'pr_number'=$3
       ORDER BY seq DESC LIMIT 1`,
      [taskId, input.headSha, input.prNumber],
    )
    const previous = history.rows[0]
    if (previous !== undefined) {
      if (previous.key !== failure.evidence.key) return 'handoff'
      if (previous.reason === 'STALE_EVIDENCE') return 'stop'
      if (
        previous.type === 'CiRerunClaimed' &&
        Date.parse(now) - previous.occurred_at.getTime() < RERUN_SETTLE_MS
      )
        return 'stop'
      return 'handoff'
    }
    if (gateway.rerunFailedCi === undefined || failure.rerun === undefined) return 'handoff'
    const trace = await ensureTraceId(c, taskId, now)
    await c.query(
      `INSERT INTO event (task_id,type,payload,trace_id,occurred_at)
       VALUES ($1,'CiRerunClaimed',$2::jsonb,$3,$4)`,
      [
        taskId,
        JSON.stringify({
          pr_number: input.prNumber,
          head_sha: input.headSha,
          failure_key: failure.evidence.key,
          run_id: failure.rerun.runId,
          attempt: failure.rerun.attempt,
        }),
        trace,
        now,
      ],
    )
    return 'requested'
  })
  if (attempt !== 'requested') return attempt === 'stop'
  if (gateway.rerunFailedCi === undefined || failure.rerun === undefined) return false
  const result = await gateway.rerunFailedCi(input, failure.rerun)
  if (result.ok && result.value) return true

  // 请求结果不确定时仍观察 GitHub。即使远端已经接受，也不发第二次请求。
  await asRole('keel_control', async (c) => {
    const trace = await ensureTraceId(c, taskId, now)
    await c.query(
      `INSERT INTO event (task_id,type,payload,trace_id,occurred_at)
       VALUES ($1,'CiRerunUnconfirmed',$2::jsonb,$3,$4)`,
      [
        taskId,
        JSON.stringify({
          pr_number: input.prNumber,
          head_sha: input.headSha,
          failure_key: failure.evidence.key,
          reason: result.ok ? 'attempt_changed_or_rejected' : result.error.kind,
        }),
        trace,
        now,
      ],
    )
  })
  return !result.ok && (result.error.kind === 'STALE_EVIDENCE' || result.error.kind === 'CONFLICT')
}
