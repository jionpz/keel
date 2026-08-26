/**
 * 独立 timer worker e2e —— 进程崩溃恢复(issue #26)。
 *
 * 覆盖:
 *   W1:铺 RUNNING run + 到期墙钟 timer(模拟 loop 崩溃,无 watchdog)→
 *       drainAllDueTimers → run TIMEOUT + RunTimeout → T-030 建重试 run
 *   W2:铺 S-NEED_CLARIFICATION + 到期澄清 timer → drain → T-008 →
 *       S-ABANDONED,timer fired
 *   W3:幂等 —— 二次 drain 无新动作(stats 空)
 *   W4:run 终态(SUCCEEDED)+ pending 墙钟 → drain 仅 cancel,不误触 RunTimeout
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asOwner, closePool } from '../fact/db.js'
import { drainAllDueTimers } from '../timer/worker.js'

const NOW = '2026-08-26T12:00:00Z'
const now = () => NOW

function driver() {
  return new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo, timer RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  await closePool()
})

/** 铺 task(指定状态)+ 可选 run + 可选 timer */
async function seedWith(
  taskStatus: string,
  opts: {
    run?: { stage: string; status: string }
    timer?: { kind: 'clarification_ttl' | 'wall_clock'; runId?: string; due: string }
  } = {},
): Promise<{ taskId: string; repoId: string }> {
  const taskId = randomUUID()
  const repoId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,$2,'worker',$3,'main','ai/t')`,
      [taskId, taskStatus, repoId],
    )
    if (opts.run !== undefined) {
      const runId = randomUUID()
      await c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
         VALUES ($1,$2,$3,'PM',1,$4,$5)`,
        [
          runId,
          taskId,
          opts.run.stage,
          opts.run.status === 'RUNNING' ? 'RUNNING' : 'PENDING',
          `${taskId}/${opts.run.stage}/1`,
        ],
      )
      if (opts.timer !== undefined && opts.timer.runId === undefined) {
        opts.timer = { ...opts.timer, runId }
      }
      if (opts.timer !== undefined) {
        await c.query(
          `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
           VALUES ($1,$2,$3,$4,$5,'pending')`,
          [randomUUID(), taskId, opts.timer.runId ?? runId, opts.timer.kind, opts.timer.due],
        )
      }
    }
  })
  return { taskId, repoId }
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

describe('独立 timer worker(issue #26)', () => {
  it('W1.崩溃后 RUNNING run + 到期墙钟 → reap → TIMEOUT + RunTimeout → T-030 建重试 run', async () => {
    const { taskId } = await seedWith('S-PM_ANALYZING', {
      run: { stage: 'pm', status: 'RUNNING' },
      timer: { kind: 'wall_clock', due: '2026-08-26T11:00:00Z' },
    })

    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.runTimeout).toBe(1)
    expect(await runCount(taskId)).toBe(2) // 原 run TIMEOUT + T-030 建的重试 run
    expect(await statusOf(taskId)).toBe('S-PM_ANALYZING') // 自环重试

    // 原 run 标 TIMEOUT;重试 run PENDING
    const runs = await asOwner((c) =>
      c.query<{ attempt: number; status: string }>(
        `SELECT attempt, status FROM run WHERE task_id=$1 AND stage='pm' ORDER BY attempt`,
        [taskId],
      ),
    )
    expect(runs.rows[0]?.status).toBe('TIMEOUT')
    expect(runs.rows[1]?.status).toBe('PENDING')
    expect(runs.rows[1]?.attempt).toBe(2)
  })

  it('W2.崩溃后 S-NEED_CLARIFICATION + 到期澄清 → drain → T-008 → S-ABANDONED + fired', async () => {
    const { taskId } = await seedWith('S-NEED_CLARIFICATION', {
      run: { stage: 'pm', status: 'PENDING' },
      timer: { kind: 'clarification_ttl', due: '2026-08-26T11:00:00Z' },
    })

    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.clarificationFired).toBe(1)
    expect(await statusOf(taskId)).toBe('S-ABANDONED')

    const t = await asOwner((c) =>
      c.query<{ state: string }>(`SELECT state FROM timer WHERE task_id=$1`, [taskId]),
    )
    expect(t.rows[0]?.state).toBe('fired')
  })

  it('W3.幂等:二次 drain 无新动作', async () => {
    const { taskId } = await seedWith('S-PM_ANALYZING', {
      run: { stage: 'pm', status: 'RUNNING' },
      timer: { kind: 'wall_clock', due: '2026-08-26T11:00:00Z' },
    })
    await drainAllDueTimers({ driver: driver(), now })
    const before = await runCount(taskId)

    const stats2 = await drainAllDueTimers({ driver: driver(), now })
    expect(stats2.runTimeout).toBe(0)
    expect(stats2.clarificationFired).toBe(0)
    expect(await runCount(taskId)).toBe(before) // 无新增 run
  })

  it('W4.run 已终态 + pending 墙钟 → drain 仅 cancel timer,不误触 RunTimeout', async () => {
    const { taskId } = await seedWith('S-RFC_DRAFT', {
      run: { stage: 'pm', status: 'RUNNING' }, // RUNNING?不 —— 用 SUCCEEDED 模拟终态
      timer: { kind: 'wall_clock', due: '2026-08-26T11:00:00Z' },
    })
    // 改为 SUCCEEDED(终态)
    await asOwner((c) => c.query(`UPDATE run SET status='SUCCEEDED' WHERE task_id=$1`, [taskId]))

    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.runTimeout).toBe(0) // 非 RUNNING → skipped
    expect(await runCount(taskId)).toBe(1) // 无重试 run

    const t = await asOwner((c) =>
      c.query<{ state: string }>(`SELECT state FROM timer WHERE task_id=$1`, [taskId]),
    )
    expect(t.rows[0]?.state).toBe('cancelled') // 仅 cancel
  })
})

async function runCount(taskId: string): Promise<number> {
  const r = await asOwner((c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1`, [taskId]),
  )
  return Number(r.rows[0]?.n)
}
