import { err, errorFrom, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedTicketTask, ManagedWorkflow } from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import { lockIssueOwnership } from '../issue-ownership.js'
import { blockPendingActionsInTx } from './ticket-control.js'
import { ticketEvent } from './ticket-store.js'
import { listWorkflowNodesInTx, workflowEvent } from './workflow-store.js'

export interface ManagedWorkflowCancellation {
  readonly workflowId: string
  readonly graphVersion: number
  readonly status: 'CANCELLED'
  readonly cancelledTaskIds: readonly string[]
  readonly releasedClaimIds: readonly string[]
  readonly blockedOutboxIds: readonly string[]
}

/**
 * 只在静止边界交接；NOWAIT 锁失败时回滚，避免与决策、gateway 和 archive 的锁序互等。
 * 新流程另行创建，失败可以重试，不改写旧绑定或把旧证据当成新流程通过。
 */
export async function cancelManagedWorkflow(
  workflowId: string,
  graphVersion: number,
  reason: string,
  now: string,
): Promise<Result<ManagedWorkflowCancellation>> {
  if (!Number.isInteger(graphVersion) || graphVersion < 0 || !reason.trim()) {
    return err(makeError('SCHEMA_VIOLATION', '取消流程需要非负图版本与非空理由'))
  }
  if (!Number.isFinite(Date.parse(now))) {
    return err(makeError('SCHEMA_VIOLATION', '控制时间不是合法时间'))
  }
  try {
    return await asRole('keel_control', async (c) => {
      const workflow = (
        await c.query<ManagedWorkflow>(
          'SELECT * FROM managed_workflow WHERE id=$1 FOR UPDATE NOWAIT',
          [workflowId],
        )
      ).rows[0]
      if (workflow === undefined) return err(makeError('NOT_FOUND', '找不到 managed workflow'))
      if (workflow.current_graph_version !== graphVersion) {
        return err(makeError('CONFLICT', 'workflow 当前图版本已变化，请重新核对'))
      }
      if (workflow.status === 'CANCELLED') {
        const previous = await c.query<{ payload: ManagedWorkflowCancellation }>(
          `SELECT payload FROM managed_workflow_event
           WHERE workflow_id=$1 AND type='ManagedWorkflowCancelled' ORDER BY seq DESC LIMIT 1`,
          [workflowId],
        )
        const result = previous.rows[0]?.payload
        return result === undefined
          ? err(makeError('CONFLICT', '流程已终止，但没有该控制入口的交接记录'))
          : ok(result)
      }
      if (['RUNNING', 'DONE', 'FAILED'].includes(workflow.status)) {
        return err(makeError('CONFLICT', `workflow 当前是 ${workflow.status}，不可交接`))
      }
      const nodes = await listWorkflowNodesInTx(c, workflowId, graphVersion)
      const taskIds = nodes.flatMap((node) =>
        node.status !== 'ARCHIVED' && node.ticket_task_id !== null ? [node.ticket_task_id] : [],
      )
      const actions = await c.query<{ id: string; status: string }>(
        `SELECT o.id,o.status FROM managed_action_outbox o
         JOIN managed_action_intent i ON i.id=o.action_intent_id
         WHERE i.task_id=ANY($1::uuid[]) ORDER BY o.id FOR UPDATE OF o NOWAIT`,
        [taskIds],
      )
      const tasks = await c.query<ManagedTicketTask>(
        `SELECT * FROM managed_ticket_task WHERE id=ANY($1::uuid[])
         ORDER BY id FOR UPDATE NOWAIT`,
        [taskIds],
      )
      if (tasks.rows.some((task) => task.status === 'RUNNING')) {
        return err(makeError('CONFLICT', '仍有 RUNNING ticket，等待执行收尾后再交接'))
      }
      const runningStages = await c.query(
        `SELECT id FROM managed_ticket_stage WHERE task_id=ANY($1::uuid[])
         AND status='RUNNING' FOR UPDATE NOWAIT`,
        [taskIds],
      )
      if (runningStages.rowCount !== 0) {
        return err(makeError('CONFLICT', '仍有 RUNNING stage，须先核对执行状态'))
      }
      // 任务锁到手前，阶段可能刚登记新动作；重新锁定并校验，不能漏掉这个窗口。
      const latestActions = await c.query<{ id: string; status: string }>(
        `SELECT o.id,o.status FROM managed_action_outbox o
         JOIN managed_action_intent i ON i.id=o.action_intent_id
         WHERE i.task_id=ANY($1::uuid[]) ORDER BY o.id FOR UPDATE OF o NOWAIT`,
        [taskIds],
      )
      if (
        [...actions.rows, ...latestActions.rows].some((action) =>
          ['EXECUTING', 'UNCERTAIN', 'SUCCEEDED'].includes(action.status),
        )
      ) {
        return err(makeError('CONFLICT', '未归档节点已有外部动作开始或完成，须先核对远端'))
      }
      await c.query(
        `SELECT id FROM managed_decision_request WHERE managed_ticket_task_id=ANY($1::uuid[])
         ORDER BY id,revision FOR UPDATE NOWAIT`,
        [taskIds],
      )
      await c.query(
        `SELECT p.id FROM managed_execution_permit p
         JOIN managed_action_intent i ON i.id=p.action_intent_id
         WHERE i.task_id=ANY($1::uuid[]) AND p.status='VALID'
         ORDER BY p.id FOR UPDATE OF p NOWAIT`,
        [taskIds],
      )
      await c.query(
        `SELECT id FROM managed_workflow_node WHERE workflow_id=$1 AND graph_version=$2
         ORDER BY id FOR UPDATE NOWAIT`,
        [workflowId, graphVersion],
      )
      const claims = await c.query<{ id: string; repo_id: string; issue_ref: string }>(
        `SELECT id,repo_id,issue_ref FROM managed_issue_claim
         WHERE status='ACTIVE' AND (
           (owner_kind='managed_workflow' AND owner_id=$1)
           OR (owner_kind='managed_node' AND owner_id=ANY($2::uuid[])))
         ORDER BY repo_id,issue_ref`,
        [workflowId, nodes.filter((node) => node.status !== 'ARCHIVED').map((node) => node.id)],
      )
      for (const claim of claims.rows) {
        await lockIssueOwnership(c, claim.repo_id, claim.issue_ref)
      }
      const cancelledTaskIds: string[] = []
      const blockedOutboxIds: string[] = []
      for (const task of tasks.rows) {
        const boundary = await blockPendingActionsInTx(c, task.id, reason.trim(), now)
        blockedOutboxIds.push(...boundary.blockedOutboxIds)
        if (['DONE', 'FAILED', 'CANCELLED'].includes(task.status)) continue
        await c.query(
          `UPDATE managed_ticket_task SET status='CANCELLED',
             control_generation=control_generation+1,lease_token=NULL,lease_until=NULL,
             pending_decision_id=NULL,pending_decision_revision=NULL,last_error=$2,updated_at=$3
           WHERE id=$1`,
          [task.id, `CANCELLED: ${reason.trim()}`, now],
        )
        await ticketEvent(c, task.id, 'ManagedTicketCancelled', {
          workflowId,
          graphVersion,
          reason: reason.trim(),
          controlGeneration: task.control_generation + 1,
        })
        cancelledTaskIds.push(task.id)
      }
      await c.query(
        `UPDATE managed_decision_request SET status='CANCELLED',updated_at=$2
         WHERE managed_ticket_task_id=ANY($1::uuid[])
           AND status IN ('OPEN','PROCESSING','WAITING_HUMAN')`,
        [taskIds, now],
      )
      // FAILED 与 ARCHIVED 节点保留原证据/状态；父流程终态使 FAILED 不再可重试。
      await c.query(
        `UPDATE managed_workflow_node SET status='CANCELLED',last_error=$3,updated_at=$4
         WHERE workflow_id=$1 AND graph_version=$2
           AND status NOT IN ('ARCHIVED','FAILED','CANCELLED')`,
        [workflowId, graphVersion, `CANCELLED: ${reason.trim()}`, now],
      )
      const released = await c.query<{ id: string }>(
        `UPDATE managed_issue_claim SET status='RELEASED',released_at=$2
         WHERE id=ANY($1::uuid[]) AND status='ACTIVE' RETURNING id`,
        [claims.rows.map((claim) => claim.id), now],
      )
      await c.query(
        `UPDATE managed_workflow SET status='CANCELLED',last_error=$2,
           lease_token=NULL,lease_until=NULL,updated_at=$3 WHERE id=$1`,
        [workflowId, `CANCELLED: ${reason.trim()}`, now],
      )
      const result: ManagedWorkflowCancellation = {
        workflowId,
        graphVersion,
        status: 'CANCELLED',
        cancelledTaskIds,
        releasedClaimIds: released.rows.map((claim) => claim.id),
        blockedOutboxIds,
      }
      await workflowEvent(c, workflowId, 'ManagedWorkflowCancelled', {
        ...result,
        reason: reason.trim(),
      })
      return ok(result)
    })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') {
      return err(makeError('CONFLICT', '流程正在被其他控制操作推进，请重新核对后重试'))
    }
    if (typeof error === 'object' && error !== null && 'kind' in error) {
      return err(errorFrom(error, 'CONFLICT', 'workflow 取消失败'))
    }
    throw error
  }
}
