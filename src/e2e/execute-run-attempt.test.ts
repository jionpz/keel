/**
 * executeRun 的 Run 身份 —— #1-04。
 *
 * 旧实现把 run.attempt 与 idempotency_key 写死成 1:
 *   run: { ..., attempt: 1 }
 *   idempotency_key: `${taskId}/${stage}/1`
 * 第二次 develop 会撞上第一次的 key —— Run 级幂等失效。
 *
 * 现在 executeRun 必须用 pending.attempt(来自 run 表,与 createRun 副作用同源)。
 * 本测试铺一个 attempt=2 的 PENDING develop run,驱动 executeRun 一次,
 * 断言 adapter 实际收到的 runSpec 身份是 2 / `${taskId}/develop/2`。
 *
 * 用 fixed workspace 模式,不依赖 git 仓库 —— 只验身份,不验提交。
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

/** 记录 startRun 收到的 RunSpec —— 证明 executeRun 传了什么身份下去 */
class RecordingAdapter implements HarnessAdapter {
  specs: RunSpec[] = []
  describe(): HarnessDescriptor {
    return {
      harness_id: 'recording',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    this.specs.push(spec)
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'recording' } }
  }
  async awaitResult(): Promise<{ ok: true; value: RunResult }> {
    return {
      ok: true,
      value: {
        status: 'SUCCEEDED',
        text: JSON.stringify({
          schema_version: '1.0',
          run_id: 'r',
          stage: 'develop',
          verdict: 'implemented',
          reason: '桩',
        }),
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
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

let adapter: RecordingAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new RecordingAdapter()
})

afterAll(async () => {
  await closePool()
})

describe('#1-04 · executeRun 用 pending.attempt 构造 Run 身份', () => {
  it('attempt=2 的 PENDING run → adapter 收到 attempt=2、key 以 /2 结尾', async () => {
    const repoId = randomUUID()
    const taskId = randomUUID()
    const runId = randomUUID()
    const now = '2026-08-24T12:00:00Z'

    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
         VALUES ($1,'local','file:///tmp/x','main')`,
        [repoId],
      )
      await c.query(
        `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
         VALUES ($1,'S-DEVELOPING','t',$2,'main','ai/t')`,
        [taskId, repoId],
      )
      // 第二次 develop:attempt=2,key 以 /2 结尾(与 createRun 副作用同构)
      await c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
         VALUES ($1,$2,'develop','Developer',2,'PENDING',$3)`,
        [runId, taskId, `${taskId}/develop/2`],
      )
    })

    const result = await runTaskToCompletion(
      taskId,
      {
        driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
        sessions: new HarnessSessionManager(),
        adapter,
        workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
        now: () => now,
      },
      { maxSteps: 1 },
    )

    // maxSteps=1:executeRun 至少执行一次然后停 —— 非终态是预期的
    expect(result.ok).toBe(false)
    expect(adapter.specs.length, '应至少执行一次 startRun').toBeGreaterThan(0)
    const spec = adapter.specs[0]
    if (spec === undefined) return
    expect(spec.run.run_id).toBe(runId)
    expect(spec.run.attempt).toBe(2)
    // SessionManager.advance 会追加 #turnN 轮次后缀(R-007);基础 key 必须以 /2 结尾
    const baseKey = spec.idempotency_key.split('#')[0]
    expect(baseKey).toBe(`${taskId}/develop/2`)

    // ended_at 走注入的 now —— 不读系统时钟(ADR-0003)
    const run = await asOwner((c) =>
      c.query<{ attempt: number; ended_at: string | null }>(
        'SELECT attempt, ended_at FROM run WHERE id=$1',
        [runId],
      ),
    )
    expect(run.rows[0]?.attempt).toBe(2)
    // DB 把 timestamptz 规范化输出;比较归一化后的时间值而不比字符串
    expect(new Date(run.rows[0]?.ended_at ?? '').toISOString()).toBe(new Date(now).toISOString())
  })
})
