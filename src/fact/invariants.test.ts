/**
 * 不变量的反例验证。
 *
 * docs/03-domain-model.md §3 定义了 8 条不变量，并明确指出
 * I5 必须靠数据库授权强制，而不是靠约定：
 *
 *   「只写在文档里的边界，迟早会被一次『临时先这样』绕过 ——
 *     而这条一旦被绕过，"State 是事实"整个原则就塌了。」
 *
 * 本文件的每个测试都是一次**主动违规尝试**，期望被数据库拒绝。
 *
 * 沿用骨架任务的教训（.trellis/spec/backend/error-handling.md）：
 *   **未经反例验证的约束，等同于没有约束。**
 *   一条写错的 GRANT 和一条正确的 GRANT，日常表现完全一样。
 *
 * 规则：测试不通过时**改授权，不改测试**。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from './db.js'

// ─────────────────────────────── 测试装置 ───────────────────────────────

interface Fixture {
  repoId: string
  taskId: string
  feedbackId: string
  eventSeq: number
}

/** 以属主身份铺一份最小数据 —— 装置本身不受授权约束 */
async function seed(): Promise<Fixture> {
  return asOwner(async (c) => {
    const repoId = randomUUID()
    const taskId = randomUUID()
    const feedbackId = randomUUID()

    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1, 'local', 'file:///tmp/x', 'main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body)
       VALUES ($1, 'manual', $2, '导出的 Excel 希望能够按照日期筛选')`,
      [feedbackId, `ref-${feedbackId}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1, 'S-NEW', 'Excel 日期筛选', $2, 'main', $3)`,
      [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
    )
    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, type) VALUES ($1, 'TaskCreated') RETURNING seq`,
      [taskId],
    )
    return { repoId, taskId, feedbackId, eventSeq: Number(ev.rows[0]?.seq) }
  })
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

/** 断言某操作被数据库拒绝，并返回错误信息供进一步断言 */
async function expectRejected(fn: () => Promise<unknown>): Promise<string> {
  let message: string | undefined
  try {
    await fn()
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message, '期望被数据库拒绝，但操作成功了').toBeDefined()
  return message ?? ''
}

// ───────────────────────── I5 · Execution 不得写 Fact ─────────────────────────
// 这是中心不变量的落点，也是本任务最重要的一组测试

describe('I5 · Execution Plane 不得触碰 Fact Plane', () => {
  it('keel_execution 不能 INSERT artifact', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_execution', (c) =>
        c.query(
          `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
           VALUES ($1, $2, 'state', '', 1, '1.0', '{}'::jsonb, $3)`,
          [randomUUID(), f.taskId, f.eventSeq],
        ),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_execution 不能 INSERT event', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_execution', (c) =>
        c.query(`INSERT INTO event (task_id, type) VALUES ($1, 'Forged')`, [f.taskId]),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_execution 不能 SELECT task —— 它看到的一切都应经由 Context Builder', async () => {
    await seed()
    const msg = await expectRejected(() =>
      asRole('keel_execution', (c) => c.query('SELECT * FROM task')),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_execution 不能 SELECT feedback（不可信输入不应被直接翻库）', async () => {
    await seed()
    const msg = await expectRejected(() =>
      asRole('keel_execution', (c) => c.query('SELECT * FROM feedback')),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_execution 可以 SELECT 自己的 run（矩阵中唯一的执行侧读权限）', async () => {
    await seed()
    const rows = await asRole('keel_execution', (c) => c.query('SELECT * FROM run'))
    expect(rows.rowCount).toBe(0) // 有权限，只是没数据
  })
})

// ───────────────────────── I1 / I2 · 只增不改 ─────────────────────────

describe('I1 · event 只增不改', () => {
  it('keel_control 不能 UPDATE event', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) =>
        c.query(`UPDATE event SET type = 'Tampered' WHERE task_id = $1`, [f.taskId]),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_control 不能 DELETE event', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) => c.query('DELETE FROM event WHERE task_id = $1', [f.taskId])),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_control 可以 INSERT event（这是它该有的权限）', async () => {
    const f = await seed()
    const r = await asRole('keel_control', (c) =>
      c.query(`INSERT INTO event (task_id, type) VALUES ($1, 'TaskStatusChanged') RETURNING seq`, [
        f.taskId,
      ]),
    )
    expect(r.rowCount).toBe(1)
  })
})

describe('I2 · artifact 只增不改', () => {
  async function seedArtifact(): Promise<{ id: string; taskId: string }> {
    const f = await seed()
    const id = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
         VALUES ($1, $2, 'state', '', 1, '1.0', '{"current_goal":"x"}'::jsonb, $3)`,
        [id, f.taskId, f.eventSeq],
      ),
    )
    return { id, taskId: f.taskId }
  }

  it('keel_control 不能 UPDATE artifact', async () => {
    const a = await seedArtifact()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) =>
        c.query(`UPDATE artifact SET body = '{}'::jsonb WHERE id = $1`, [a.id]),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_control 不能 DELETE artifact', async () => {
    const a = await seedArtifact()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) => c.query('DELETE FROM artifact WHERE id = $1', [a.id])),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('同一 (task_id, kind, key, version) 不能重复', async () => {
    const a = await seedArtifact()
    const f2 = await asOwner((c) =>
      c.query<{ seq: string }>(`INSERT INTO event (task_id, type) VALUES ($1, 'X') RETURNING seq`, [
        a.taskId,
      ]),
    )
    const msg = await expectRejected(() =>
      asOwner((c) =>
        c.query(
          `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
           VALUES ($1, $2, 'state', '', 1, '1.0', '{}'::jsonb, $3)`,
          [randomUUID(), a.taskId, Number(f2.rows[0]?.seq)],
        ),
      ),
    )
    expect(msg).toMatch(/duplicate key|unique/i)
  })
})

// ───────────────────────── I6 · feedback 永不修改 ─────────────────────────

describe('I6 · feedback 不可变', () => {
  it('keel_control 不能 UPDATE feedback', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) =>
        c.query(`UPDATE feedback SET body = 'rewritten' WHERE id = $1`, [f.feedbackId]),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('keel_control 不能 DELETE feedback', async () => {
    const f = await seed()
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) => c.query('DELETE FROM feedback WHERE id = $1', [f.feedbackId])),
    )
    expect(msg).toMatch(/permission denied/i)
  })
})

// ───────────────────────── I3 · 幂等键 ─────────────────────────

describe('I3 · idempotency_key 唯一', () => {
  it('相同 idempotency_key 的第二次插入被拒绝', async () => {
    const f = await seed()
    const key = 'task-x/develop/1'
    await asOwner((c) =>
      c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
         VALUES ($1, $2, 'develop', 'Developer', 1, 'PENDING', $3)`,
        [randomUUID(), f.taskId, key],
      ),
    )
    const msg = await expectRejected(() =>
      asOwner((c) =>
        c.query(
          `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
           VALUES ($1, $2, 'develop', 'Developer', 2, 'PENDING', $3)`,
          [randomUUID(), f.taskId, key],
        ),
      ),
    )
    expect(msg).toMatch(/duplicate key|unique/i)
  })

  it('同一 (task_id, stage, attempt) 不能重复', async () => {
    const f = await seed()
    await asOwner((c) =>
      c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
         VALUES ($1, $2, 'qa', 'QA', 1, 'PENDING', 'k1')`,
        [randomUUID(), f.taskId],
      ),
    )
    const msg = await expectRejected(() =>
      asOwner((c) =>
        c.query(
          `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
           VALUES ($1, $2, 'qa', 'QA', 1, 'PENDING', 'k2')`,
          [randomUUID(), f.taskId],
        ),
      ),
    )
    expect(msg).toMatch(/duplicate key|unique/i)
  })
})

// ───────────────────────── I8 · 终态不可变 ─────────────────────────

describe('I8 · 终态 Task 不再变更', () => {
  it('已终结的 task 无法被 UPDATE', async () => {
    const f = await seed()
    await asOwner((c) =>
      c.query(`UPDATE task SET status = 'S-DONE', terminal_at = now() WHERE id = $1`, [f.taskId]),
    )
    const msg = await expectRejected(() =>
      asOwner((c) => c.query(`UPDATE task SET title = 'changed' WHERE id = $1`, [f.taskId])),
    )
    expect(msg).toMatch(/I8 violated/)
  })

  it('未终结的 task 可以正常 UPDATE', async () => {
    const f = await seed()
    const r = await asRole('keel_control', (c) =>
      c.query(`UPDATE task SET status = 'S-PM_ANALYZING' WHERE id = $1`, [f.taskId]),
    )
    expect(r.rowCount).toBe(1)
  })
})

// ───────────────── superseded_by 只能经 SECURITY DEFINER 函数写 ─────────────────

describe('superseded_by 的唯一写入路径', () => {
  it('keel_control 无法直接 UPDATE superseded_by（它没有 UPDATE 权限）', async () => {
    const f = await seed()
    const id = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
         VALUES ($1, $2, 'state', '', 1, '1.0', '{}'::jsonb, $3)`,
        [id, f.taskId, f.eventSeq],
      ),
    )
    const msg = await expectRejected(() =>
      asRole('keel_control', (c) =>
        c.query('UPDATE artifact SET superseded_by = $1 WHERE id = $1', [id]),
      ),
    )
    expect(msg).toMatch(/permission denied/i)
  })

  it('经 keel_commit_artifact 可以提交新版并回填旧版', async () => {
    const f = await seed()
    const v1 = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
         VALUES ($1, $2, 'state', '', 1, '1.0', '{"v":1}'::jsonb, $3)`,
        [v1, f.taskId, f.eventSeq],
      ),
    )

    const v2 = randomUUID()
    await asRole('keel_control', async (c) => {
      const ev = await c.query<{ seq: string }>(
        `INSERT INTO event (task_id, type) VALUES ($1, 'ArtifactCommitted') RETURNING seq`,
        [f.taskId],
      )
      await c.query(
        `SELECT keel_commit_artifact($1, $2, 'state', '', 2, '1.0', '{"v":2}'::jsonb, NULL, $3, $4)`,
        [v2, f.taskId, Number(ev.rows[0]?.seq), v1],
      )
    })

    const rows = await asOwner((c) =>
      c.query<{ id: string; superseded_by: string | null; version: number }>(
        'SELECT id, superseded_by, version FROM artifact WHERE task_id = $1 ORDER BY version',
        [f.taskId],
      ),
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]?.superseded_by).toBe(v2) // 旧版被回填
    expect(rows.rows[1]?.superseded_by).toBeNull() // 新版是当前版
  })

  it('supersedes 指向非最新版时返回 CONFLICT', async () => {
    const f = await seed()
    const v1 = randomUUID()
    const v2 = randomUUID()
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
         VALUES ($1, $2, 'state', '', 1, '1.0', '{}'::jsonb, $3)`,
        [v1, f.taskId, f.eventSeq],
      )
      await c.query(
        `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq, superseded_by)
         VALUES ($1, $2, 'state', '', 2, '1.0', '{}'::jsonb, $3, NULL)`,
        [v2, f.taskId, f.eventSeq],
      )
      await c.query('UPDATE artifact SET superseded_by = $1 WHERE id = $2', [v2, v1])
    })

    // 拿着已被取代的 v1 去提交，应被拒
    const msg = await expectRejected(() =>
      asRole('keel_control', async (c) => {
        const ev = await c.query<{ seq: string }>(
          `INSERT INTO event (task_id, type) VALUES ($1, 'X') RETURNING seq`,
          [f.taskId],
        )
        await c.query(
          `SELECT keel_commit_artifact($1, $2, 'state', '', 3, '1.0', '{}'::jsonb, NULL, $3, $4)`,
          [randomUUID(), f.taskId, Number(ev.rows[0]?.seq), v1],
        )
      }),
    )
    expect(msg).toMatch(/CONFLICT/)
  })
})
