/**
 * durable timer 方案 B e2e —— in-flight run 墙钟收割(issue #26)。
 *
 * 覆盖:
 *   C1:挂起 adapter + 短 wallClockMs → watchdog interrupt('timeout')
 *       → awaitResult 返 TIMEOUT → RUN_TIMEOUT → run TIMEOUT → T-030 重试
 *   C2:成功 run 后墙钟 timer 置 cancelled,claimDueTimers 不再返回
 *   C3:幂等 —— 同一 run 至多一个 pending 墙钟 timer
 *
 * fake adapter 模拟 OMP 挂起:awaitResult 挂起直到 interrupt 置 flag,
 * 随后返回 TIMEOUT(fake 简化:interrupt 后 awaitResult 立即返 TIMEOUT)。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  InterruptReason,
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

let clock = '2026-08-26T12:00:00Z'
const now = () => clock

/** 可挂起 + interrupt 置 flag 的 fake adapter(模拟 OMP timeout 收敛) */
class HangingAdapter implements HarnessAdapter {
  calls: string[] = []
  private readonly interrupted = new Map<string, InterruptReason>()
  private readonly bodyByRun = new Map<string, Record<string, unknown>>()
  private readonly pending: Array<Record<string, unknown>> = []
  /** 第几次 awaitResult 挂起(1-based);其余正常返回。缺省 0 不挂 */
  hangAwait: number[] = []
  private awaitCount = 0

  appendBody(body: Record<string, unknown>): void {
    this.pending.push(body)
  }
  describe(): HarnessDescriptor {
    return {
      harness_id: 'hang-stub',
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
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'hang-stub' } }
  }
  async awaitResult(handle: RunHandle): Promise<{ ok: true; value: RunResult }> {
    this.awaitCount++
    // 挂起:等待 interrupt(模拟 OMP 进程直到被 SIGTERM)—— 周期性让步
    if (this.hangAwait.includes(this.awaitCount)) {
      for (;;) {
        const reason = this.interrupted.get(handle.run_id)
        if (reason !== undefined) break
        await new Promise((r) => setTimeout(r, 5))
      }
      const reason = this.interrupted.get(handle.run_id)
      return {
        ok: true,
        value: {
          // interrupt('timeout') → TIMEOUT(R-009,可重试);其他 → CANCELLED
          status: reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED',
          text: null,
          proposals: [],
          usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
          session_ref: null,
        },
      }
    }
    const body = this.bodyByRun.get(handle.run_id) ?? {}
    return {
      ok: true,
      value: {
        status: 'SUCCEEDED',
        text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      },
    }
  }
  async interrupt(
    handle: RunHandle,
    reason: InterruptReason,
  ): Promise<{ ok: true; value: undefined }> {
    this.interrupted.set(handle.run_id, reason)
    return { ok: true, value: undefined }
  }
  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    return { ok: true, value: { files_changed: [], patch: null, commits: [], is_dirty: false } }
  }
  async dispose(): Promise<{ ok: true; value: DisposeReport }> {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } }
  }
}

let adapter: HangingAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo, timer RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new HangingAdapter()
  clock = '2026-08-26T12:00:00Z'
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
       VALUES ($1,'S-NEW','方案 B',$2,'main','ai/t')`,
      [taskId, repoId],
    )
  })
  return taskId
}

function depsFor(wallClockS?: number) {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
    now,
    ...(wallClockS === undefined ? {} : { wallClockS }),
  }
}

async function wallTimers(taskId: string): Promise<{ state: string; run_id: string | null }[]> {
  const r = await asOwner((c) =>
    c.query<{ state: string; run_id: string | null }>(
      `SELECT state, run_id FROM timer WHERE task_id=$1 AND kind='wall_clock'`,
      [taskId],
    ),
  )
  return r.rows
}

describe('durable timer 方案 B · in-flight 收割(issue #26)', () => {
  it('C1.挂起 run1 超时 → interrupt(timeout) → TIMEOUT → T-030 重试 run2 成功', async () => {
    const taskId = await seedTask()
    // pm(run1)挂起 → wallClockS=0.05s → watchdog interrupt('timeout') → TIMEOUT
    // → failRunAndAdvance 标 run TIMEOUT → RunTimeout → T-030 建 pm(run2)
    // → run2 正常成功 → S-RFC_DRAFT(needs_design:false)
    adapter.hangAwait = [1]
    adapter.appendBody({
      schema_version: '1.0',
      run_id: 'r',
      stage: 'pm',
      verdict: 'actionable',
      reason: 'ok',
      details: { needs_design: false },
    })
    adapter.appendBody({
      schema_version: '1.0',
      run_id: 'r',
      stage: 'pm',
      verdict: 'actionable',
      reason: 'ok',
      details: { needs_design: false },
    })
    adapter.appendBody({
      schema_version: '1.0',
      title: 't',
      problem: 'p',
      goals: ['g'],
      non_goals: [],
      proposed_change: { summary: 's', affected_areas: ['x'], approach: 'a' },
      acceptance_criteria: [{ id: 'AC1', text: 't', verifiable_by: '测试' }],
      policy_facts: {
        risk: 'low',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
      },
    })

    // maxSteps=5:第 5 轮读 Policy(rfc_ready low→auto)建 develop 后结束,
    // 循环如实报告非终态 —— 核心断言在下方 run 状态与 timer
    const result = await runTaskToCompletion(taskId, depsFor(0.05), { maxSteps: 5 })
    void result

    // run1 超时 → RunTimeout → T-030 重试(run2 attempt=2)
    const runs = await asOwner((c) =>
      c.query<{ attempt: number; status: string; error_kind: string | null }>(
        `SELECT attempt, status, error_kind FROM run WHERE task_id=$1 AND stage='pm' ORDER BY attempt`,
        [taskId],
      ),
    )
    expect(runs.rows).toHaveLength(2)
    expect(runs.rows[0]?.status).toBe('TIMEOUT')
    expect(runs.rows[0]?.error_kind).toBe('RUN_TIMEOUT')
    expect(runs.rows[1]?.status).toBe('SUCCEEDED')

    // 每个 run 一个墙钟 timer;pm1(挂起失败)+ pm2 + rfc_draft 都取消(防残留)
    const timers = await wallTimers(taskId)
    expect(timers.length).toBe(3) // pm(run1)+ pm(run2)+ rfc_draft
    expect(timers.every((t) => t.state === 'cancelled')).toBe(true)
  })

  it('C3.墙钟 timer 幂等:同 run 至多一个 pending;成功 run 的 timer cancelled', async () => {
    const taskId = await seedTask()
    adapter.appendBody({
      schema_version: '1.0',
      run_id: 'r',
      stage: 'pm',
      verdict: 'actionable',
      reason: 'ok',
      details: { needs_design: false },
    })
    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 2 })
    const timers = await wallTimers(taskId)
    expect(timers.length).toBe(1)
    expect(timers[0]?.state).toBe('cancelled')
    expect(timers[0]?.run_id).not.toBeNull()
  })
  it('C2.墙钟 timer 幂等:同 run 只一个 pending;成功 run 无残留 pending', async () => {
    const taskId = await seedTask()
    adapter.appendBody({
      schema_version: '1.0',
      run_id: 'r',
      stage: 'pm',
      verdict: 'actionable',
      reason: 'ok',
      details: { needs_design: false },
    })
    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 2 })
    // pm run 成功 → 其墙钟 cancelled;全 task 无 pending wall_clock
    const timers = await wallTimers(taskId)
    expect(timers.length).toBe(1)
    expect(timers[0]?.state).toBe('cancelled')
    expect(timers[0]?.run_id).not.toBeNull()
  })
})
