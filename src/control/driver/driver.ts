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

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { PullRequestGateway } from '../../contracts/git-provider.js'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import { asRole } from '../../fact/db.js'
import { branchFor, type GitWorkspace } from '../../fact/git-workspace.js'
import type { ControlMode, TaskStatus } from '../../shared/ids.js'
import { transition } from '../transition/index.js'
import { TASK_TRANSITIONS } from '../transition/table.js'
import type { TransitionEvent } from '../transition/types.js'
import { type AppliedEffect, applyEffects } from './effects.js'
import { loadTransitionFacts } from './facts.js'

const TITLE_MAX_LEN = 500

/**
 * T-001 的事实来源仍是转移表；intake 是它唯一的执行路径。
 *
 * intake 里写的是字面量（SQL 与事件 payload 都要），所以这里断言表行与之一致 ——
 * 否则改了表却没改 intake，行为会静默沿用旧字面量。表漂移就在 import 期炸掉。
 */
const T001 = TASK_TRANSITIONS.find((r) => r.id === 'T-001')
if (
  T001 === undefined ||
  T001.from !== null ||
  T001.to !== 'S-NEW' ||
  T001.on.length !== 1 ||
  T001.on[0] !== 'FeedbackTriaged' ||
  T001.effects.length !== 2 ||
  T001.effects[0]?.kind !== 'CreateTask' ||
  T001.effects[1]?.kind !== 'LinkFeedback'
) {
  throw new Error(
    '转移表 T-001 与 intake 实现不一致：期望 ∅ --FeedbackTriaged--> S-NEW [CreateTask, LinkFeedback]',
  )
}

export interface IntakeInput {
  readonly feedbackId: string
  readonly title: string
  readonly repoId: string
  readonly baseBranch: string
}

export interface IntakeOutcome {
  readonly taskId: string
  readonly created: boolean
  readonly effects: readonly AppliedEffect[]
}

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

  /** 编排器校验 Proposal 时用同一个 Policy 实例 —— 裁决必须一致 */
  get policyEngine(): PolicyEngine {
    return this.policy
  }

  /**
   * T-001 的真实入口 —— 从 feedback 建 S-NEW task。
   *
   * 不走 transition()（from:null 刻意不参与已有 task 的转移）也不走 advance()（要求 task 已存在）。
   * 单事务内完成 CreateTask + LinkFeedback + TaskStatusChanged(I4)。
   */
  async intake(input: IntakeInput, now: string): Promise<Result<IntakeOutcome>> {
    return asRole('keel_control', async (c) => {
      const existing = await c.query<{ task_id: string }>(
        'SELECT task_id FROM task_feedback WHERE feedback_id = $1',
        [input.feedbackId],
      )
      const linked = existing.rows[0]
      if (linked !== undefined) {
        await c.query(
          `INSERT INTO event (task_id, type, payload, occurred_at) VALUES ($1,'SideEffectSkipped',$2::jsonb,$3)`,
          [
            linked.task_id,
            JSON.stringify({ kind: 'CreateTask', dedupe_key: input.feedbackId }),
            now,
          ],
        )
        return ok<IntakeOutcome>({
          taskId: linked.task_id,
          created: false,
          effects: [{ kind: 'CreateTask', outcome: 'skipped', detail: input.feedbackId }],
        })
      }

      const taskId = randomUUID()
      const title =
        input.title.length > TITLE_MAX_LEN ? input.title.slice(0, TITLE_MAX_LEN) : input.title
      const workBranch = branchFor(taskId)

      await c.query(
        `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
         VALUES ($1, 'S-NEW', $2, $3, $4, $5)`,
        [taskId, title, input.repoId, input.baseBranch, workBranch],
      )

      await c.query(
        `INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [taskId, input.feedbackId],
      )

      const effects: AppliedEffect[] = [
        { kind: 'CreateTask', outcome: 'applied', detail: taskId },
        { kind: 'LinkFeedback', outcome: 'applied', detail: input.feedbackId },
      ]

      await c.query(
        `INSERT INTO event (task_id, type, payload, occurred_at) VALUES ($1,'SideEffectApplied',$2::jsonb,$3)`,
        [
          taskId,
          JSON.stringify({
            kind: 'CreateTask',
            dedupe_key: input.feedbackId,
            task_id: taskId,
            work_branch: workBranch,
          }),
          now,
        ],
      )
      await c.query(
        `INSERT INTO event (task_id, type, payload, occurred_at) VALUES ($1,'SideEffectApplied',$2::jsonb,$3)`,
        [
          taskId,
          JSON.stringify({
            kind: 'LinkFeedback',
            dedupe_key: input.feedbackId,
            feedback_id: input.feedbackId,
          }),
          now,
        ],
      )
      await c.query(
        `INSERT INTO event (task_id, type, payload, occurred_at) VALUES ($1,'TaskStatusChanged',$2::jsonb,$3)`,
        [
          taskId,
          JSON.stringify({
            from: null,
            to: 'S-NEW',
            transition: 'T-001',
            event: 'FeedbackTriaged',
          }),
          now,
        ],
      )

      return ok<IntakeOutcome>({ taskId, created: true, effects })
    })
  }

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

      const facts = await loadTransitionFacts(c, taskId, event, {
        policy: this.policy,
        now,
      })
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
        {
          taskId,
          event,
          transitionId: result.id,
          now,
          policy: this.policy,
          ...(this.workspace === undefined ? {} : { workspace: this.workspace }),
          ...(this.github === undefined ? {} : { github: this.github }),
        },
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
