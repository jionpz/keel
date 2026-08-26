/**
 * 预算熔断（C1–C3）与 trace_id 贯穿（O2）—— **确定性**验证，不调真实模型。
 *
 * 钉住的主张（docs/08-cross-cutting.md §3、docs/04-state-machine.md §3.1）：
 *
 * 1. run 成功后 usage 如实写回 run 行 —— 三态 cost_basis 原样落库（C1）
 * 2. Task 无显式预算时全局默认生效（C2）
 * 3. 超预算触发 C-002：control_mode → paused，**status 不变**，
 *    事件流留下 ControlModeChanged + BudgetExceeded，且不再派发新 run（C3）
 * 4. `unavailable` 的成本不参与金额熔断 —— 「不知道花了多少」≠「花了 0」
 * 5. 同一 Task 的所有事件共享同一个非 null trace_id（O2）
 *
 * 留在默认 check 里：熔断一旦回归，无人干预闭环就会安静地烧钱 ——
 * 这正是把成本控制从「阶段三」前移到 v0.1 的理由。
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../contracts/harness-adapter.js'
import type { Usage } from '../contracts/types.js'
import { DEFAULT_TASK_BUDGET_USD } from '../control/budget/fuse.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'

/** 桩 Adapter：产出合法的 pm 结论，并按注入的 usage 上报成本 */
class CostReportingAdapter implements HarnessAdapter {
  private lastRunId = ''

  constructor(private readonly usage: Usage) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: 'cost-stub',
      version: '0',
      tier: 'L0',
      capabilities: ['CAP-HEADLESS', 'CAP-UNTRUSTED_WORKSPACE'],
      cost_basis: this.usage.cost_basis,
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.lastRunId = spec.run.run_id
    return ok({ run_id: spec.run.run_id, harness_id: 'cost-stub' })
  }

  async awaitResult(): Promise<Result<RunResult>> {
    return ok({
      status: 'SUCCEEDED',
      text: JSON.stringify({
        schema_version: '1.0',
        run_id: this.lastRunId,
        stage: 'pm',
        verdict: 'actionable',
        reason: '桩：可做',
        details: { needs_design: false },
      }),
      proposals: [],
      usage: this.usage,
      session_ref: null,
    })
  }

  async collectChanges(): Promise<Result<WorkspaceDiff>> {
    return ok({ files_changed: [], patch: null, commits: [], is_dirty: false })
  }

  async interrupt(): Promise<Result<void>> {
    return ok(undefined)
  }

  async dispose(): Promise<Result<DisposeReport>> {
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}

let ws: string

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  ws = mkdtempSync(join(tmpdir(), 'keel-budget-'))
})

afterAll(async () => {
  rmSync(ws, { recursive: true, force: true })
  await closePool()
})

async function seedTask(budgetUsd: number | null): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const feedbackId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
      [repoId, `file://${ws}`],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,'预算熔断验证')`,
      [feedbackId, `ref-${feedbackId}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch, budget_usd)
       VALUES ($1,'S-NEW','预算熔断验证',$2,'main',$3,$4)`,
      [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`, budgetUsd],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
  })
  return taskId
}

function depsWith(adapter: HarnessAdapter) {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: ws } as const,
    now: () => '2026-08-26T12:00:00Z',
  }
}

interface EventRow {
  type: string
  payload: Record<string, unknown>
  trace_id: string | null
}

async function eventsOf(taskId: string): Promise<EventRow[]> {
  const r = await asOwner((c) =>
    c.query<EventRow>('SELECT type, payload, trace_id FROM event WHERE task_id=$1 ORDER BY seq', [
      taskId,
    ]),
  )
  return r.rows
}

describe('C3 · 超预算熔断（C-002）', () => {
  it('成本写回 → 超预算 → paused（status 不变）+ 事件对，且不再派发新 run', async () => {
    const taskId = await seedTask(1)
    const adapter = new CostReportingAdapter({
      tokens_in: 120,
      tokens_out: 80,
      cost_usd: 5,
      cost_basis: 'estimated',
    })

    const result = await runTaskToCompletion(taskId, depsWith(adapter), { maxSteps: 10 })

    // ── 1. 熔断是正常停止，不是错误：status 停在 PM 阶段 ──
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-PM_ANALYZING')

    // ── 2. control_mode → paused，status 不变（C-002 的正交性）──
    const task = await asOwner((c) =>
      c.query<{ status: string; control_mode: string }>(
        'SELECT status, control_mode FROM task WHERE id=$1',
        [taskId],
      ),
    )
    expect(task.rows[0]?.control_mode).toBe('paused')
    expect(task.rows[0]?.status).toBe('S-PM_ANALYZING')

    // ── 3. C1：usage 如实写回 run 行 ──
    const run = await asOwner((c) =>
      c.query<{
        status: string
        tokens_in: string | null
        tokens_out: string | null
        cost_usd: string | null
        cost_basis: string | null
      }>(
        `SELECT status, tokens_in, tokens_out, cost_usd, cost_basis
         FROM run WHERE task_id=$1 AND stage='pm'`,
        [taskId],
      ),
    )
    expect(run.rows[0]?.status).toBe('SUCCEEDED')
    expect(Number(run.rows[0]?.tokens_in)).toBe(120)
    expect(Number(run.rows[0]?.tokens_out)).toBe(80)
    expect(Number(run.rows[0]?.cost_usd)).toBe(5)
    expect(run.rows[0]?.cost_basis).toBe('estimated')

    // ── 4. 事件对：ControlModeChanged（C-002）+ BudgetExceeded ──
    const evs = await eventsOf(taskId)
    const modeChanged = evs.find((e) => e.type === 'ControlModeChanged')
    expect(modeChanged, '应有 ControlModeChanged').toBeDefined()
    expect(modeChanged?.payload.transition).toBe('C-002')
    expect(modeChanged?.payload.from).toBe('auto')
    expect(modeChanged?.payload.to).toBe('paused')
    const exceeded = evs.find((e) => e.type === 'BudgetExceeded')
    expect(exceeded, '应有 BudgetExceeded').toBeDefined()
    expect(exceeded?.payload.cost_spent_usd).toBe(5)
    expect(exceeded?.payload.budget_usd).toBe(1)

    // ── 5. 熔断后不派发新 run：RunSucceeded 被 control_mode 拒绝（NoTransition），
    //       全 Task 只有 pm 那一个 run，且没有 PENDING ──
    const noTransition = evs.find(
      (e) => e.type === 'NoTransition' && e.payload.reason === 'control_mode_not_auto',
    )
    expect(noTransition, '暂停后的 RunSucceeded 应被如实记录为 NoTransition').toBeDefined()
    const runs = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM run WHERE task_id=$1', [taskId]),
    )
    expect(Number(runs.rows[0]?.n)).toBe(1)
    const pending = await asOwner((c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM run WHERE task_id=$1 AND status='PENDING'`,
        [taskId],
      ),
    )
    expect(Number(pending.rows[0]?.n)).toBe(0)

    // ── 6. O2：同一 Task 所有事件的 trace_id 相同且非 null ──
    expect(evs.length).toBeGreaterThan(3)
    const traceIds = [...new Set(evs.map((e) => e.trace_id))]
    expect(traceIds.length, '全部事件应共享同一个 trace_id').toBe(1)
    expect(traceIds[0]).not.toBeNull()
  })

  it('C2 · 无显式预算时全局默认生效', async () => {
    const taskId = await seedTask(null)
    const adapter = new CostReportingAdapter({
      tokens_in: null,
      tokens_out: null,
      cost_usd: DEFAULT_TASK_BUDGET_USD + 1,
      cost_basis: 'billed',
    })

    const result = await runTaskToCompletion(taskId, depsWith(adapter), { maxSteps: 10 })
    expect(result.ok).toBe(true)

    const task = await asOwner((c) =>
      c.query<{ control_mode: string }>('SELECT control_mode FROM task WHERE id=$1', [taskId]),
    )
    expect(task.rows[0]?.control_mode).toBe('paused')

    const evs = await eventsOf(taskId)
    const exceeded = evs.find((e) => e.type === 'BudgetExceeded')
    expect(exceeded?.payload.budget_usd, '默认预算应来自 DEFAULT_TASK_BUDGET_USD').toBe(
      DEFAULT_TASK_BUDGET_USD,
    )
  })

  it('unavailable 的成本不参与金额熔断 —— 「不知道」不折算成 0 或任何金额', async () => {
    // 预算低到只要 unavailable 被折算成任何数字都必然误触发
    const taskId = await seedTask(0.01)
    const adapter = new CostReportingAdapter({
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      cost_basis: 'unavailable',
    })

    // maxSteps=2：派发 + PM 阶段。之后停下 —— 这里只钉熔断不误触发
    await runTaskToCompletion(taskId, depsWith(adapter), { maxSteps: 2 })

    const task = await asOwner((c) =>
      c.query<{ control_mode: string }>('SELECT control_mode FROM task WHERE id=$1', [taskId]),
    )
    expect(task.rows[0]?.control_mode, 'unavailable 不该触发金额熔断').toBe('auto')

    const run = await asOwner((c) =>
      c.query<{ cost_usd: string | null; cost_basis: string | null }>(
        `SELECT cost_usd, cost_basis FROM run WHERE task_id=$1 AND stage='pm'`,
        [taskId],
      ),
    )
    expect(run.rows[0]?.cost_usd, '禁止用 0 冒充 unavailable').toBeNull()
    expect(run.rows[0]?.cost_basis).toBe('unavailable')

    const evs = await eventsOf(taskId)
    expect(evs.find((e) => e.type === 'BudgetExceeded')).toBeUndefined()
  })
})
