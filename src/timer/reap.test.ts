/**
 * 墙钟超时收割（timer worker 路径）—— R5 的「外部收割」验收。
 *
 * 与 loop 内的 watchdog 不同：收割发生在**编排进程之外**，拿不到 adapter。
 * claim（PENDING→RUNNING）时写入的 harness 身份是这条路径唯一能得知
 * 「谁跑的」的来源，收割不得丢失它。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { claimRunForExecution, DEFAULT_MAX_RUNNING_RUNS } from '../control/concurrency/limits.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { reapTimeoutRun } from './reap.js'

const NOW = '2026-11-05T12:00:00Z'
const STARTED = '2026-11-05T10:00:00Z'
const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo, timer RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

/** 编排进程已死:经真实 claim（PENDING→RUNNING）写入身份后被丢下的一条 RUNNING run */
async function seedRunningRun(): Promise<{ taskId: string; runId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const runId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/reap','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-DEVELOPING','t',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(
      `INSERT INTO run (
         id, task_id, stage, role, attempt, status, idempotency_key, started_at
       ) VALUES ($1,$2,'develop','DEV',1,'PENDING',$3,$4)`,
      [runId, taskId, `${taskId}/develop/1`, STARTED],
    )
  })
  // 身份只能由 claim 写入 —— 这里不直接 seed 身份列，避免用「seed 出来的身份」
  // 证明「claim 之后收割仍可读」而漏掉真实认领链路。
  const claimed = await asRole('keel_control', (c) =>
    claimRunForExecution(c, runId, DEFAULT_MAX_RUNNING_RUNS, {
      harnessId: 'omp',
      harnessTier: 'L1',
    }),
  )
  if (!claimed.ok) throw new Error(`seed claim 失败：${claimed.error.detail}`)
  return { taskId, runId }
}

async function runRow(runId: string): Promise<{
  status: string
  error_kind: string | null
  harness_id: string | null
  harness_tier: string | null
}> {
  const r = await asOwner((c) =>
    c.query<{
      status: string
      error_kind: string | null
      harness_id: string | null
      harness_tier: string | null
    }>(`SELECT status, error_kind, harness_id, harness_tier FROM run WHERE id=$1`, [runId]),
  )
  return r.rows[0] as {
    status: string
    error_kind: string | null
    harness_id: string | null
    harness_tier: string | null
  }
}

describe('reapTimeoutRun · 墙钟收割', () => {
  it('RUNNING run 被收割 → TIMEOUT/RUN_TIMEOUT,harness 身份保留并推进 T-030', async () => {
    const { taskId, runId } = await seedRunningRun()

    const r = await reapTimeoutRun(taskId, 'develop', runId, driver, NOW)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value).toBe('timeout')

    // 身份来自 claim 时写入的那一列 —— 收割进程没有 adapter 可问
    expect(await runRow(runId)).toMatchObject({
      status: 'TIMEOUT',
      error_kind: 'RUN_TIMEOUT',
      harness_id: 'omp',
      harness_tier: 'L1',
    })

    // T-030：同 stage 的新 run 已建（收割确实推进了转移，不只是标状态）
    const runs = await asOwner((c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1`, [taskId]),
    )
    expect(Number(runs.rows[0]?.n)).toBe(2)
  })
})
