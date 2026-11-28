import type { PoolClient } from 'pg'
import { err, errorFrom, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedTicketTask } from '../../contracts/managed.js'
import type { PullRequestStateGateway } from '../../contracts/pull-request-state.js'
import { asRole } from '../../fact/db.js'
import type { DecisionRequest } from '../../generated/managed.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { validateCheckWorktree } from './check-gateway.js'
import { observeBoundPullRequest } from './check-reconcile.js'
import {
  checkAuthorizationAvailable,
  lockCheckTargetForRecovery,
  type ManagedCheckTargetRecord,
} from './check-store.js'
import {
  CHECK_REOBSERVATION_CATEGORY,
  getDecisionRequest,
  openDecisionRequestForTicket,
  resolveCheckReobservationDecision,
} from './decision-store.js'
import { ticketEvent } from './ticket-store.js'

function decisionKey(task: ManagedTicketTask, target: ManagedCheckTargetRecord): string {
  return `check-reobserve.${sha256CanonicalJson({
    target: target.id,
    attempt: target.attempts,
    failure: target.failure_kind ?? target.last_error,
    package: task.package_digest,
    generation: task.control_generation,
    stage: task.current_stage,
  })}`
}

function failureCanBeObserved(target: ManagedCheckTargetRecord): boolean {
  if (target.failure_kind !== null)
    return target.failure_kind === 'CHECK_RED' || target.failure_kind === 'CHECK_TIMEOUT'
  return (
    target.last_error?.startsWith('CHECK_TIMEOUT:') === true ||
    target.last_error?.startsWith('required check 未成功：') === true
  )
}

async function recoveryBinding(c: PoolClient, targetId: string) {
  const target = await lockCheckTargetForRecovery(c, targetId)
  if (target === null) throw makeError('NOT_FOUND', '找不到 check target')
  const task = (
    await c.query<ManagedTicketTask>(
      'SELECT * FROM managed_ticket_task WHERE id=$1 FOR UPDATE NOWAIT',
      [target.task_id],
    )
  ).rows[0]
  if (
    task?.status !== 'PR_CHECKS_FAILED' ||
    task.completion_target !== 'pr_ready' ||
    task.current_stage !== 'land' ||
    task.lease_token !== null ||
    target.status !== 'FAILED' ||
    target.lease_token !== null ||
    !failureCanBeObserved(target)
  )
    throw makeError('CONFLICT', '当前失败原因不允许重观测，请先对账并检查本地证据')
  if (target.reobserve_deadline_at !== null)
    throw makeError('CONFLICT', 'check 独立重观测预算已耗尽')
  return { target, task }
}

export async function requestCheckReobservation(
  targetId: string,
  now: string,
): Promise<Result<DecisionRequest>> {
  try {
    return await asRole('keel_control', async (c) => {
      const { target, task } = await recoveryBinding(c, targetId)
      const key = decisionKey(task, target)
      const prior = (
        await c.query<{ id: string; revision: number }>(
          `SELECT id,revision FROM managed_decision_request
           WHERE managed_ticket_task_id=$1 AND decision_key=$2 ORDER BY revision DESC LIMIT 1`,
          [task.id, key],
        )
      ).rows[0]
      if (prior !== undefined) {
        const existing = await getDecisionRequest(prior.id, prior.revision, c)
        if (
          existing?.status === 'WAITING_HUMAN' &&
          task.pending_decision_id === prior.id &&
          task.pending_decision_revision === prior.revision
        )
          return ok(existing)
        return err(makeError('CONFLICT', '同一失败原因的恢复决定已经处理'))
      }
      if (task.pending_decision_id !== null)
        return err(makeError('CONFLICT', 'ticket 已有待决请求'))
      if (!(await checkAuthorizationAvailable(c, target, task.control_generation, now)))
        return err(makeError('PERMISSION_DENIED', '原 PR 绑定、授权或控制代次已失效'))
      const opened = await openDecisionRequestForTicket(
        {
          task_id: task.id,
          repo_id: task.repo_id,
          stage: task.current_stage,
          attempt: target.attempts,
          decision_key: key,
          kind: 'recovery',
          question:
            `PR #${target.pr_number} (${target.head_sha}) 检查失败。${target.last_error ?? ''}`.slice(
              0,
              16000,
            ),
          options: ['重新观测同一 PR、同一提交的 required checks', '停止并保留失败状态'],
          action_category: CHECK_REOBSERVATION_CATEGORY,
          impact: {
            environment: 'local',
            reversibility: 'reversible',
            affected_resources: [`check-target:${target.id}`],
          },
          workflow_digest: task.package_digest,
        },
        now,
        c,
      )
      if (!opened.ok) return opened
      await c.query(
        `UPDATE managed_ticket_task SET pending_decision_id=$2,pending_decision_revision=$3,updated_at=$4
         WHERE id=$1`,
        [task.id, opened.value.id, opened.value.revision, now],
      )
      await ticketEvent(c, task.id, 'ManagedCheckReobservationRequested', {
        targetId,
        requestId: opened.value.id,
        revision: opened.value.revision,
        reason: target.last_error,
      })
      return opened
    })
  } catch (cause) {
    return err(errorFrom(cause, 'CONFLICT', '无法创建 check 恢复决定'))
  }
}

export async function answerCheckReobservation(
  input: {
    readonly targetId: string
    readonly requestId: string
    readonly revision: number
    readonly optionId: 'option-1' | 'option-2'
  },
  gateway: PullRequestStateGateway,
  now: () => string = () => new Date().toISOString(),
): Promise<Result<{ status: 'CHECKING' | 'PR_CHECKS_FAILED'; targetId: string }>> {
  try {
    const preview = await asRole('keel_control', (c) => recoveryBinding(c, input.targetId))
    if (
      preview.task.pending_decision_id !== input.requestId ||
      preview.task.pending_decision_revision !== input.revision
    )
      return err(makeError('CONFLICT', 'ticket 未等待该 check 恢复决定版本'))
    const reobserve = input.optionId === 'option-1'
    if (reobserve) {
      const remote = await observeBoundPullRequest(preview.target, gateway)
      if (!remote.ok) return remote
      if (remote.value.disposition !== 'OPEN')
        return err(
          makeError(
            'STALE_EVIDENCE',
            remote.value.disposition === 'MERGED'
              ? 'PR_MERGED_EVIDENCE_MISSING: PR 已合并，缺少已接纳的检查证据'
              : 'PR_CLOSED_UNMERGED: PR 已关闭且未合并',
          ),
        )
    }
    return await asRole('keel_control', async (c) => {
      const { task, target } = await recoveryBinding(c, input.targetId)
      const key = decisionKey(task, target)
      if (
        key !== decisionKey(preview.task, preview.target) ||
        task.pending_decision_id !== input.requestId ||
        task.pending_decision_revision !== input.revision
      )
        throw makeError('CONFLICT', 'check 恢复绑定或 ticket 控制代次已变化')
      if (reobserve) {
        const worktree = await validateCheckWorktree(task, target)
        if (!worktree.ok) return worktree
      }
      const checkedAt = now()
      if (
        reobserve &&
        !(await checkAuthorizationAvailable(c, target, task.control_generation, checkedAt))
      )
        return err(makeError('PERMISSION_DENIED', '原 PR 绑定、授权或控制代次已失效'))
      const resolution = await resolveCheckReobservationDecision(c, {
        ...input,
        taskId: task.id,
        decisionKey: key,
        now: checkedAt,
      })
      if (reobserve) {
        await c.query(
          `UPDATE managed_check_target SET status='CHECKING',next_attempt_at=$2,
             reobserve_deadline_at=$2::timestamptz + (deadline_at - created_at),updated_at=$2
           WHERE id=$1`,
          [target.id, checkedAt],
        )
      }
      const status = reobserve ? 'CHECKING' : 'PR_CHECKS_FAILED'
      await c.query(
        `UPDATE managed_ticket_task SET status=$2,pending_decision_id=NULL,
           pending_decision_revision=NULL,updated_at=$3 WHERE id=$1`,
        [task.id, status, checkedAt],
      )
      await ticketEvent(c, task.id, 'ManagedCheckReobservationDecided', {
        targetId: target.id,
        requestId: input.requestId,
        revision: input.revision,
        resolutionId: resolution.id,
        reobserve,
        previousAttempt: target.attempts,
      })
      return ok({ status, targetId: target.id })
    })
  } catch (cause) {
    return err(errorFrom(cause, 'CONFLICT', '无法结算 check 恢复决定'))
  }
}
