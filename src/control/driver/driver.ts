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
import { branchFor } from '../../fact/git-workspace.js'
import { ensureTraceId } from '../../fact/trace.js'
import type { ControlMode, TaskStatus } from '../../shared/ids.js'
import { enqueueIssueWriteback } from '../issue-writeback.js'
import { transition } from '../transition/index.js'
import { TASK_TRANSITIONS } from '../transition/table.js'
import type { TransitionEvent } from '../transition/types.js'
import { type AppliedEffect, applyEffects, type WorkspaceBinding } from './effects.js'
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

/**
 * 重驱动前序 Task 的审计信息。
 *
 * `redriveFeedbackId` 是 dedupe 的事实源：同一个前序 Task 只能对应一个新 Task。
 */
export interface IntakeRedrive {
  readonly previousTaskId: string
  readonly redriveFeedbackId: string
  readonly prUrl: string
  readonly closedAt: string | null
}

export interface IntakeOptions {
  readonly redrive?: IntakeRedrive
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

/**
 * 人工裁决的附带记录。
 *
 * `note` 只是给人看的理由：不进 prompt、不参与 guard、不影响转移结论。
 * 只有人工命令（`keel decide` / `keel answer`）会传；其它调用不传，
 * 事件流里也就不会凭空多出 `HumanDecision`。
 */
export interface AdvanceOptions {
  readonly note?: string
  readonly expectedRunId?: string
}

export class WorkflowDriver {
  /**
   * @param workspace 可选。不传时 CreateBranch / CleanWorkspace 退回记录意图 ——
   *   单元测试不必准备 git 仓库，但真实编排必须传。
   * @param github 可选。不传时 CreatePullRequest 退回记录意图。
   * @param humanReviewTtlMs 可选。人工裁决 TTL（毫秒）：`null` = 关闭调度，
   *   省略 = 默认 24h。由 CLI 从 `KEEL_HUMAN_REVIEW_TTL_H` 解析后传入 ——
   *   driver 自己不读 env，转移函数仍然只返回描述。
   */
  constructor(
    private readonly policy: PolicyEngine,
    private readonly workspace?: WorkspaceBinding,
    private readonly github?: PullRequestGateway,
    private readonly humanReviewTtlMs?: number | null,
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
  async intake(
    input: IntakeInput,
    now: string,
    opts: IntakeOptions = {},
  ): Promise<Result<IntakeOutcome>> {
    return asRole('keel_control', async (c) => {
      const redrive = opts.redrive
      let linked: { task_id: string } | undefined

      if (redrive === undefined) {
        const existing = await c.query<{ task_id: string }>(
          `SELECT tf.task_id
           FROM task_feedback tf
           JOIN task t ON t.id = tf.task_id
           WHERE tf.feedback_id = $1
           ORDER BY t.created_at DESC, t.id DESC
           LIMIT 1`,
          [input.feedbackId],
        )
        linked = existing.rows[0]
      } else {
        // 锁住前序 Task：并发的两次 redrive 必须串行，否则会各建一个新 Task。
        const prior = await c.query<{ status: TaskStatus; repo_id: string; linked: boolean }>(
          `SELECT t.status,t.repo_id,EXISTS(
             SELECT 1 FROM task_feedback tf WHERE tf.task_id=t.id AND tf.feedback_id=$2
           ) AS linked FROM task t WHERE t.id=$1 FOR UPDATE`,
          [redrive.previousTaskId, input.feedbackId],
        )
        const previous = prior.rows[0]
        if (previous === undefined) {
          return err<IntakeOutcome>(
            makeError('NOT_FOUND', `找不到准备重驱动的前序 Task ${redrive.previousTaskId}`),
          )
        }
        if (previous.status !== 'S-ABANDONED') {
          return err<IntakeOutcome>(
            makeError(
              'CONFLICT',
              `Task ${redrive.previousTaskId} 当前是 ${previous.status}，只有 S-ABANDONED 可重驱动`,
            ),
          )
        }
        if (!previous.linked || previous.repo_id !== input.repoId) {
          return err<IntakeOutcome>(
            makeError('CONFLICT', '重驱动与前序任务的仓库或 Feedback 不匹配'),
          )
        }
        const note = await c.query(
          `SELECT 1 FROM feedback WHERE id=$1 AND source='manual' AND external_ref=$2`,
          [redrive.redriveFeedbackId, `redrive:${redrive.previousTaskId}`],
        )
        if (note.rows.length === 0) {
          return err<IntakeOutcome>(makeError('CONFLICT', '重驱动说明不属于该前序任务'))
        }
        const closed = await c.query(
          `SELECT 1 FROM event
           WHERE task_id=$1 AND type='TaskStatusChanged'
             AND payload->>'event'='PRClosed'
             AND payload->>'reason'='pr_closed_unmerged'
           ORDER BY seq DESC LIMIT 1`,
          [redrive.previousTaskId],
        )
        if (closed.rows[0] === undefined) {
          return err<IntakeOutcome>(
            makeError(
              'CONFLICT',
              `Task ${redrive.previousTaskId} 不是因 PR 未合并关闭而放弃，拒绝重驱动`,
            ),
          )
        }

        // 同一个前序 Task 的 redrive 说明只能对应一个新 Task。
        const already = await c.query<{ task_id: string }>(
          'SELECT task_id FROM task_feedback WHERE feedback_id = $1',
          [redrive.redriveFeedbackId],
        )
        linked = already.rows[0]
      }

      if (linked !== undefined) {
        const dedupeKey = redrive?.redriveFeedbackId ?? input.feedbackId
        // O2：幂等跳过也写同一条 trace —— 否则 ingress 重放段永久无 trace
        const traceId = await ensureTraceId(c, linked.task_id, now)
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'SideEffectSkipped',$2::jsonb,$3,$4)`,
          [
            linked.task_id,
            JSON.stringify({ kind: 'CreateTask', dedupe_key: dedupeKey }),
            traceId,
            now,
          ],
        )
        return ok<IntakeOutcome>({
          taskId: linked.task_id,
          created: false,
          effects: [{ kind: 'CreateTask', outcome: 'skipped', detail: dedupeKey }],
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

      const feedbackIds = [
        input.feedbackId,
        ...(redrive === undefined ? [] : [redrive.redriveFeedbackId]),
      ]
      for (const feedbackId of feedbackIds) {
        await c.query(
          `INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [taskId, feedbackId],
        )
      }

      const effects: AppliedEffect[] = [
        { kind: 'CreateTask', outcome: 'applied', detail: taskId },
        ...feedbackIds.map(
          (feedbackId): AppliedEffect => ({
            kind: 'LinkFeedback',
            outcome: 'applied',
            detail: feedbackId,
          }),
        ),
      ]

      // O2：T-001 即是 trace 起点。ensureTraceId 会落一条 TaskCreated 宿主事件，
      // 其后本事务内所有事件共享同一 trace_id（与 advance/effects/pipeline 同纪律）。
      const traceId = await ensureTraceId(c, taskId, now)

      await c.query(
        `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
         VALUES ($1,'SideEffectApplied',$2::jsonb,$3,$4)`,
        [
          taskId,
          JSON.stringify({
            kind: 'CreateTask',
            dedupe_key: redrive?.redriveFeedbackId ?? input.feedbackId,
            task_id: taskId,
            work_branch: workBranch,
            ...(redrive === undefined ? {} : { redrive_of: redrive.previousTaskId }),
          }),
          traceId,
          now,
        ],
      )
      for (const feedbackId of feedbackIds) {
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'SideEffectApplied',$2::jsonb,$3,$4)`,
          [
            taskId,
            JSON.stringify({
              kind: 'LinkFeedback',
              dedupe_key: feedbackId,
              feedback_id: feedbackId,
            }),
            traceId,
            now,
          ],
        )
      }
      await c.query(
        `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
         VALUES ($1,'TaskStatusChanged',$2::jsonb,$3,$4)`,
        [
          taskId,
          JSON.stringify({
            from: null,
            to: 'S-NEW',
            transition: 'T-001',
            event: 'FeedbackTriaged',
            ...(redrive === undefined ? {} : { redrive_of: redrive.previousTaskId }),
          }),
          traceId,
          now,
        ],
      )
      if (redrive !== undefined) {
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'SideEffectApplied',$2::jsonb,$3,$4)`,
          [
            taskId,
            JSON.stringify({
              kind: 'Redrive',
              dedupe_key: redrive.redriveFeedbackId,
              previous_task_id: redrive.previousTaskId,
              pr_url: redrive.prUrl,
              closed_at: redrive.closedAt,
              reason: 'pr_closed_unmerged',
            }),
            traceId,
            now,
          ],
        )
      }

      return ok<IntakeOutcome>({ taskId, created: true, effects })
    })
  }

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
   * @param opts 人工裁决的附带记录（见 `AdvanceOptions`），其它调用省略即可。
   */
  async advance(
    taskId: string,
    event: TransitionEvent,
    now: string,
    opts: AdvanceOptions = {},
  ): Promise<Result<AdvanceOutcome>> {
    return asRole('keel_control', async (c) => {
      const row = await c.query<{
        status: TaskStatus
        control_mode: ControlMode
        current_run_id: string | null
      }>('SELECT status, control_mode, current_run_id FROM task WHERE id = $1', [taskId])
      const task = row.rows[0]
      if (task === undefined) {
        return err<AdvanceOutcome>(makeError('NOT_FOUND', `找不到 task ${taskId}`))
      }
      if (opts.expectedRunId !== undefined && task.current_run_id !== opts.expectedRunId) {
        return err(makeError('CONFLICT', '当前轮次已变化，拒绝重放旧轮次的阶段结论。'))
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
        const traceId = await ensureTraceId(c, taskId, now)
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'NoTransition',$2::jsonb,$3,$4)`,
          [
            taskId,
            JSON.stringify({
              event: event.type,
              status: task.status,
              control_mode: task.control_mode,
              reason: result.reason,
              detail: result.detail,
              run_id: task.current_run_id,
              ...('stage' in event ? { stage: event.stage } : {}),
            }),
            traceId,
            now,
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
         WHERE id = $1 AND status = $5 AND control_mode = $6
           AND current_run_id IS NOT DISTINCT FROM $7::uuid`,
        [
          taskId,
          result.next_status,
          now,
          terminal,
          result.from,
          task.control_mode,
          task.current_run_id,
        ],
      )
      if (upd.rowCount === 0) {
        // 败者阻塞在行锁上、直到胜者提交才走到这里 ——
        // 此时 ensureTraceId 必然读到胜者已固定的 trace_id，不会分裂出第二条 trace
        const traceId = await ensureTraceId(c, taskId, now)
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'NoTransition',$2::jsonb,$3,$4)`,
          [
            taskId,
            JSON.stringify({
              event: event.type,
              status: result.from,
              reason: 'optimistic_lock_conflict',
              detail: `期望 status=${result.from}，但已被并发写者改变`,
              run_id: task.current_run_id,
              ...('stage' in event ? { stage: event.stage } : {}),
            }),
            traceId,
            now,
          ],
        )
        return err<AdvanceOutcome>(
          makeError('CONFLICT', `task ${taskId} 的 status 乐观锁冲突：期望 ${result.from}`),
        )
      }

      // O2：trace_id 贯穿。放在赢得行锁**之后** ensure ——
      // 并发的首次派发因此被序列化，不会生成两个 trace_id（见 src/fact/trace.ts）
      const traceId = await ensureTraceId(c, taskId, now)

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
          ...(this.humanReviewTtlMs === undefined
            ? {}
            : { humanReviewTtlMs: this.humanReviewTtlMs }),
        },
        result.effects,
      )

      // 放在最后，让它记录最终的 to 状态。
      // payload 含 transition ID —— 使事件流可直接对照转移表核验
      const changed = await c.query<{ seq: string }>(
        `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
         VALUES ($1,'TaskStatusChanged',$2::jsonb,$3,$4) RETURNING seq`,
        [
          taskId,
          JSON.stringify({
            from: result.from,
            to: result.next_status,
            transition: result.id,
            event: event.type,
            // CI 结果必须能区分模拟与真实；其它事件不多出这个键
            ...(event.type === 'CIPassed' || event.type === 'CIFailed'
              ? {
                  source: event.source,
                  ...(event.headSha === undefined ? {} : { head_sha: event.headSha }),
                }
              : {}),
            // 合并是 S-DONE 的事实依据：时间与 merge SHA 必须能从事件流直接查到。
            ...(event.type === 'PRMerged'
              ? { source: event.source, merged_at: event.mergedAt, merge_sha: event.mergeSha }
              : {}),
            // PR 未合并关闭的理由属于对外可查的弃单证据。
            ...(event.type === 'PRClosed'
              ? { source: event.source, reason: event.reason, closed_at: event.closedAt }
              : {}),
            // 自动对账的取消要把「为什么」留在事实里：
            // 事后审计据此区分「人没来决策」与「issue 已被关闭」（issue #82）。
            ...(event.type === 'Cancelled' && event.reason !== undefined
              ? { reason: event.reason, closed_at: event.closed_at ?? null }
              : {}),
          }),
          traceId,
          now,
        ],
      )
      if (
        !['CIPassed', 'PRMerged', 'PRClosed'].includes(event.type) ||
        ('source' in event && event.source === 'github')
      ) {
        await enqueueIssueWriteback(c, {
          taskId,
          state: result.next_status,
          transition: result.id,
          seq: Number(changed.rows[0]?.seq),
          now,
        })
      }

      // 人工理由：与转移同事务落库，避免「状态变了、理由丢了」的中间态。
      // 单独一条事件而不是塞进 TaskStatusChanged —— 时间线要能单独渲染它，
      // 状态变更事件的 payload 只该描述状态变更本身。
      const note = opts.note?.trim()
      if (note !== undefined && note !== '') {
        await c.query(
          `INSERT INTO event (task_id, type, payload, trace_id, occurred_at)
           VALUES ($1,'HumanDecision',$2::jsonb,$3,$4)`,
          [taskId, JSON.stringify({ decision: event.type, note }), traceId, now],
        )
      }

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
