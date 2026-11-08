/**
 * issue 关闭对账的单测 —— 全部注入依赖，不碰数据库、不碰 GitHub。
 *
 * 覆盖 issue #82 的行为面：closed → T-040、open 不动、S-PR_OPEN 显式放行、
 * 错误隔离、停止信号。
 */

import { describe, expect, it } from 'vitest'
import { err, makeError, ok } from '../contracts/errors.js'
import type { TaskStatus } from '../shared/ids.js'
import {
  type CancelOutcome,
  cancellationApplies,
  type IngestedTask,
  type IssueState,
  parseIssueNumber,
  type ReconcileDeps,
  reconcileClosedIssues,
} from './reconcile.js'

function task(overrides: Partial<IngestedTask> = {}): IngestedTask {
  return {
    taskId: 'task-1',
    status: 'S-HUMAN_REVIEW',
    externalRef: 'acme/alpha#7',
    remoteUrl: 'https://github.com/acme/alpha.git',
    ...overrides,
  }
}

interface Harness {
  readonly deps: ReconcileDeps
  readonly logs: Record<string, unknown>[]
  readonly stateCalls: { remoteUrl: string; issueNumber: number }[]
  readonly cancelCalls: { task: IngestedTask; issue: IssueState; now: string }[]
}

function harness(overrides: Partial<ReconcileDeps> = {}): Harness {
  const logs: Record<string, unknown>[] = []
  const stateCalls: { remoteUrl: string; issueNumber: number }[] = []
  const cancelCalls: { task: IngestedTask; issue: IssueState; now: string }[] = []
  const deps: ReconcileDeps = {
    listIngestedTasks: async () => [],
    issueState: async (remoteUrl, issueNumber) => {
      stateCalls.push({ remoteUrl, issueNumber })
      return ok<IssueState>({ state: 'open', closedAt: null })
    },
    cancelTask: async (t, issue, now) => {
      cancelCalls.push({ task: t, issue, now })
      return ok<CancelOutcome>({ advanced: true, transitionId: 'T-040', reason: null })
    },
    redactDetail: (detail) => detail,
    now: () => '2026-11-08T00:00:00.000Z',
    log: (line) => logs.push(line),
    ...overrides,
  }
  return { deps, logs, stateCalls, cancelCalls }
}

describe('reconcileClosedIssues · 关闭即取消', () => {
  it('issue 已关闭 → 发 T-040，closed_at 原样落进取消证据', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async (remoteUrl, issueNumber) => {
        h.stateCalls.push({ remoteUrl, issueNumber })
        return ok<IssueState>({ state: 'closed', closedAt: '2026-11-07T12:34:56Z' })
      },
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 1, cancelled: 1, skipped: 0, errors: 0 })
    expect(h.stateCalls).toEqual([
      { remoteUrl: 'https://github.com/acme/alpha.git', issueNumber: 7 },
    ])
    expect(h.cancelCalls).toEqual([
      {
        task: task(),
        issue: { state: 'closed', closedAt: '2026-11-07T12:34:56Z' },
        now: '2026-11-08T00:00:00.000Z',
      },
    ])
    expect(h.logs.find((l) => l.event === 'reconcile_cancelled')).toMatchObject({
      ref: 'acme/alpha#7',
      task: 'task-1',
      from: 'S-HUMAN_REVIEW',
      transition: 'T-040',
      closed_at: '2026-11-07T12:34:56Z',
    })
  })

  it('closed_at 缺失时为 null —— 不本地编造时间', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async () => ok<IssueState>({ state: 'closed', closedAt: null }),
    })

    await reconcileClosedIssues(h.deps, new Set())

    expect(h.cancelCalls[0]?.issue.closedAt).toBeNull()
  })

  it('本轮 open 列表里见过 → 零请求、零动作', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
    })

    const stats = await reconcileClosedIssues(h.deps, new Set(['acme/alpha#7']))

    expect(stats).toEqual({ checked: 0, cancelled: 0, skipped: 0, errors: 0 })
    expect(h.stateCalls).toEqual([])
    expect(h.cancelCalls).toEqual([])
  })

  it('issue 仍然 open（只是不在 open 列表里，例如 label 被摘掉）→ 不撤单', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async () => ok<IssueState>({ state: 'open', closedAt: null }),
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 1, cancelled: 0, skipped: 0, errors: 0 })
    expect(h.cancelCalls).toEqual([])
  })

  it('多个任务：只有不在 open 列表里的才回查', async () => {
    const open = task({ taskId: 'task-open', externalRef: 'acme/alpha#1' })
    const closed = task({ taskId: 'task-closed', externalRef: 'acme/alpha#2' })
    const h = harness({
      listIngestedTasks: async () => [open, closed],
      issueState: async (remoteUrl, issueNumber) => {
        h.stateCalls.push({ remoteUrl, issueNumber })
        return ok<IssueState>({
          state: issueNumber === 2 ? 'closed' : 'open',
          closedAt: issueNumber === 2 ? '2026-11-07T00:00:00Z' : null,
        })
      },
    })

    const stats = await reconcileClosedIssues(h.deps, new Set(['acme/alpha#1']))

    expect(stats).toEqual({ checked: 1, cancelled: 1, skipped: 0, errors: 0 })
    expect(h.stateCalls).toEqual([
      { remoteUrl: 'https://github.com/acme/alpha.git', issueNumber: 2 },
    ])
  })

  it('S-PR_OPEN 显式放行：issue 关闭不等于取消，PR 仍由 keel 收口', async () => {
    const h = harness({
      listIngestedTasks: async () => [task({ status: 'S-PR_OPEN' })],
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    // 连 issue 状态都不查：守卫在发起请求之前就决定了
    expect(stats).toEqual({ checked: 0, cancelled: 0, skipped: 1, errors: 0 })
    expect(h.stateCalls).toEqual([])
    expect(h.cancelCalls).toEqual([])
    expect(h.logs.find((l) => l.event === 'reconcile_skipped')).toMatchObject({
      ref: 'acme/alpha#7',
      status: 'S-PR_OPEN',
      reason: 'pr_open',
    })
  })
})

describe('reconcileClosedIssues · 错误隔离', () => {
  it('issue 状态查询失败 → 记 error，继续处理下一个任务', async () => {
    const h = harness({
      listIngestedTasks: async () => [
        task({ taskId: 'task-a', externalRef: 'acme/alpha#1' }),
        task({ taskId: 'task-b', externalRef: 'acme/alpha#2' }),
      ],
      issueState: async (_remoteUrl, issueNumber) =>
        issueNumber === 1
          ? err(makeError('AUTH_FAILED', 'GitHub 认证失败(HTTP 401)'))
          : ok<IssueState>({ state: 'closed', closedAt: '2026-11-07T00:00:00Z' }),
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 1, cancelled: 1, skipped: 0, errors: 1 })
    expect(h.logs.find((l) => l.event === 'reconcile_error')).toMatchObject({
      ref: 'acme/alpha#1',
      kind: 'AUTH_FAILED',
    })
  })

  it('错误 detail 过脱敏入口', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async () =>
        err(makeError('WORKSPACE_ERROR', '无法解析 remote URL:https://u:secret@github.com/x')),
      redactDetail: (detail) => detail.replace('secret', '***'),
    })

    await reconcileClosedIssues(h.deps, new Set())

    expect(h.logs.find((l) => l.event === 'reconcile_error')?.detail).not.toContain('secret')
  })

  it('取消失败 → 记 error，不假装取消', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async () => ok<IssueState>({ state: 'closed', closedAt: null }),
      cancelTask: async () => err(makeError('CONFLICT', '乐观锁冲突')),
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 1, cancelled: 0, skipped: 0, errors: 1 })
  })

  it('取消未推进（并发改了状态）→ 记 noop，不计入 cancelled', async () => {
    const h = harness({
      listIngestedTasks: async () => [task()],
      issueState: async () => ok<IssueState>({ state: 'closed', closedAt: null }),
      cancelTask: async () =>
        ok<CancelOutcome>({ advanced: false, transitionId: null, reason: '状态已变' }),
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 1, cancelled: 0, skipped: 0, errors: 0 })
    expect(h.logs.find((l) => l.event === 'reconcile_noop')).toMatchObject({
      ref: 'acme/alpha#7',
      reason: '状态已变',
    })
  })

  it('external_ref 形状不对 → 记 error，不发请求、不取消', async () => {
    const h = harness({
      listIngestedTasks: async () => [task({ externalRef: 'acme/alpha' })],
    })

    const stats = await reconcileClosedIssues(h.deps, new Set())

    expect(stats).toEqual({ checked: 0, cancelled: 0, skipped: 0, errors: 1 })
    expect(h.stateCalls).toEqual([])
  })

  it('停止信号 → 不再发起新的对账', async () => {
    const h = harness({
      listIngestedTasks: async () => [task({ taskId: 'a' }), task({ taskId: 'b' })],
      issueState: async () => ok<IssueState>({ state: 'closed', closedAt: null }),
    })

    const stats = await reconcileClosedIssues(h.deps, new Set(), {
      shouldStop: () => h.cancelCalls.length >= 1,
    })

    expect(stats.cancelled).toBe(1)
    expect(h.cancelCalls).toHaveLength(1)
  })
})

describe('cancellationApplies · 关闭≠取消的显式守卫', () => {
  it('只有 S-PR_OPEN 例外，其余非终态关闭即取消', () => {
    const statuses: TaskStatus[] = [
      'S-NEW',
      'S-PM_ANALYZING',
      'S-NEED_CLARIFICATION',
      'S-BRAINSTORM',
      'S-RFC_DRAFT',
      'S-RFC_READY',
      'S-HUMAN_REVIEW',
      'S-DEVELOPING',
      'S-QA',
      'S-REVIEW',
      'S-PR_OPEN',
    ]
    for (const status of statuses) {
      expect(cancellationApplies(status), status).toBe(status !== 'S-PR_OPEN')
    }
  })
})

describe('parseIssueNumber', () => {
  it('从 owner/repo#n 取编号', () => {
    expect(parseIssueNumber('acme/alpha#7')).toBe(7)
    expect(parseIssueNumber('org/repo.name#1234')).toBe(1234)
  })

  it('形状不对 / 编号非法 → undefined', () => {
    for (const ref of ['acme/alpha', 'acme/alpha#', 'acme/alpha#0', 'acme/alpha#abc', '#7']) {
      expect(parseIssueNumber(ref), ref).toBeUndefined()
    }
  })
})
