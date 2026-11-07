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
import type { LivenessStore } from '../control/liveness/store.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asOwner, closePool } from '../fact/db.js'
import { EMPTY_PATROL_STATS } from '../timer/patrol.js'
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
    timer?: {
      kind: 'clarification_ttl' | 'human_review_ttl' | 'wall_clock'
      runId?: string
      due: string
    }
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

  it('W6.崩溃后 S-HUMAN_REVIEW + 到期人工裁决 TTL → drain → T-028 → S-ABANDONED + fired', async () => {
    const { taskId } = await seedWith('S-HUMAN_REVIEW', {
      run: { stage: 'pm', status: 'PENDING' },
      timer: { kind: 'human_review_ttl', due: '2026-08-26T11:00:00Z' },
    })

    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.humanReviewFired).toBe(1)
    expect(stats.clarificationFired).toBe(0)
    expect(await statusOf(taskId)).toBe('S-ABANDONED')

    const t = await asOwner((c) =>
      c.query<{ state: string; fired_at: string | null }>(
        `SELECT state, fired_at FROM timer WHERE task_id=$1`,
        [taskId],
      ),
    )
    expect(t.rows[0]?.state).toBe('fired')
    expect(t.rows[0]?.fired_at).not.toBeNull()
  })

  it('W7.到期行存在但 task 已不在 S-HUMAN_REVIEW → 不 claim、不推进', async () => {
    // 模拟「终态取消漏了」的残留：状态不匹配时 claim 的 JOIN 保证它永不醒来
    const { taskId } = await seedWith('S-PM_ANALYZING', {
      run: { stage: 'pm', status: 'PENDING' },
      timer: { kind: 'human_review_ttl', due: '2026-08-26T11:00:00Z' },
    })

    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.humanReviewFired).toBe(0)
    expect(await statusOf(taskId)).toBe('S-PM_ANALYZING')
  })

  it('W8.存量 S-HUMAN_REVIEW 无 timer → drain 补齐 → 到期 T-028 → S-ABANDONED + fired（#75）', async () => {
    const DAY_MS = 24 * 3600 * 1000
    // 升级前就停在 S-HUMAN_REVIEW：没有进门转移，永远不会有 human_review_ttl
    const { taskId } = await seedWith('S-HUMAN_REVIEW')

    const first = await drainAllDueTimers({ driver: driver(), now, humanReviewTtlMs: DAY_MS })
    expect(first.humanReviewArmed).toBe(1)

    const armed = await timerRows(taskId)
    expect(armed).toHaveLength(1)
    expect(armed[0]?.state).toBe('pending')
    expect(armed[0]?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)

    // 幂等：第二次 drain 不新增、不改期限
    const second = await drainAllDueTimers({ driver: driver(), now, humanReviewTtlMs: DAY_MS })
    expect(second.humanReviewArmed).toBe(0)
    const unchanged = await timerRows(taskId)
    expect(unchanged).toHaveLength(1)
    expect(unchanged[0]?.id).toBe(armed[0]?.id)
    expect(unchanged[0]?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)

    // 模拟升级后 TTL 到期：把期限推到过去，让 T-028 能收割
    await asOwner((c) =>
      c.query(
        `UPDATE timer SET due_at='2026-08-26T11:00:00Z'
         WHERE task_id=$1 AND kind='human_review_ttl'`,
        [taskId],
      ),
    )

    const third = await drainAllDueTimers({ driver: driver(), now, humanReviewTtlMs: DAY_MS })
    expect(third.humanReviewFired).toBe(1)
    expect(await statusOf(taskId)).toBe('S-ABANDONED')

    const fired = await timerRows(taskId)
    expect(fired).toHaveLength(1)
    expect(fired[0]?.state).toBe('fired')
    expect(fired[0]?.fired_at).not.toBeNull()
  })

  it('W9.不传 humanReviewTtlMs → 默认 24h（与 StartTimer 同源）', async () => {
    const DAY_MS = 24 * 3600 * 1000
    const { taskId } = await seedWith('S-HUMAN_REVIEW')

    // 不传 humanReviewTtlMs：WorkerDeps 的缺省必须与 TIMER_DURATIONS 一致
    const stats = await drainAllDueTimers({ driver: driver(), now })
    expect(stats.humanReviewArmed).toBe(1)

    const rows = await timerRows(taskId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.due_at.getTime()).toBe(Date.parse(NOW) + DAY_MS)
  })

  it('W5: progress 模式挂巡检；wallclock 模式整体退回旧路径', async () => {
    let patrolCalls = 0
    const deps = {
      driver: driver(),
      now,
      // 只作为「传了 store」的开关；本轮巡检被注入实现替换
      store: {} as unknown as LivenessStore,
      patrol: async () => {
        patrolCalls++
        return { ...EMPTY_PATROL_STATS, reaped: 2 }
      },
    }
    const previous = process.env.KEEL_LIVENESS_MODE
    try {
      process.env.KEEL_LIVENESS_MODE = 'progress'
      const stats = await drainAllDueTimers(deps)
      expect(patrolCalls).toBe(1)
      expect(stats.patrol.reaped).toBe(2)

      process.env.KEEL_LIVENESS_MODE = 'wallclock'
      await drainAllDueTimers(deps)
      expect(patrolCalls).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.KEEL_LIVENESS_MODE
      else process.env.KEEL_LIVENESS_MODE = previous
    }
  })
})

async function runCount(taskId: string): Promise<number> {
  const r = await asOwner((c) =>
    c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1`, [taskId]),
  )
  return Number(r.rows[0]?.n)
}

interface TimerRow {
  id: string
  state: string
  due_at: Date
  fired_at: Date | null
}

async function timerRows(taskId: string): Promise<TimerRow[]> {
  const r = await asOwner((c) =>
    c.query<TimerRow>(
      `SELECT id, state, due_at, fired_at FROM timer
       WHERE task_id=$1 AND kind='human_review_ttl'
       ORDER BY created_at`,
      [taskId],
    ),
  )
  return r.rows
}
