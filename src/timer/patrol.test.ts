/**
 * 独立巡检集成测试（需要 Postgres）。
 *
 * 覆盖的是「supervisor 管不到」的那一半：编排进程已死、owner 心跳过期。
 * 关键断言：human / 无信号 run 不被误杀、双 worker 只收割一次、孤儿进程
 * 只在能校验启动时间时才 kill、杀不掉不静默成功。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { WorkflowDriver } from '../control/driver/driver.js'
import { LivenessStore } from '../control/liveness/store.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { asOwner, closePool } from '../fact/db.js'
import { inspectProcess, type PatrolDeps, type ProcessInfo, patrolStalledRuns } from './patrol.js'

const NOW = '2026-11-05T12:00:00Z'
const OLD = '2026-11-05T10:00:00Z'
const store = new LivenessStore()
const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))

async function seedRun(opts: {
  status?: string
  startedAt?: string
  silenceMs?: number | null
  lastProgressAt?: string | null
  ownerHeartbeatAt?: string
  pid?: number | null
  pgid?: number | null
  harnessStartedAt?: string | null
  /** claim 时写入的 harness 身份（R5）；缺省 NULL = 旧 run */
  harnessId?: string
  harnessTier?: string
}): Promise<{ taskId: string; runId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const runId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/patrol','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-DEVELOPING','t',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(
      `INSERT INTO run (
         id, task_id, stage, role, attempt, status, idempotency_key, started_at,
         harness_id, harness_tier
       ) VALUES ($1,$2,'develop','DEV',1,$3,$4,$5,$6,$7)`,
      [
        runId,
        taskId,
        opts.status ?? 'RUNNING',
        `${taskId}/develop/1`,
        opts.startedAt ?? OLD,
        opts.harnessId ?? null,
        opts.harnessTier ?? null,
      ],
    )
  })
  if (opts.status !== undefined && opts.status !== 'RUNNING') {
    return { taskId, runId }
  }
  await store.recordSilencePolicy(runId, opts.silenceMs ?? null)
  if (opts.lastProgressAt !== null && opts.lastProgressAt !== undefined) {
    store.recordProgress(runId, 'turn_start', 1, opts.lastProgressAt)
  }
  store.heartbeatOwner(runId, 999, opts.ownerHeartbeatAt ?? OLD)
  if (opts.pid !== undefined) {
    store.recordHarnessProcess(runId, opts.pid ?? 0, opts.pgid ?? 0, opts.harnessStartedAt ?? OLD)
  }
  await store.drain()
  return { taskId, runId }
}

function deps(over: Partial<PatrolDeps> = {}): PatrolDeps {
  return { driver, store, now: () => NOW, ...over }
}

async function runStatus(runId: string): Promise<{ status: string; error_kind: string | null }> {
  const r = await asOwner((c) =>
    c.query<{ status: string; error_kind: string | null }>(
      `SELECT status, error_kind FROM run WHERE id=$1`,
      [runId],
    ),
  )
  return r.rows[0] as { status: string; error_kind: string | null }
}

async function runIdentity(
  runId: string,
): Promise<{ harness_id: string | null; harness_tier: string | null }> {
  const r = await asOwner((c) =>
    c.query<{ harness_id: string | null; harness_tier: string | null }>(
      `SELECT harness_id, harness_tier FROM run WHERE id=$1`,
      [runId],
    ),
  )
  return r.rows[0] as { harness_id: string | null; harness_tier: string | null }
}

async function stalledEvents(runId: string) {
  const r = await asOwner((c) =>
    c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM event WHERE run_id=$1 AND type='RunStalled' ORDER BY seq`,
      [runId],
    ),
  )
  return r.rows.map((row) => row.payload)
}

afterAll(async () => {
  await store.close()
  await closePool()
})

describe('patrolStalledRuns', () => {
  it('owner 心跳新鲜时不介入（活进程由 supervisor 负责）', async () => {
    const { runId } = await seedRun({
      silenceMs: 1_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: '2026-11-05T11:59:50Z',
    })
    await patrolStalledRuns(deps())
    // 共享测试库里可能有别的用例留下的过期 run，只断言本 run 未被介入
    expect((await runStatus(runId)).status).toBe('RUNNING')
    expect(await stalledEvents(runId)).toHaveLength(0)
  })

  it('silence_ms 为 NULL（human / 无信号）不被按沉默收割', async () => {
    const { runId } = await seedRun({
      silenceMs: null,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
    })
    await patrolStalledRuns(deps())
    expect((await runStatus(runId)).status).toBe('RUNNING')
    expect(await stalledEvents(runId)).toHaveLength(0)
  })

  it('owner 过期 + 无进展 → TIMEOUT/RUN_STALLED，事件带证据', async () => {
    const { taskId, runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: '2026-11-05T10:30:00Z',
      ownerHeartbeatAt: OLD,
    })

    const stats = await patrolStalledRuns(deps())
    expect(stats.reaped).toBeGreaterThanOrEqual(1)
    expect(stats.errors).toBe(0)

    expect(await runStatus(runId)).toEqual({ status: 'TIMEOUT', error_kind: 'RUN_STALLED' })

    const events = await stalledEvents(runId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'patrol', last_kind: 'turn_start' })
    expect(events[0]?.silence_ms).toBeGreaterThan(60_000)
    expect(events[0]?.owner_heartbeat_at).toBe('2026-11-05T10:00:00.000Z')

    // T-030：同 stage 的新 run 已建
    const runs = await asOwner((c) =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM run WHERE task_id=$1`, [taskId]),
    )
    expect(Number(runs.rows[0]?.n)).toBe(2)
  })

  it('带身份的 run 被收割后身份保留（巡检不依赖 adapter、也不清空身份）', async () => {
    // 编排进程已死：这是一条 claim 时写过身份的 RUNNING run。
    // 巡检只从库里读，不可能再问 adapter —— 身份必须原样留在行上（R5）。
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: '2026-11-05T10:30:00Z',
      ownerHeartbeatAt: OLD,
      harnessId: 'omp',
      harnessTier: 'L1',
    })

    const stats = await patrolStalledRuns(deps())
    expect(stats.reaped).toBeGreaterThanOrEqual(1)

    expect(await runStatus(runId)).toEqual({ status: 'TIMEOUT', error_kind: 'RUN_STALLED' })
    expect(await runIdentity(runId)).toEqual({ harness_id: 'omp', harness_tier: 'L1' })
  })

  it('双 worker 并发巡检只产生一条 RunStalled', async () => {
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
    })
    const [a, b] = await Promise.all([patrolStalledRuns(deps()), patrolStalledRuns(deps())])
    expect(a.claimed + b.claimed).toBe(1)
    expect(a.reaped + b.reaped).toBe(1)
    expect(await stalledEvents(runId)).toHaveLength(1)
  })

  it('run 已终态：claim 后 update 为 0 行，不 advance', async () => {
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
    })
    await asOwner((c) =>
      c.query(`UPDATE run SET status='SUCCEEDED', ended_at=$2 WHERE id=$1`, [runId, NOW]),
    )
    await patrolStalledRuns(deps())
    // 候选查询只取 RUNNING，本 run 已终态不会被碰
    expect((await runStatus(runId)).status).toBe('SUCCEEDED')
    expect(await stalledEvents(runId)).toHaveLength(0)
  })

  it('孤儿进程启动时间匹配才 kill，且结果写进事件', async () => {
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
      pid: 4321,
      pgid: 4321,
      harnessStartedAt: '2026-11-05T09:00:00Z',
    })

    const signals: string[] = []
    let alive = true
    const inspect = (): ProcessInfo => ({
      alive,
      startedAt: new Date('2026-11-05T09:00:00Z'),
    })
    const stats = await patrolStalledRuns(
      deps({
        killGraceMs: 1,
        inspectProcess: inspect,
        killProcessGroup: (_pgid, signal) => {
          signals.push(signal)
          alive = false
        },
      }),
    )

    expect(signals).toEqual(['SIGTERM'])
    expect(stats.orphansKilled).toBeGreaterThanOrEqual(1)
    expect((await stalledEvents(runId))[0]?.orphan_killed).toBe(true)
  })

  it('PID 启动时间不匹配（PID 复用）不 kill', async () => {
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
      pid: 4321,
      pgid: 4321,
      harnessStartedAt: '2026-11-05T09:00:00Z',
    })

    const signals: string[] = []
    const stats = await patrolStalledRuns(
      deps({
        killGraceMs: 1,
        inspectProcess: () => ({ alive: true, startedAt: new Date('2026-11-05T09:10:00Z') }),
        killProcessGroup: (_pgid, signal) => signals.push(signal),
      }),
    )

    expect(signals).toEqual([])
    expect(stats.orphansKilled).toBe(0)
    expect(stats.orphanAlive).toBe(0)
    expect((await stalledEvents(runId))[0]?.orphan_killed).toBeNull()
  })

  it('杀不掉时记录 orphan_alive，不静默成功', async () => {
    const { runId } = await seedRun({
      silenceMs: 60_000,
      lastProgressAt: OLD,
      ownerHeartbeatAt: OLD,
      pid: 4321,
      pgid: 4321,
      harnessStartedAt: '2026-11-05T09:00:00Z',
    })

    const signals: string[] = []
    const stats = await patrolStalledRuns(
      deps({
        killGraceMs: 1,
        inspectProcess: () => ({ alive: true, startedAt: new Date('2026-11-05T09:00:00Z') }),
        killProcessGroup: (_pgid, signal) => signals.push(signal),
      }),
    )

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(stats.orphanAlive).toBeGreaterThanOrEqual(1)
    expect(stats.error).toContain('orphan_alive')
    expect((await stalledEvents(runId))[0]?.orphan_killed).toBe(false)

    const health = await asOwner((c) =>
      c.query<{ last_error: string | null }>(
        `SELECT last_error FROM worker_health WHERE name='patrol'`,
      ),
    )
    expect(health.rows[0]?.last_error).toContain('orphan_alive')
  })

  it('真实进程：pgid===pid 且启动时间匹配 → 默认 inspect/kill 生效', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid
    if (pid === undefined) throw new Error('spawn 没拿到 pid')
    child.unref()

    try {
      // 真实走 `ps -o lstart=` + `kill(pid, 0)`，不注入替身
      const info = inspectProcess(pid)
      expect(info.alive).toBe(true)
      expect(info.startedAt).not.toBeNull()
      if (info.startedAt === null) return

      const { runId } = await seedRun({
        silenceMs: 60_000,
        lastProgressAt: OLD,
        ownerHeartbeatAt: OLD,
        pid,
        pgid: pid,
        harnessStartedAt: info.startedAt.toISOString(),
      })

      const stats = await patrolStalledRuns(deps({ killGraceMs: 500 }))
      expect(stats.orphansKilled).toBeGreaterThanOrEqual(1)
      expect((await stalledEvents(runId))[0]?.orphan_killed).toBe(true)
      expect(inspectProcess(pid).alive).toBe(false)
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // 已经退出
      }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ])
      }
    }
  })
})
