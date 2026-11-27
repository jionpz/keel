import type { CiGateway, CiObservation, CiWaitInput } from '../../contracts/ci-gateway.js'
import { asRole } from '../../fact/db.js'
import { ensureTraceId } from '../../fact/trace.js'

// Actions 接受重跑后，旧的红灯可能暂时仍可见。留出它发布新一轮检查的时间。
const RERUN_SETTLE_MS = 2 * 60_000

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
