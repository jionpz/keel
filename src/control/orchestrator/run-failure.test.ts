/**
 * run 失败面端到端 —— issue #23 R1。
 *
 * 旧实现:executeRun 失败直接 return err 中止,run 卡 PENDING,
 * T-030/T-031 死转移,重入按同幂等键重复执行。
 * 现在:失败标 run FAILED + emit RunFailed → T-030 重试 / T-031 升人工。
 *
 * 覆盖:
 *   A. R-006 连续提案不合格 → RunFailed → T-030 重试(attempt=2)成功
 *   B. 连续失败到 attempt=3 → T-031 → S-HUMAN_REVIEW
 *   C. adapter 返回 CANCELLED → run 标 CANCELLED,不重试,loop 停
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

/** 可配置失败次数与 CANCELLED 的 fake LLM,按调用序返回 body */
class FailAdapter implements HarnessAdapter {
  calls: string[] = []
  private readonly bodyByRun = new Map<string, Record<string, unknown>>()
  private readonly pending: Array<Record<string, unknown>> = []
  /** 恒返回 CANCELLED(用例 C) */
  alwaysCancelled = false

  appendBody(body: Record<string, unknown>): void {
    this.pending.push(body)
  }
  describe(): HarnessDescriptor {
    return {
      harness_id: 'fail-stub',
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
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'fail-stub' } }
  }
  async awaitResult(_handle: RunHandle): Promise<{ ok: true; value: RunResult }> {
    if (this.alwaysCancelled) {
      return {
        ok: true,
        value: {
          status: 'CANCELLED',
          text: null,
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
    const body = this.bodyByRun.get(_handle.run_id) ?? {}
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

let adapter: FailAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new FailAdapter()
})

afterAll(async () => {
  await closePool()
})

async function seedTask(status = 'S-NEW'): Promise<string> {
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
       VALUES ($1,$2,'失败面',$3,'main','ai/t')`,
      [taskId, status, repoId],
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
    now: () => '2026-08-25T12:00:00Z',
  }
}

/** 非法 pm 提案(缺 run_id —— R-007 拒绝的形状) */
function badPmOutcome(): Record<string, unknown> {
  return { schema_version: '1.0', stage: 'pm', verdict: 'actionable' }
}
function goodPmOutcome(): Record<string, unknown> {
  return {
    schema_version: '1.0',
    run_id: 'r',
    stage: 'pm',
    verdict: 'actionable',
    reason: 'ok',
    details: { needs_design: false },
  }
}

describe('R1(issue #23)· run 失败面', () => {
  it('A.R-006 连续提案不合格 → RunFailed → T-030 重试(attempt=2)成功', async () => {
    const taskId = await seedTask()
    // pm(run1):R-007 同 run 内 3 轮提案,都非法 → R-006 → RunFailed → T-030
    // pm(run2):1 轮合法 → 成功 → S-RFC_DRAFT
    // (startRun 每次 turn 调用一次 —— 3+1 个 body)
    adapter.appendBody(badPmOutcome())
    adapter.appendBody(badPmOutcome())
    adapter.appendBody(badPmOutcome())
    adapter.appendBody(goodPmOutcome())
    // pm(run2) 成功后 → T-003? 不——goodPmOutcome needs_design=false → T-004 → S-RFC_DRAFT
    // rfc_draft run 需要产物 → 走到 S-RFC_READY 证明前链成功
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

    // result 可能 ok(S-RFC_READY)或 err(循环用尽停在非终态) —— 都属预期,
    // 核心断言在下方的 run 级与事件级。
    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 4 })

    // 两次 pm run:第一次失败,第二次成功
    const runs = await asOwner((c) =>
      c.query<{ attempt: number; status: string; idempotency_key: string }>(
        `SELECT attempt, status, idempotency_key FROM run WHERE task_id=$1 AND stage='pm' ORDER BY attempt`,
        [taskId],
      ),
    )
    expect(runs.rows).toHaveLength(2)
    expect(runs.rows[0]?.status).toBe('FAILED') // 失败 run 不再卡 PENDING
    expect(runs.rows[1]?.status).toBe('SUCCEEDED')
    expect(runs.rows[0]?.idempotency_key).toContain('/pm/1')
    expect(runs.rows[1]?.idempotency_key).toContain('/pm/2') // T-030 重试 key 递增

    // 事件流:T-030 重试转移(TaskStatusChanged 的 transition=T-030)+ RunCreated(pm/2)
    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: { transition?: string } }>(
        `SELECT type, payload FROM event WHERE task_id=$1`,
        [taskId],
      ),
    )
    const types = evs.rows.map((r) => r.type)
    expect(types).toContain('RunCreated')
    const transitions = evs.rows
      .filter((r) => r.type === 'TaskStatusChanged')
      .map((r) => r.payload?.transition)
    expect(transitions).toContain('T-030') // 失败后走了重试转移
  })

  it('B.连续失败到 attempt=3 → T-031 → S-HUMAN_REVIEW', async () => {
    const taskId = await seedTask()
    // 三次 pm run 各 3 turn 非法(3×3 = 9):attempt1 → T-030 → attempt2 → T-030 → attempt3 → T-031
    for (let i = 0; i < 9; i++) adapter.appendBody(badPmOutcome())

    const result = await runTaskToCompletion(taskId, depsFor(), { maxSteps: 8 })
    // 停在 S-HUMAN_REVIEW(关口态,无 PENDING)
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-HUMAN_REVIEW')

    const runs = await asOwner((c) =>
      c.query<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM run WHERE task_id=$1 AND stage='pm' ORDER BY attempt`,
        [taskId],
      ),
    )
    expect(runs.rows).toHaveLength(3)
    for (const r of runs.rows) expect(r.status).toBe('FAILED')

    // T-031 → 人工通知
    const evs = await asOwner((c) =>
      c.query<{ type: string }>(
        `SELECT type FROM event WHERE task_id=$1 AND type='SideEffectApplied'
           AND payload->>'kind'='NotifyHuman'`,
        [taskId],
      ),
    )
    expect(evs.rows.length).toBeGreaterThan(0)
  })

  it('C.adapter 返回 CANCELLED → run 标 CANCELLED,不重试,loop 停', async () => {
    const taskId = await seedTask()
    adapter.appendBody(badPmOutcome())
    adapter.alwaysCancelled = true

    const result = await runTaskToCompletion(taskId, depsFor(), { maxSteps: 4 })
    // CANCELLED 不 emit 失败事件 → 无转移 → 等外部,loop 自然停在当前状态
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-PM_ANALYZING') // 停在阶段态

    const runs = await asOwner((c) =>
      c.query<{ status: string }>(`SELECT status FROM run WHERE task_id=$1 AND stage='pm'`, [
        taskId,
      ]),
    )
    expect(runs.rows).toHaveLength(1)
    expect(runs.rows[0]?.status).toBe('CANCELLED') // 不卡 PENDING、不重试

    // 无第二个 pm run(不重试)
    const runs2 = await asOwner((c) =>
      c.query<{ attempt: number }>(`SELECT attempt FROM run WHERE task_id=$1 AND stage='pm'`, [
        taskId,
      ]),
    )
    expect(runs2.rows.every((r) => r.attempt === 1)).toBe(true)
  })
})
