/**
 * LivenessStore 集成测试（需要 Postgres）。
 *
 * 验证的是设计里最容易写错的三件事：
 * - 节流窗口内不递增 progress_seq；
 * - 巡检 claim 幂等；
 * - owner 心跳过期才成为候选，且 keel_execution 不能写。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import { LivenessStore } from './store.js'

const NOW = '2026-11-05T00:00:00Z'
const store = new LivenessStore()

async function seedRun(status = 'RUNNING'): Promise<{ taskId: string; runId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const runId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/liveness','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-DEVELOPING','t',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'develop','DEV',1,$3,$4)`,
      [runId, taskId, status, `${taskId}/develop/1`],
    )
  })
  return { taskId, runId }
}

async function readLiveness(runId: string) {
  const r = await asOwner((c) =>
    c.query<{
      progress_seq: string
      last_kind: string | null
      last_progress_at: string | null
      owner_heartbeat_at: string | null
      stall_reported_at: string | null
    }>(
      `SELECT progress_seq, last_kind, last_progress_at, owner_heartbeat_at, stall_reported_at
       FROM run_liveness WHERE run_id=$1`,
      [runId],
    ),
  )
  return r.rows[0]
}

afterAll(async () => {
  await store.close()
  await closePool()
})

describe('LivenessStore', () => {
  it('进展节流：10s 窗口内不递增，窗口外正常递增', async () => {
    const { runId } = await seedRun()

    store.recordProgress(runId, 'turn_start', 1_000, '2026-11-05T00:00:01Z')
    store.recordProgress(runId, 'message_update', 5_000, '2026-11-05T00:00:05Z')
    await store.drain()

    expect(await readLiveness(runId)).toMatchObject({
      progress_seq: '1',
      last_kind: 'turn_start',
    })

    store.recordProgress(runId, 'tool_execution_start', 12_000, '2026-11-05T00:00:12Z')
    await store.drain()

    const row = await readLiveness(runId)
    expect(row?.progress_seq).toBe('2')
    expect(row?.last_kind).toBe('tool_execution_start')
    expect(new Date(row?.last_progress_at ?? '').toISOString()).toBe('2026-11-05T00:00:12.000Z')
  })

  it('记录沉默阈值：巡检据此判定，human / 无信号 run 为 NULL', async () => {
    const active = await seedRun()
    const human = await seedRun()

    store.recordSilencePolicy(active.runId, 300_000)
    store.recordSilencePolicy(human.runId, null)
    store.heartbeatOwner(active.runId, 1, '2026-11-04T23:00:00Z')
    store.heartbeatOwner(human.runId, 1, '2026-11-04T23:00:00Z')
    await store.drain()

    const rows = await asOwner((c) =>
      c.query<{ run_id: string; silence_ms: number | null }>(
        `SELECT run_id, silence_ms FROM run_liveness WHERE run_id = ANY($1::uuid[])`,
        [[active.runId, human.runId]],
      ),
    )
    const byId = new Map(rows.rows.map((r) => [r.run_id, r.silence_ms]))
    expect(byId.get(active.runId)).toBe(300_000)
    expect(byId.get(human.runId)).toBeNull()

    const candidates = await store.readStaleCandidates('2026-11-04T23:30:00Z', 10)
    const candidate = candidates.find((c) => c.run_id === active.runId)
    expect(candidate?.silence_ms).toBe(300_000)
    expect(candidate?.started_at).toBeNull()
  })

  it('markStallReported 幂等：第二次返回 false，时间戳不被覆盖', async () => {
    const { runId } = await seedRun()
    store.recordProgress(runId, 'turn_start', 1_000, NOW)
    await store.drain()

    expect(await store.markStallReported(runId, '2026-11-05T00:10:00Z')).toBe(true)
    expect(await store.markStallReported(runId, '2026-11-05T00:20:00Z')).toBe(false)

    const row = await readLiveness(runId)
    expect(new Date(row?.stall_reported_at ?? '').toISOString()).toBe('2026-11-05T00:10:00.000Z')
  })

  it('只返回 owner 心跳过期、未 claim 的 RUNNING run', async () => {
    const stale = await seedRun()
    const fresh = await seedRun()
    const done = await seedRun('SUCCEEDED')

    for (const id of [stale.runId, fresh.runId, done.runId]) {
      store.recordProgress(id, 'turn_start', 1_000, NOW)
      store.heartbeatOwner(id, 1234, NOW)
    }
    await store.drain()

    // stale 的心跳到 1 小时前；fresh 保持 NOW
    await asOwner((c) =>
      c.query(`UPDATE run_liveness SET owner_heartbeat_at=$2 WHERE run_id=$1`, [
        stale.runId,
        '2026-11-04T23:00:00Z',
      ]),
    )

    const candidates = await store.readStaleCandidates('2026-11-04T23:30:00Z', 10)
    const ids = candidates.map((c) => c.run_id)
    expect(ids).toContain(stale.runId)
    expect(ids).not.toContain(fresh.runId)
    expect(ids).not.toContain(done.runId)
  })

  it('没有 liveness 行的旧 run 不会被巡检凭空判死', async () => {
    const old = await seedRun()
    const candidates = await store.readStaleCandidates('2026-11-05T00:30:00Z', 10)
    expect(candidates.map((c) => c.run_id)).not.toContain(old.runId)
  })

  it('keel_execution 不能写 run_liveness', async () => {
    const { runId } = await seedRun()
    await expect(
      asRole('keel_execution', (c) =>
        c.query(`INSERT INTO run_liveness (run_id) VALUES ($1)`, [runId]),
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('pruneTerminal 只删终态且超过保留期的行', async () => {
    const oldTerminal = await seedRun('SUCCEEDED')
    const recentTerminal = await seedRun('FAILED')
    const running = await seedRun('RUNNING')

    for (const id of [oldTerminal.runId, recentTerminal.runId, running.runId]) {
      store.recordProgress(id, 'turn_start', 1_000, NOW)
    }
    await store.drain()

    await asOwner((c) =>
      c.query(`UPDATE run_liveness SET updated_at='2026-10-01T00:00:00Z' WHERE run_id=$1`, [
        oldTerminal.runId,
      ]),
    )

    const deleted = await store.pruneTerminal('2026-11-05T00:00:00Z', 7)
    expect(deleted).toBe(1)

    expect(await readLiveness(oldTerminal.runId)).toBeUndefined()
    expect(await readLiveness(recentTerminal.runId)).toBeDefined()
    expect(await readLiveness(running.runId)).toBeDefined()
  })

  it('recordWorkerHealth 更新健康行与错误', async () => {
    await store.recordWorkerHealth('patrol', NOW, null)
    await store.recordWorkerHealth('patrol', '2026-11-05T00:01:00Z', 'boom')

    const r = await asOwner((c) =>
      c.query<{ last_seen_at: string; last_error: string | null }>(
        `SELECT last_seen_at, last_error FROM worker_health WHERE name='patrol'`,
      ),
    )
    expect(new Date(r.rows[0]?.last_seen_at ?? '').toISOString()).toBe('2026-11-05T00:01:00.000Z')
    expect(r.rows[0]?.last_error).toBe('boom')
  })
})
