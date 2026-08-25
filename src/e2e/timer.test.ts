/**
 * durable timer e2e —— issue #24(方案 A)。
 *
 * 覆盖 clarification TTL 全链路:
 *   A. dispatch → pm(verdict=unclear)→ T-005 → S-NEED_CLARIFICATION
 *      → 时钟拨过 due → claim → advance(TimerFired)→ T-008 → S-ABANDONED,timer fired
 *   B. T-007:澄清态注入 ClarificationReceived → timer cancelled,
 *      随后 claim 不得再弃单(ABANDONED 不发生)
 *   C. 幂等:已 fired 的到期行再 claim 不返回(T-008 不重复)
 *
 * 用可变时钟:beforeEach 后 advance 到各时态,验证 T-005 的 StartTimer
 * 落库 due_at = now0 + 24h。
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
} from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'
import { claimDueTimers } from '../timer/drain.js'

/** 可变时钟:测试推进 now 模拟时间流逝 */
let clock: string
const now = () => clock

const ADDT = (ms: number): void => {
  clock = new Date(new Date(clock).getTime() + ms).toISOString()
}

/** 每 run 一个 body 的 fake LLM(T-005 路径:pm 产 unclear) */
class TimerAdapter implements HarnessAdapter {
  calls: string[] = []
  private readonly bodyByRun = new Map<string, Record<string, unknown>>()
  private readonly pending: Array<Record<string, unknown>> = []
  appendBody(body: Record<string, unknown>): void {
    this.pending.push(body)
  }
  describe(): HarnessDescriptor {
    return {
      harness_id: 'timer-stub',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    this.calls.push(spec.run.stage)
    const body = this.pending.shift()
    if (body === undefined) throw new Error(`没有为 ${spec.run.stage} 准备产物`)
    this.bodyByRun.set(spec.run.run_id, body)
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'timer-stub' } }
  }
  async awaitResult(handle: RunHandle): Promise<{ ok: true; value: RunResult }> {
    const body = this.bodyByRun.get(handle.run_id) ?? {}
    return {
      ok: true,
      value: {
        status: 'SUCCEEDED',
        text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
        proposals: [],
        usage: {
          tokens_in: null,
          tokens_out: null,
          cost_usd: null,
          cost_basis: 'unavailable',
        },
        session_ref: null,
      },
    }
  }
  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    return { ok: true, value: { files_changed: [], patch: null, commits: [], is_dirty: false } }
  }
  async interrupt(): Promise<{ ok: true; value: undefined }> {
    return { ok: true, value: undefined }
  }
  async dispose(): Promise<{ ok: true; value: DisposeReport }> {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } }
  }
}

let adapter: TimerAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo, timer RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new TimerAdapter()
  clock = '2026-08-25T12:00:00Z'
})

afterAll(async () => {
  await closePool()
})

async function seedTask(): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','澄清 TTL',$2,'main','ai/t')`,
      [taskId, repoId],
    )
  })
  return taskId
}

function depsFor() {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
    now,
  }
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

async function timerRow(taskId: string): Promise<{ state: string; due_at: string } | null> {
  const r = await asOwner((c) =>
    c.query<{ state: string; due_at: string }>(
      `SELECT state, due_at FROM timer WHERE task_id=$1 AND kind='clarification_ttl'`,
      [taskId],
    ),
  )
  return r.rows[0] ?? null
}

/** pm 产 unclear → T-005 → S-NEED_CLARIFICATION + StartTimer */
const unclearPm = (): Record<string, unknown> => ({
  schema_version: '1.0',
  run_id: 'r',
  stage: 'pm',
  verdict: 'unclear',
  reason: '需求表述不够',
})

describe('durable timer · clarification TTL(issue #24,方案 A)', () => {
  it('A.未到期 → 停;过了 due → claim → TimerFired → T-008 → S-ABANDONED + fired', async () => {
    const taskId = await seedTask()
    adapter.appendBody(unclearPm())

    // dispatch → pm(unclear)→ T-005 → S-NEED_CLARIFICATION + StartTimer
    const r1 = await runTaskToCompletion(taskId, depsFor(), { maxSteps: 4 })
    expect(r1.ok, r1.ok ? '' : r1.error.detail).toBe(true)
    if (!r1.ok) return
    expect(r1.value.finalStatus).toBe('S-NEED_CLARIFICATION')

    // StartTimer 落库:due_at = 初始时钟 + 24h
    const t0 = await timerRow(taskId)
    expect(t0?.state).toBe('pending')
    const due = new Date(t0?.due_at ?? '').getTime()
    expect(due - new Date('2026-08-25T12:00:00Z').getTime()).toBe(24 * 3600 * 1000)

    // 时钟拨到 due + 1ms → 未到?不 —— 拨过后已到期
    ADDT(24 * 3600 * 1000 + 1)

    // 再进 loop:claim 到期 → T-008 → S-ABANDONED
    const r2 = await runTaskToCompletion(taskId, depsFor(), { maxSteps: 2 })
    expect(r2.ok, r2.ok ? '' : r2.error.detail).toBe(true)
    if (!r2.ok) return
    expect(r2.value.finalStatus).toBe('S-ABANDONED')

    const t = await timerRow(taskId)
    expect(t?.state).toBe('fired')
  })

  it('B.T-007:回答澄清 → timer cancelled,claim 不再弃单', async () => {
    const taskId = await seedTask()
    adapter.appendBody(unclearPm())

    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 4 })
    expect(await statusOf(taskId)).toBe('S-NEED_CLARIFICATION')

    // 直接 driver.advance(ClarificationReceived) —— 模拟人工回答(T-007 取消 timer)
    const adv = await depsFor().driver.advance(taskId, { type: 'ClarificationReceived' }, now())
    expect(adv.ok && adv.value.advanced).toBe(true)

    const t = await timerRow(taskId)
    expect(t?.state).toBe('cancelled')

    // 时钟拨过 due + claim 为空(T-008 不发生,不会 ABANDONED)
    ADDT(24 * 3600 * 1000 + 1)
    const due = await claimDueTimers(now(), { taskId })
    expect(due).toEqual([])
    expect(await statusOf(taskId)).toBe('S-PM_ANALYZING') // T-007 已回 pm
  })

  it('C.幂等:已 fired 行再 claim 不返回;重复 TimerFired 不重复推进', async () => {
    const taskId = await seedTask()
    adapter.appendBody(unclearPm())

    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 4 })
    ADDT(24 * 3600 * 1000 + 1)
    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 2 })
    expect(await statusOf(taskId)).toBe('S-ABANDONED')

    // fired 后 claim 空;重复 TimerFired 不推进(已在终态,NoTransition)
    const due = await claimDueTimers(now(), { taskId })
    expect(due).toEqual([])
  })
})
