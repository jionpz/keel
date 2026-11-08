/**
 * issue 关闭对账 —— poller 每轮把「已 ingest、非终态」的任务与 issue 现状对齐（issue #82）。
 *
 * 背景：`listOpenIssues` 只查 `state=open`。issue 被人在 GitHub 上关闭后，
 * 已 ingest 的任务不再出现在扫描结果里，也就永远不会再被驱动或被取消 ——
 * 停在原状态直到 TTL 到期，弃单证据还会被错误归因为「人没来决策」。
 *
 * 本模块只回答一个问题：这个任务的 issue 还在吗？
 *   - 在（open）→ 什么都不做：label 被摘掉不等于撤单；
 *   - 不在（closed）→ 发 `Cancelled` 走 T-040，工作区由 T-040 的 CleanWorkspace 收掉。
 *
 * 刻意不做的事：
 *   - **不重新驱动 closed issue 的任务**：`ingestIssue` 的关闭闸门是授权边界，
 *     对账不绕过它；
 *   - **不把「关闭」当成万能取消信号**：S-PR_OPEN 有显式守卫（`cancellationApplies`）。
 *
 * 依赖全部可注入，所以对账逻辑可以脱离数据库与 GitHub 单测。
 */

import type { Result } from '../contracts/errors.js'
import type { TaskStatus } from '../shared/ids.js'

/** 已 ingest、非终态的 GitHub issue 任务 —— 对账输入 */
export interface IngestedTask {
  readonly taskId: string
  readonly status: TaskStatus
  /** `owner/repo#n` —— 与 feedback(source='github') 的唯一键同源 */
  readonly externalRef: string
  readonly remoteUrl: string
}

/** issue 现状。`closed_at` 原样来自 GitHub，缺失时是 null，不本地补时间 */
export interface IssueState {
  readonly state: 'open' | 'closed'
  readonly closedAt: string | null
}

export interface CancelOutcome {
  readonly advanced: boolean
  readonly transitionId: string | null
  readonly reason: string | null
}

export interface ReconcileDeps {
  readonly listIngestedTasks: () => Promise<readonly IngestedTask[]>
  readonly issueState: (remoteUrl: string, issueNumber: number) => Promise<Result<IssueState>>
  /** 发 `Cancelled`（T-040）。`now` 由调用方从注入时钟取，控制平面不读系统时钟 */
  readonly cancelTask: (
    task: IngestedTask,
    issue: IssueState,
    now: string,
  ) => Promise<Result<CancelOutcome>>
  /** 错误 detail 的脱敏入口（remote URL 可能含 userinfo） */
  readonly redactDetail: (detail: string) => string
  readonly now: () => string
  readonly log: (line: Record<string, unknown>) => void
}

export interface ReconcileStats {
  /** 实际读到 issue 状态的任务数 */
  readonly checked: number
  /** 真的走成了 T-040 的任务数 */
  readonly cancelled: number
  /** issue 已关闭但按守卫刻意不取消的任务数（S-PR_OPEN） */
  readonly skipped: number
  readonly errors: number
}

export interface ReconcileOptions {
  /** SIGTERM / SIGINT 后返回 true：不再发起新的对账请求 */
  readonly shouldStop?: () => boolean
}

const EXTERNAL_REF_NUMBER = /^[^#]+#(\d+)$/

/**
 * 关闭是否等于取消 —— T-040 的显式守卫。
 *
 * `S-PR_OPEN` 是唯一的例外：PR 已经开出去了，交付物落在 PR 上继续收口
 * （等 CI / 等合并），issue 被关不等于这项工作被撤回。其余非终态没有任何
 * 脱离 issue 仍然成立的交付物，issue 关闭就是撤单。
 *
 * 刻意写成白名单式的显式判断，而不是「默认取消、遇到问题再说」：
 * 关闭被误判成取消不可逆（终态 I8），宁可漏取消也不能错取消。
 */
export function cancellationApplies(status: TaskStatus): boolean {
  return status !== 'S-PR_OPEN'
}

/**
 * 跑一轮对账。
 *
 * `openRefs` 是本轮扫描里见过的 open issue（`scanOnce` 的返回值）。
 * 见过的直接跳过，零额外请求 —— 这是常态；只有「本轮没见到」的任务
 * 才逐条回查，用来区分「已关闭」与「被摘了 label 但仍然 open」。
 */
export async function reconcileClosedIssues(
  deps: ReconcileDeps,
  openRefs: ReadonlySet<string>,
  opts: ReconcileOptions = {},
): Promise<ReconcileStats> {
  const shouldStop = opts.shouldStop ?? (() => false)

  let checked = 0
  let cancelled = 0
  let skipped = 0
  let errors = 0

  for (const task of await deps.listIngestedTasks()) {
    if (shouldStop()) break

    // 本轮 open 列表里见过 → issue 仍 open，连查都不用查
    if (openRefs.has(task.externalRef)) continue

    if (!cancellationApplies(task.status)) {
      skipped += 1
      deps.log({
        ts: deps.now(),
        event: 'reconcile_skipped',
        ref: task.externalRef,
        task: task.taskId,
        status: task.status,
        reason: 'pr_open',
      })
      continue
    }

    const issueNumber = parseIssueNumber(task.externalRef)
    if (issueNumber === undefined) {
      errors += 1
      deps.log({
        ts: deps.now(),
        event: 'reconcile_error',
        ref: task.externalRef,
        kind: 'PROTOCOL_ERROR',
        detail: 'external_ref 缺少 issue 编号',
      })
      continue
    }

    const issue = await deps.issueState(task.remoteUrl, issueNumber)
    if (!issue.ok) {
      errors += 1
      deps.log({
        ts: deps.now(),
        event: 'reconcile_error',
        ref: task.externalRef,
        kind: issue.error.kind,
        detail: deps.redactDetail(issue.error.detail),
      })
      continue
    }
    checked += 1

    // issue 仍然 open（只是不在 open 列表里，例如 label 被摘掉）：不撤单
    if (issue.value.state !== 'closed') continue

    const result = await deps.cancelTask(task, issue.value, deps.now())
    if (!result.ok) {
      errors += 1
      deps.log({
        ts: deps.now(),
        event: 'reconcile_error',
        ref: task.externalRef,
        kind: result.error.kind,
        detail: deps.redactDetail(result.error.detail),
      })
      continue
    }
    if (!result.value.advanced) {
      // 并发改了状态（例如人刚驳回 / TTL 刚弃单）：如实记录，不假装取消了
      deps.log({
        ts: deps.now(),
        event: 'reconcile_noop',
        ref: task.externalRef,
        task: task.taskId,
        reason: result.value.reason,
      })
      continue
    }

    cancelled += 1
    deps.log({
      ts: deps.now(),
      event: 'reconcile_cancelled',
      ref: task.externalRef,
      task: task.taskId,
      from: task.status,
      transition: result.value.transitionId,
      closed_at: issue.value.closedAt,
    })
  }

  return { checked, cancelled, skipped, errors }
}

/** 从 `owner/repo#n` 取 issue 编号；形状不对返回 undefined（由调用方记 error） */
export function parseIssueNumber(externalRef: string): number | undefined {
  const m = EXTERNAL_REF_NUMBER.exec(externalRef)
  if (m === null) return undefined
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}
