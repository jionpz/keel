/**
 * Workflow driver —— 把事件变成状态推进。
 *
 * 编排三块已有的东西：
 *   Fact Plane（读 facts） → transition()（纯函数） → 副作用执行器（幂等写）
 *
 * 顺序不能反：**先算出该做什么，再去做**。
 * 这正是 ADR-0003 把副作用做成「返回值中的描述」的意义 ——
 * 决策部分可重放，执行部分可幂等，两者分开。
 *
 * 本模块属 Control Plane：不调 LLM、不读时钟（`now` 由参数注入）、
 * facts 只来自 Fact Plane。
 */

import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import { asRole } from '../../fact/db.js'
import type { ControlMode, TaskStatus } from '../../shared/ids.js'
import { transition } from '../transition/index.js'
import type { TransitionEvent } from '../transition/types.js'
import { type AppliedEffect, applyEffects } from './effects.js'
import { loadTransitionFacts } from './facts.js'

export interface AdvanceOutcome {
  readonly advanced: boolean
  readonly from: TaskStatus
  readonly to: TaskStatus
  /** 未推进时为 null */
  readonly transition_id: string | null
  readonly effects: readonly AppliedEffect[]
  /** 未推进时说明原因 */
  readonly reason: string | null
}

export class WorkflowDriver {
  constructor(private readonly policy: PolicyEngine) {}

  /**
   * 推进一个 Task。
   *
   * 整个过程在**一个事务**内完成（不变量 I4：状态变更必然伴随事件）。
   * 任一步失败则全部回滚 —— 不会出现「状态变了但事件没写」。
   *
   * @param now 时间由外部注入。控制平面不读时钟，否则重放会得到不同结果。
   */
  async advance(
    taskId: string,
    event: TransitionEvent,
    now: string,
  ): Promise<Result<AdvanceOutcome>> {
    return asRole('keel_control', async (c) => {
      const row = await c.query<{ status: TaskStatus; control_mode: ControlMode }>(
        'SELECT status, control_mode FROM task WHERE id = $1',
        [taskId],
      )
      const task = row.rows[0]
      if (task === undefined) {
        return err<AdvanceOutcome>(makeError('NOT_FOUND', `找不到 task ${taskId}`))
      }

      const facts = await loadTransitionFacts(c, taskId, event)
      const result = transition(task.status, task.control_mode, event, facts)

      // matched:false 不是错误，是「这个事件在当前状态下无事发生」。
      // 暂停中、终态、guard 未过 —— 三者都是正常的业务状态。
      // 但仍要如实记录，否则事件流会缺失「系统看到了这个事件但没动」这个事实。
      if (!result.matched) {
        await c.query(
          `INSERT INTO event (task_id, type, payload) VALUES ($1,'NoTransition',$2::jsonb)`,
          [
            taskId,
            JSON.stringify({
              event: event.type,
              status: task.status,
              control_mode: task.control_mode,
              reason: result.reason,
              detail: result.detail,
            }),
          ],
        )
        return ok<AdvanceOutcome>({
          advanced: false,
          from: task.status,
          to: task.status,
          transition_id: null,
          effects: [],
          reason: result.detail,
        })
      }

      const effects = await applyEffects(
        c,
        { taskId, event, transitionId: result.id, now, policy: this.policy },
        result.effects,
      )

      const terminal = isTerminalStatus(result.next_status)
      await c.query(
        `UPDATE task
         SET status = $2, updated_at = $3::timestamptz,
             terminal_at = CASE WHEN $4 THEN $3::timestamptz ELSE terminal_at END
         WHERE id = $1`,
        [taskId, result.next_status, now, terminal],
      )

      // 放在最后，让它记录最终的 to 状态。
      // payload 含 transition ID —— 使事件流可直接对照转移表核验
      await c.query(
        `INSERT INTO event (task_id, type, payload) VALUES ($1,'TaskStatusChanged',$2::jsonb)`,
        [
          taskId,
          JSON.stringify({
            from: result.from,
            to: result.next_status,
            transition: result.id,
            event: event.type,
          }),
        ],
      )

      return ok<AdvanceOutcome>({
        advanced: true,
        from: result.from,
        to: result.next_status,
        transition_id: result.id,
        effects,
        reason: null,
      })
    })
  }
}

const TERMINAL: readonly string[] = ['S-DONE', 'S-REJECTED', 'S-ABANDONED', 'S-FAILED']

function isTerminalStatus(s: TaskStatus): boolean {
  return TERMINAL.includes(s)
}
