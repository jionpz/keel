/**
 * 停止原因可区分 —— 「设计内等待」与「卡住」不许再长得一样。
 *
 * 旧实现：阶段态没有 PENDING run 就 `return ok`。于是派发丢失（转移没建出 run）
 * 与「等人回答 / 等人工审批」在调用方看来完全一致：退出码 0、finalStatus 报中间状态。
 * 2026-10-26 的 firstRun 撞键 bug 正是被这层兜住，任务静默停在 S-QA。
 *
 * 判据只读证据（最近一次 run 的状态），不按状态归类 —— 人工撤回（R-010）也会让
 * 阶段态没有待执行 run，而那是设计内的停。
 *
 * 这里直接种 task / run 行，不跑真 harness：要验的是「读状态 + 判停止原因」这一段。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import { HarnessSessionManager } from '../../execution/session/manager.js'
import { asOwner, closePool } from '../../fact/db.js'
import { WorkflowDriver } from '../driver/driver.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { runTaskToCompletion } from './loop.js'

const NOW = '2026-10-26T12:00:00Z'

/** 永远不会被调用：本文件的用例都直接种状态，循环在派发之前就返回 */
class NeverCalledAdapter implements HarnessAdapter {
  describe(): HarnessDescriptor {
    return {
      harness_id: 'never',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    throw new Error(`不该执行任何 run（收到 ${spec.run.stage}）`)
  }
  async awaitResult(): Promise<{ ok: true; value: RunResult }> {
    throw new Error('不该执行任何 run')
  }
  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    throw new Error('不该执行任何 run')
  }
  async interrupt(): Promise<{ ok: true; value: undefined }> {
    return { ok: true, value: undefined }
  }
  async dispose(): Promise<{ ok: true; value: DisposeReport }> {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } }
  }
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  await closePool()
})

function deps() {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter: new NeverCalledAdapter(),
    workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
    now: () => NOW,
  }
}

async function seedTask(status: string, controlMode = 'auto'): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, control_mode, title, repo_id, base_branch, work_branch)
       VALUES ($1,$2,$3,'停止原因',$4,'main','ai/t')`,
      [taskId, status, controlMode, repoId],
    )
  })
  return taskId
}

async function seedRun(
  taskId: string,
  stage: string,
  attempt: number,
  status: string,
): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key, started_at)
       VALUES ($1,$2,$3,'PM',$4,$5,$6,$7)`,
      [randomUUID(), taskId, stage, attempt, status, `${taskId}/${stage}/${attempt}`, NOW],
    ),
  )
}

describe('阶段态 · 没有待执行 run', () => {
  it('最近 run 已 SUCCEEDED 却没有新 run → 报错（派发丢失），detail 可直接定位', async () => {
    const taskId = await seedTask('S-QA')
    await seedRun(taskId, 'qa', 1, 'SUCCEEDED')

    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 3 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
    expect(r.error.retryable).toBe(false)
    // 三个定位要素：停在哪个状态、上一次派发是什么、下一步查什么
    expect(r.error.detail).toContain('S-QA')
    expect(r.error.detail).toContain('qa/1')
    expect(r.error.detail).toContain('SUCCEEDED')
    expect(r.error.detail).toContain('existing_status')
  })

  it('最近 run 仍 RUNNING（没人推进）→ 报错并点名 RUNNING', async () => {
    const taskId = await seedTask('S-DEVELOPING')
    await seedRun(taskId, 'develop', 2, 'RUNNING')

    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 3 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('S-DEVELOPING')
    expect(r.error.detail).toContain('RUNNING')
  })

  it('该 task 从未创建过 run → 报错（首次派发就丢了）', async () => {
    const taskId = await seedTask('S-PM_ANALYZING')

    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 3 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.detail).toContain('从未创建过')
  })

  it('最近 run CANCELLED（R-010 人工撤回）→ 仍是成功，stopReason=cancelled', async () => {
    const taskId = await seedTask('S-PM_ANALYZING')
    await seedRun(taskId, 'pm', 1, 'CANCELLED')

    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 3 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.finalStatus).toBe('S-PM_ANALYZING')
    expect(r.value.stopReason).toBe('cancelled')
  })
})

describe('设计内等待 · 全部仍是成功且各自带停止原因', () => {
  it('终态 → terminal', async () => {
    const taskId = await seedTask('S-DONE')
    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 2 })
    expect(r.ok && r.value.stopReason).toBe('terminal')
  })

  it('control_mode ≠ auto（预算熔断 / 人工接管）→ paused，且 status 不变', async () => {
    const taskId = await seedTask('S-PM_ANALYZING', 'paused')
    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 2 })
    expect(r.ok && r.value.stopReason).toBe('paused')
    expect(r.ok && r.value.finalStatus).toBe('S-PM_ANALYZING')
  })

  it('S-HUMAN_REVIEW 无 run → awaiting-human', async () => {
    const taskId = await seedTask('S-HUMAN_REVIEW')
    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 2 })
    expect(r.ok && r.value.stopReason).toBe('awaiting-human')
    expect(r.ok && r.value.finalStatus).toBe('S-HUMAN_REVIEW')
  })

  it('S-NEED_CLARIFICATION 无到期 timer → awaiting-clarification', async () => {
    const taskId = await seedTask('S-NEED_CLARIFICATION')
    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 2 })
    expect(r.ok && r.value.stopReason).toBe('awaiting-clarification')
  })

  it('S-PR_OPEN 未注入 CI → awaiting-external-ci', async () => {
    const taskId = await seedTask('S-PR_OPEN')
    const r = await runTaskToCompletion(taskId, deps(), { maxSteps: 2 })
    expect(r.ok && r.value.stopReason).toBe('awaiting-external-ci')
  })
})
