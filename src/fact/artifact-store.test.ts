/**
 * ArtifactStore、blob 存储与 schema 漂移检查。
 *
 * 漂移检查沿用骨架任务 C1/C4 的手法：**让不一致成为 CI 失败**，
 * 而不是靠人记得两边一起改。
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERSISTED_ARTIFACT_KINDS } from '../contracts/artifact-store.js'
import type { Proposal } from '../contracts/types.js'
import { CONTROL_MODES, RUN_STATUSES, TASK_STATUSES } from '../shared/ids.js'
import { PgArtifactStore } from './artifact-store.js'
import { BLOB_THRESHOLD_BYTES, blobRoot, get, isBlobRef, put } from './blob.js'
import { asOwner, closePool } from './db.js'

const store = new PgArtifactStore()

interface Fixture {
  taskId: string
  runId: string
}

async function seed(): Promise<Fixture> {
  return asOwner(async (c) => {
    const repoId = randomUUID()
    const taskId = randomUUID()
    const runId = randomUUID()
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','t',$2,'main','ai/task-x')`,
      [taskId, repoId],
    )
    await c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'pm','PM',1,'RUNNING',$3)`,
      [runId, taskId, `k-${runId}`],
    )
    return { taskId, runId }
  })
}

function proposal(taskId: string, over: Partial<Proposal> = {}, body?: unknown): Proposal {
  return {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'state',
    key: '',
    body: body ?? { schema_version: '1.0', task_id: taskId, current_goal: 'g' },
    supersedes: null,
    produced_by_run: 'r',
    ...over,
  }
}

const ctx = (runId: string | null) =>
  ({
    run_id: runId,
    verdict: { accepted: true, artifact_ref: null, violations: [] },
    emit_event: true,
  }) as const

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  await rm(blobRoot(), { recursive: true, force: true })
  await closePool()
})

// ─────────────────────────────── blob ───────────────────────────────

describe('blob 存储', () => {
  it('内容寻址：同内容只存一份，读回一致', async () => {
    const bytes = Buffer.from('导出的 Excel 希望能够按照日期筛选', 'utf8')
    const h1 = await put(bytes)
    const h2 = await put(bytes)
    expect(h1).toBe(h2)
    expect((await get(h1)).toString('utf8')).toBe(bytes.toString('utf8'))
  })
})

// ────────────────────────── ArtifactStore ──────────────────────────

describe('ArtifactStore · 基本读写', () => {
  it('commit 后可 latest 取回，body 一致', async () => {
    const f = await seed()
    const p = proposal(f.taskId)
    const r = await store.commit(p, ctx(f.runId))
    expect(r.ok).toBe(true)

    const got = await store.latest(f.taskId, 'state', '')
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.version).toBe(1)
    expect((got.value.body as { current_goal: string }).current_goal).toBe('g')
    expect(got.value.superseded_by).toBeNull()
  })

  it('commit 同时写入一条 event（I4：状态变更必伴随事件）', async () => {
    const f = await seed()
    await store.commit(proposal(f.taskId), ctx(f.runId))
    const evs = await store.readEvents(f.taskId, 0, 100)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    expect(evs.value.map((e) => e.type)).toContain('ArtifactCommitted')
  })

  it('第二版取代第一版，history 保留完整链', async () => {
    const f = await seed()
    const v1 = proposal(f.taskId)
    await store.commit(v1, ctx(f.runId))

    const v2 = proposal(
      f.taskId,
      { supersedes: v1.proposal_id },
      {
        schema_version: '1.0',
        task_id: f.taskId,
        current_goal: 'g2',
      },
    )
    const r2 = await store.commit(v2, ctx(f.runId))
    expect(r2.ok).toBe(true)

    const hist = await store.history(f.taskId, 'state', '')
    expect(hist.ok).toBe(true)
    if (!hist.ok) return
    expect(hist.value).toHaveLength(2)
    expect(hist.value[0]?.superseded_by).toBe(v2.proposal_id)
    expect(hist.value[1]?.superseded_by).toBeNull()
  })

  it('get 不存在的版本返回 NOT_FOUND 而非抛异常', async () => {
    const f = await seed()
    const r = await store.get(f.taskId, 'state', '', 99)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
    expect(r.error.retryable).toBe(false)
  })
})

describe('ArtifactStore · CONFLICT', () => {
  it('supersedes 指向非最新版时返回 CONFLICT', async () => {
    const f = await seed()
    const v1 = proposal(f.taskId)
    await store.commit(v1, ctx(f.runId))
    const v2 = proposal(f.taskId, { supersedes: v1.proposal_id })
    await store.commit(v2, ctx(f.runId))

    // 拿着已被取代的 v1 再提交一次
    const v3 = proposal(f.taskId, { supersedes: v1.proposal_id })
    const r = await store.commit(v3, ctx(f.runId))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CONFLICT')
    expect(r.error.retryable).toBe(true)
  })

  it('CONFLICT 时 artifact 与 event 都不落盘（事务原子性）', async () => {
    const f = await seed()
    const v1 = proposal(f.taskId)
    await store.commit(v1, ctx(f.runId))
    const v2 = proposal(f.taskId, { supersedes: v1.proposal_id })
    await store.commit(v2, ctx(f.runId))

    const before = await asOwner((c) =>
      c.query<{ a: string; e: string }>(
        `SELECT (SELECT count(*) FROM artifact) AS a, (SELECT count(*) FROM event) AS e`,
      ),
    )

    await store.commit(proposal(f.taskId, { supersedes: v1.proposal_id }), ctx(f.runId))

    const after = await asOwner((c) =>
      c.query<{ a: string; e: string }>(
        `SELECT (SELECT count(*) FROM artifact) AS a, (SELECT count(*) FROM event) AS e`,
      ),
    )
    // 失败的提交没有留下任何痕迹 —— 尤其是那条已经 INSERT 过的 event
    expect(after.rows[0]?.a).toBe(before.rows[0]?.a)
    expect(after.rows[0]?.e).toBe(before.rows[0]?.e)
  })
})

describe('ArtifactStore · getAsOf', () => {
  it('返回该事件序号时刻的版本，而不是最新版', async () => {
    const f = await seed()
    const v1 = proposal(
      f.taskId,
      {},
      { schema_version: '1.0', task_id: f.taskId, current_goal: 'v1' },
    )
    await store.commit(v1, ctx(f.runId))
    const atV1 = (await store.latest(f.taskId, 'state', '')) as {
      ok: true
      value: { committed_at_seq: number }
    }
    const seqAtV1 = atV1.value.committed_at_seq

    const v2 = proposal(
      f.taskId,
      { supersedes: v1.proposal_id },
      {
        schema_version: '1.0',
        task_id: f.taskId,
        current_goal: 'v2',
      },
    )
    await store.commit(v2, ctx(f.runId))

    const latest = await store.latest(f.taskId, 'state', '')
    expect(latest.ok && (latest.value.body as { current_goal: string }).current_goal).toBe('v2')

    const asOf = await store.getAsOf(f.taskId, 'state', '', seqAtV1)
    expect(asOf.ok).toBe(true)
    if (!asOf.ok) return
    // 这正是 Developer 与 Reviewer 必须看到同一版 RFC 的机制
    expect((asOf.value.body as { current_goal: string }).current_goal).toBe('v1')
  })
})

describe('ArtifactStore · blob 阈值切分', () => {
  it('超过 256KB 的 body 落 blob，artifact 中只留引用，读回仍是原内容', async () => {
    const f = await seed()
    const big = 'x'.repeat(BLOB_THRESHOLD_BYTES + 1024)
    const p = proposal(f.taskId, {}, { schema_version: '1.0', task_id: f.taskId, blob: big })
    const r = await store.commit(p, ctx(f.runId))
    expect(r.ok).toBe(true)

    // 库里存的是引用
    const raw = await asOwner((c) =>
      c.query<{ body: unknown }>('SELECT body FROM artifact WHERE id=$1', [p.proposal_id]),
    )
    expect(isBlobRef(raw.rows[0]?.body)).toBe(true)

    // 但读回来是原内容
    const got = await store.latest(f.taskId, 'state', '')
    expect(got.ok && (got.value.body as { blob: string }).blob).toBe(big)
  })
})

// ─────────────────────── schema 漂移检查 ───────────────────────

describe('schema 与代码的一致性', () => {
  /** 从 CHECK 约束定义里抽出单引号包裹的取值 */
  async function checkValues(table: string, column: string): Promise<string[]> {
    const r = await asOwner((c) =>
      c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
         WHERE rel.relname = $1 AND att.attname = $2 AND con.contype = 'c'`,
        [table, column],
      ),
    )
    const def = r.rows[0]?.def
    expect(def, `${table}.${column} 没有 CHECK 约束 —— 拒绝以「一致」通过`).toBeDefined()
    return [...(def ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort()
  }

  it('task.status 的 CHECK 取值与 src/shared/ids.ts 的 15 个状态一致', async () => {
    const dbValues = await checkValues('task', 'status')
    expect(dbValues).toEqual([...TASK_STATUSES].sort())
    expect(dbValues).toHaveLength(15)
  })

  it('artifact.kind 的 CHECK 取值与 PERSISTED_ARTIFACT_KINDS 一致', async () => {
    const dbValues = await checkValues('artifact', 'kind')
    expect(dbValues).toEqual([...PERSISTED_ARTIFACT_KINDS].sort())
  })

  it('task.control_mode 的 CHECK 取值与 CONTROL_MODES 一致(#1-14)', async () => {
    const dbValues = await checkValues('task', 'control_mode')
    expect(dbValues).toEqual([...CONTROL_MODES].sort())
    expect(dbValues).toHaveLength(3)
  })

  it('run.status 的 CHECK 取值与 RUN_STATUSES 一致(#1-14)', async () => {
    const dbValues = await checkValues('run', 'status')
    expect(dbValues).toEqual([...RUN_STATUSES].sort())
    expect(dbValues).toHaveLength(6)
  })

  it('七张业务表都存在 —— 防假绿：读到 0 张表即失败', async () => {
    const r = await asOwner((c) =>
      c.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'pgmigrations'`,
      ),
    )
    const tables = r.rows.map((x) => x.tablename).sort()
    expect(tables.length).toBeGreaterThan(0)
    expect(tables).toEqual(
      ['artifact', 'event', 'feedback', 'repo', 'run', 'task', 'task_feedback'].sort(),
    )
  })
})
