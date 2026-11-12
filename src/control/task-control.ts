import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { commitArtifactOn } from '../fact/artifact-store.js'
import { materialize } from '../fact/blob.js'
import { asRole } from '../fact/db.js'
import { ensureTraceId } from '../fact/trace.js'
import type { AState } from '../generated/artifacts.js'
import {
  type ControlMode,
  type ControlTransitionId,
  isTerminal,
  type TaskStatus,
} from '../shared/ids.js'
import { validateProposal } from './proposal/validate.js'
import { type ControlAction, controlTransition } from './transition/control-mode.js'

export interface TaskControlOutcome {
  readonly taskId: string
  readonly from: ControlMode
  readonly to: ControlMode
  readonly transition: ControlTransitionId
}

export async function controlTask(
  taskId: string,
  action: ControlAction,
  now: string,
  options: { readonly expectedMode?: ControlMode; readonly note?: string } = {},
): Promise<Result<TaskControlOutcome>> {
  return asRole('keel_control', async (client) => {
    const selected = await client.query<{
      status: TaskStatus
      control_mode: ControlMode
      title: string
      current_run_id: string | null
    }>('SELECT status, control_mode, title, current_run_id FROM task WHERE id=$1 FOR UPDATE', [
      taskId,
    ])
    const task = selected.rows[0]
    if (task === undefined) return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))
    if (isTerminal(task.status)) {
      return err(makeError('CONFLICT', '终态任务不可变更驾驶模式（I8）。'))
    }
    if (options.expectedMode !== undefined && task.control_mode !== options.expectedMode) {
      return err(makeError('CONFLICT', '驾驶模式已变化，请刷新后重试。'))
    }
    const rule = controlTransition(task.control_mode, action)
    if (rule === undefined) {
      return err(makeError('CONFLICT', `${task.control_mode} 不接受 ${action}。`))
    }
    if (action === 'takeover') {
      const active = await client.query(
        `SELECT id FROM run WHERE task_id=$1 AND status='RUNNING'
         UNION ALL
         SELECT r.id FROM run r WHERE r.id=$2 AND r.status IN ('SUCCEEDED','FAILED','TIMEOUT')
           AND NOT EXISTS (
             SELECT 1 FROM event e WHERE e.task_id=$1 AND e.type='NoTransition'
               AND e.payload->>'run_id'=r.id::text
               AND e.payload->>'reason' IN ('control_mode_not_auto','optimistic_lock_conflict')
               AND e.payload->>'status'=$3
           )
           AND NOT EXISTS (
             SELECT 1 FROM event e WHERE e.task_id=$1 AND e.type='TaskStatusChanged'
               AND e.seq>COALESCE((
                 SELECT max(finished.seq) FROM event finished
                 WHERE finished.run_id=r.id
                   AND finished.type IN ('WorkspaceDiffCollected','RunFailed','RunTimeout','RunStalled')
               ),9223372036854775807)
           )`,
        [taskId, task.current_run_id, task.status],
      )
      if (active.rows.length > 0) {
        return err(
          makeError('CONFLICT', '执行尚未收尾，暂不能安全接管。请先暂停，等待当前轮次收尾后重试。'),
        )
      }
    }

    const note = options.note?.trim() ?? ''
    if (rule.id === 'C-006' && (note.length === 0 || note.length > 8000)) {
      return err(makeError('CONFLICT', '交回 Agent 前需填写 1–8000 字的人工交接说明。'))
    }
    if (rule.id === 'C-006') {
      const latest = await client.query<{ id: string; body: unknown }>(
        `SELECT id, body FROM artifact WHERE task_id=$1 AND kind='state' AND key=''
         ORDER BY version DESC LIMIT 1`,
        [taskId],
      )
      const previous = latest.rows[0]
      const state =
        previous === undefined
          ? {
              schema_version: '1.0' as const,
              current_goal: task.title,
              confirmed_facts: [],
              decisions: [],
              open_questions: [],
              risks: [],
            }
          : ((await materialize(previous.body)) as AState)
      const body = {
        ...state,
        confirmed_facts: [
          ...state.confirmed_facts,
          { id: randomUUID(), text: note, source: 'human:console-owner' },
        ],
      }
      const proposalId = randomUUID()
      const validated = await validateProposal(
        {
          proposal_id: proposalId,
          task_id: taskId,
          produced_by_run: '',
          kind: 'state',
          key: '',
          body,
          supersedes: previous?.id ?? null,
        },
        { client, now },
      )
      if (!validated.accepted) {
        return err(makeError('SCHEMA_VIOLATION', '现有 A-State 无法合法更新，请检查产物后再交还。'))
      }
      const traceId = await ensureTraceId(client, taskId, now)
      const event = await client.query<{ seq: string }>(
        `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
         VALUES ($1,'ArtifactCommitted',$2::jsonb,$3,$4) RETURNING seq`,
        [
          taskId,
          JSON.stringify({ kind: 'state', key: '', source: 'human:console-owner' }),
          traceId,
          now,
        ],
      )
      await commitArtifactOn(client, {
        id: proposalId,
        taskId,
        kind: 'state',
        key: '',
        body,
        producedByRun: null,
        committedAtSeq: Number(event.rows[0]?.seq),
        supersedes: previous?.id ?? null,
      })
    }
    await client.query('UPDATE task SET control_mode=$2, updated_at=$3 WHERE id=$1', [
      taskId,
      rule.to,
      now,
    ])
    const traceId = await ensureTraceId(client, taskId, now)
    await client.query(
      `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
       VALUES ($1,'ControlModeChanged',$2::jsonb,$3,$4)`,
      [
        taskId,
        JSON.stringify({
          transition: rule.id,
          from: rule.from,
          to: rule.to,
          action,
          event: rule.event,
        }),
        traceId,
        now,
      ],
    )
    return ok({ taskId, from: rule.from, to: rule.to, transition: rule.id })
  })
}
