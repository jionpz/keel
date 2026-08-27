/**
 * 并发守卫（N2–N4）—— **确定性**验证，不调真实模型。
 *
 * 钉住的主张（docs/08-cross-cutting.md §4.2–§4.4）：
 *
 * 1. N2：`driver.advance` 的 status 更新走乐观锁 —— 并发写者先行提交时
 *    返回 CONFLICT（可重试），**副作用一个不落地**，事件流如实记录冲突。
 *    用真实的行锁竞争验证，同步点靠 pg_stat_activity 轮询而非 sleep 赌时序。
 * 2. N3：run 的生命周期真的经过 RUNNING —— 成功路径 PENDING→RUNNING→SUCCEEDED
 *    （started_at 由认领落盘），失败路径落 FAILED 而不是滞留 RUNNING。
 * 3. N4：全局 RUNNING 达上限时编排器**报错停下**，不静默吞掉，
 *    run 原样留在 PENDING。
 *
 * 单条约束的 DB 层反例见 src/control/concurrency/limits.test.ts。
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
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

const NOW = '2026-08-27T12:00:00Z'
const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))

/** 桩 Adapter：产出合法的 pm 结论，成本 unavailable（不触发预算熔断） */
class SucceedingAdapter implements HarnessAdapter {
  private lastRunId = ''

  describe(): HarnessDescriptor {
    return {
      harness_id: 'concurrency-stub',
      version: '0',
      tier: 'L0',
      capabilities: ['CAP-HEADLESS', 'CAP-UNTRUSTED_WORKSPACE'],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.lastRunId = spec.run.run_id
    return ok({ run_id: spec.run.run_id, harness_id: 'concurrency-stub' })
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
      usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
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

/** 桩 Adapter：启动即失败 —— 验证失败路径离开 RUNNING */
class FailingAdapter implements HarnessAdapter {
  describe(): HarnessDescriptor {
    return new SucceedingAdapter().describe()
  }

  async startRun(): Promise<Result<RunHandle>> {
    return err(makeError('HARNESS_UNAVAILABLE', '桩：二进制缺失'))
  }

  async awaitResult(): Promise<Result<RunResult>> {
    return err(makeError('PROTOCOL_ERROR', '桩：不应被调用'))
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
  ws = mkdtempSync(join(tmpdir(), 'keel-concurrency-'))
})

afterAll(async () => {
  rmSync(ws, { recursive: true, force: true })
  await closePool()
})

async function seedTask(): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
      [repoId, `file://${ws}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','并发守卫验证',$2,'main',$3)`,
      [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
    )
  })
  return taskId
}

function depsWith(adapter: HarnessAdapter) {
  return {
    driver,
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: ws } as const,
    now: () => NOW,
  }
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id=$1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

/**
 * 确定性同步点：等到出现一个阻塞在锁等待上的 `UPDATE task ...`。
 *
 * 轮询 pg_stat_activity 而不是 sleep 固定时长 —— 后者是时序赌博，
 * 而「flaky 测试不得留在默认 check 里」（quality-guidelines.md）。
 * 测试连接与池连接同用户，query 文本互相可见。
 */
async function waitForBlockedTaskWriter(c: PoolClient): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    // pg_stat_activity 在事务内是快照缓存的 —— 不刷新的话每次轮询都读到第一眼的旧数据
    await c.query('SELECT pg_stat_clear_snapshot()')
    const r = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE task%'`,
    )
    if (Number(r.rows[0]?.n ?? 0) > 0) return
    if (Date.now() > deadline) {
      throw new Error('advance 的 UPDATE 没有在预期时间内阻塞到 task 行锁上')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('N2 · task.status 乐观锁', () => {
  // 15s：本用例含真实的锁等待与轮询同步点，给足余量（同步点本身不靠时序）
  it('并发写者先行提交 → advance 返回 CONFLICT，副作用一个不落地', {
    timeout: 15_000,
  }, async () => {
    const taskId = await seedTask()

    const outcome = await asOwner(async (c) => {
      await c.query('BEGIN')
      try {
        // 模拟并发写者：先占住 task 行锁
        await c.query('SELECT id FROM task WHERE id=$1 FOR UPDATE', [taskId])
        // advance 走池里的另一个连接：读到 S-NEW、命中 T-002，随后阻塞在 UPDATE 上
        const advancing = driver.advance(taskId, { type: 'Dispatch' }, NOW)
        await waitForBlockedTaskWriter(c)
        // 并发写者先行提交 —— status 已不再是 advance 读到的 S-NEW
        await c.query(`UPDATE task SET status='S-PM_ANALYZING' WHERE id=$1`, [taskId])
        await c.query('COMMIT')
        return await advancing
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined)
        throw e
      }
    })

    // 1. 败者得到 CONFLICT（可重试）—— 不是静默成功，也不是不可恢复的失败
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.kind).toBe('CONFLICT')
    expect(outcome.error.retryable).toBe(true)

    // 2. 副作用一个不落地：T-002 的 CreateRun 没有发生
    const runs = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM run WHERE task_id=$1', [taskId]),
    )
    expect(Number(runs.rows[0]?.n), '冲突时不得创建 run').toBe(0)

    // 3. 状态是并发写者留下的 —— advance 没有覆盖它（丢更新正是 N2 要防的）
    expect(await statusOf(taskId)).toBe('S-PM_ANALYZING')

    // 4. 事件流如实记录「看到了这个事件但因乐观锁没动」
    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: Record<string, unknown> }>(
        'SELECT type, payload FROM event WHERE task_id=$1 ORDER BY seq',
        [taskId],
      ),
    )
    const conflictEv = evs.rows.find(
      (e) => e.type === 'NoTransition' && e.payload.reason === 'optimistic_lock_conflict',
    )
    expect(conflictEv, '乐观锁冲突应留下 NoTransition 事件').toBeDefined()
    expect(conflictEv?.payload.event).toBe('Dispatch')
  })
})

describe('N3 · run 生命周期真的经过 RUNNING', () => {
  it('成功路径：PENDING→RUNNING→SUCCEEDED，started_at 由认领落盘', async () => {
    const taskId = await seedTask()
    // maxSteps=2：派发 + 执行 pm run。这里只钉生命周期，不关心后续阶段
    await runTaskToCompletion(taskId, depsWith(new SucceedingAdapter()), { maxSteps: 2 })

    const run = await asOwner((c) =>
      c.query<{ status: string; started_at: Date | null; ended_at: Date | null }>(
        `SELECT status, started_at, ended_at FROM run WHERE task_id=$1 AND stage='pm'`,
        [taskId],
      ),
    )
    expect(run.rows[0]?.status).toBe('SUCCEEDED')
    expect(run.rows[0]?.started_at, '认领（PENDING→RUNNING）应写 started_at').not.toBeNull()
    expect(run.rows[0]?.ended_at).not.toBeNull()
  })

  it('失败路径：run 落 FAILED 而不是滞留 RUNNING，error_kind 如实记录', async () => {
    const taskId = await seedTask()
    const result = await runTaskToCompletion(taskId, depsWith(new FailingAdapter()), {
      maxSteps: 5,
    })

    // 失败是状态流转,不是编排器异常(R1, issue #23):
    // T-030 重试耗尽 → T-031 升人工 → 停 S-HUMAN_REVIEW,不静默吞错
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-HUMAN_REVIEW')

    const run = await asOwner((c) =>
      c.query<{ status: string; error_kind: string | null; ended_at: Date | null }>(
        `SELECT status, error_kind, ended_at FROM run WHERE task_id=$1 AND stage='pm' ORDER BY attempt`,
        [taskId],
      ),
    )
    expect(run.rows[0]?.status, '失败的 run 必须离开 RUNNING').toBe('FAILED')
    expect(run.rows[0]?.error_kind).toBe('HARNESS_UNAVAILABLE')
    expect(run.rows[0]?.ended_at).not.toBeNull()

    const running = await asOwner((c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE status='RUNNING'`),
    )
    expect(Number(running.rows[0]?.n), '不得有 run 滞留在 RUNNING').toBe(0)
  })
})

describe('N4 · 全局 RUNNING 上限在编排循环中生效', () => {
  it('上限已满 → 编排器报 CONFLICT 停下，run 原样留在 PENDING', async () => {
    // 占满全局名额：3 个别的 Task 各挂一个 RUNNING run（DEFAULT_MAX_RUNNING_RUNS = 3）
    for (let i = 0; i < 3; i++) {
      const otherId = await seedTask()
      await asOwner((c) =>
        c.query(
          `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key, started_at)
           VALUES ($1,$2,'develop','Developer',1,'RUNNING',$3,now())`,
          [randomUUID(), otherId, `${otherId}/develop/1`],
        ),
      )
    }

    const taskId = await seedTask()
    const result = await runTaskToCompletion(taskId, depsWith(new SucceedingAdapter()), {
      maxSteps: 5,
    })

    // 不静默吞掉：认领被拒以可重试 CONFLICT 向上传播
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('CONFLICT')
    expect(result.error.retryable).toBe(true)
    expect(result.error.detail).toContain('上限')

    // run 原样留在 PENDING（名额释放后可继续），任务状态停在 PM 阶段
    const run = await asOwner((c) =>
      c.query<{ status: string }>(`SELECT status FROM run WHERE task_id=$1 AND stage='pm'`, [
        taskId,
      ]),
    )
    expect(run.rows[0]?.status).toBe('PENDING')
    expect(await statusOf(taskId)).toBe('S-PM_ANALYZING')
  })
})
