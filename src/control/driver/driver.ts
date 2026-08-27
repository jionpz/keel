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
import type { PullRequestGateway } from '../../contracts/git-provider.js'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import { asRole } from '../../fact/db.js'
import type { GitWorkspace } from '../../fact/git-workspace.js'
import { ensureTraceId } from '../../fact/trace.js'
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

export interface WorkspaceBinding {
  readonly git: GitWorkspace
  readonly repoId: string
  readonly baseBranch: string
}

export class WorkflowDriver {
  /**
   * @param workspace 可选。不传时 CreateBranch / CleanWorkspace 退回记录意图 ——
   *   单元测试不必准备 git 仓库，但真实编排必须传。
   * @param github 可选。不传时 CreatePullRequest 退回记录意图。
   */
  constructor(
    private readonly policy: PolicyEngine,
    private readonly workspace?: WorkspaceBinding,
    private readonly github?: PullRequestGateway,
  ) {}

  /**
   * 推进一个 Task。
   *
   * 整个过程在**一个事务**内完成（不变量 I4：状态变更必然伴随事件）。
   * 任一步失败则全部回滚 —— 不会出现「状态变了但事件没写」。
   *
   * 并发（N2，docs/08-cross-cutting.md §4.2/§4.4）：status 更新带
   * `WHERE status = 读取值` 乐观锁，且**先占行再做副作用** ——
   * 并发写者先行提交时返回 `CONFLICT`（可重试），副作用一个都不会落地。
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
        const traceId = await ensureTraceId(c, taskId)
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id)
           VALUES ($1,'NoTransition',$2::jsonb,$3)`,
          [
            taskId,
            JSON.stringify({
              event: event.type,
              status: task.status,
              control_mode: task.control_mode,
              reason: result.reason,
              detail: result.detail,
            }),
            traceId,
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

      // ── N2 乐观锁：先占住 task 行，再执行副作用 ──
      //
      // `WHERE status = 读取值`：并发写者先行提交时影响行数为 0。
      // 放在 applyEffects **之前**是刻意的 —— 冲突发生时副作用一个都还没做，
      // 不需要回滚任何已做的事，只需如实记录并返回 CONFLICT（可重试）。
      // 反过来放，就得靠整个事务回滚来撤销效果，连「冲突发生过」都记不下来。
      const terminal = isTerminalStatus(result.next_status)
      const upd = await c.query(
        `UPDATE task
         SET status = $2, updated_at = $3::timestamptz,
             terminal_at = CASE WHEN $4 THEN $3::timestamptz ELSE terminal_at END
         WHERE id = $1 AND status = $5`,
        [taskId, result.next_status, now, terminal, result.from],
      )
      if (upd.rowCount === 0) {
        // 败者阻塞在行锁上、直到胜者提交才走到这里 ——
        // 此时 ensureTraceId 必然读到胜者已固定的 trace_id，不会分裂出第二条 trace
        const traceId = await ensureTraceId(c, taskId)
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id)
           VALUES ($1,'NoTransition',$2::jsonb,$3)`,
          [
            taskId,
            JSON.stringify({
              event: event.type,
              status: result.from,
              reason: 'optimistic_lock_conflict',
              detail: `期望 status=${result.from}，但已被并发写者改变`,
            }),
            traceId,
          ],
        )
        return err<AdvanceOutcome>(
          makeError('CONFLICT', `task ${taskId} 的 status 乐观锁冲突：期望 ${result.from}`),
        )
      }

      // O2：trace_id 贯穿。放在赢得行锁**之后** ensure ——
      // 并发的首次派发因此被序列化，不会生成两个 trace_id（见 src/fact/trace.ts）
      const traceId = await ensureTraceId(c, taskId)

      const effects = await applyEffects(
        c,
        {
          taskId,
          traceId,
          event,
          transitionId: result.id,
          now,
          policy: this.policy,
          ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
          ...(this.github === undefined ? {} : { github: this.github }),
        },
        result.effects,
      )

      // 放在最后，让它记录最终的 to 状态。
      // payload 含 transition ID —— 使事件流可直接对照转移表核验
      await c.query(
        `INSERT INTO event (task_id, type, payload, trace_id)
         VALUES ($1,'TaskStatusChanged',$2::jsonb,$3)`,
        [
          taskId,
          JSON.stringify({
            from: result.from,
            to: result.next_status,
            transition: result.id,
            event: event.type,
          }),
          traceId,
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
