/**
 * ArtifactStore 的 Postgres 实现。
 *
 * 定义处：docs/05-contracts/artifact-store.md
 *
 * 两条纪律贯穿全文件：
 *
 * 1. **一切写入以 keel_control 身份进行**。这不是可选的谨慎 ——
 *    该角色对 artifact / event 只有 SELECT + INSERT，
 *    于是 I1 / I2（只增不改）由数据库而非本文件保证。
 *    即使这里写错了一条 UPDATE，也会被拒绝。
 *
 * 2. **可预期的失败返回 Result，意外的失败抛异常**。
 *    CONFLICT 与 NOT_FOUND 是业务流程的一部分；
 *    其余数据库错误是编程错误或基础设施故障，不该被包装成 Result 吞掉。
 */

import type { PoolClient } from 'pg'
import type {
  Artifact,
  ArtifactStore,
  CommitContext,
  PersistedArtifactKind,
} from '../contracts/artifact-store.js'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type { Proposal } from '../contracts/types.js'
import type { AEvent } from '../generated/artifacts.js'
import type { ArtifactRef } from '../shared/ids.js'
import { externalizeIfLarge, materialize } from './blob.js'
import { asRole } from './db.js'

/** Postgres 错误码 */
const PG_UNIQUE_VIOLATION = '23505'
const PG_SERIALIZATION_FAILURE = '40001'

function isPgError(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code
}

/** 只有 CONFLICT 是可预期的；其余一律抛出 */
function toConflictOrThrow<T>(e: unknown): Result<T> {
  if (isPgError(e, PG_UNIQUE_VIOLATION) || isPgError(e, PG_SERIALIZATION_FAILURE)) {
    const detail = e instanceof Error ? e.message : String(e)
    return err(makeError('CONFLICT', detail))
  }
  throw e
}

interface ArtifactRow {
  id: string
  task_id: string
  kind: PersistedArtifactKind
  key: string
  version: number
  schema_version: string
  body: unknown
  produced_by_run: string | null
  committed_at: Date
  committed_at_seq: string
  superseded_by: string | null
}

async function rowToArtifact(r: ArtifactRow): Promise<Artifact> {
  return {
    id: r.id,
    task_id: r.task_id,
    kind: r.kind,
    key: r.key,
    version: r.version,
    schema_version: r.schema_version,
    // body 可能是 blob 引用，取回真实内容（ADR-0004）
    body: await materialize(r.body),
    produced_by_run: r.produced_by_run,
    committed_at: r.committed_at.toISOString(),
    committed_at_seq: Number(r.committed_at_seq),
    superseded_by: r.superseded_by,
  }
}

const SELECT_COLS = `id, task_id, kind, key, version, schema_version, body,
                     produced_by_run, committed_at, committed_at_seq, superseded_by`

export class PgArtifactStore implements ArtifactStore {
  async commit(proposal: Proposal, ctx: CommitContext): Promise<Result<ArtifactRef>> {
    // 先写 blob，后写 artifact（ADR-0004）——
    // 反过来会产生悬空引用，而孤儿 blob 只是垃圾，可后台清理
    const body = await externalizeIfLarge(proposal.body)
    const schemaVersion = readSchemaVersion(proposal.body)

    try {
      return await asRole('keel_control', async (c) => {
        const version = await nextVersion(c, proposal)

        // I4：状态变更必然伴随事件，且同一事务。
        // 顺序不能反 —— artifact.committed_at_seq 需要这条事件的 seq
        const ev = await c.query<{ seq: string }>(
          `INSERT INTO event (task_id, run_id, type, payload)
           VALUES ($1, $2, 'ArtifactCommitted', $3::jsonb) RETURNING seq`,
          [
            taskIdOf(proposal),
            ctx.run_id,
            JSON.stringify({ kind: proposal.kind, key: proposal.key, version }),
          ],
        )
        const seq = Number(ev.rows[0]?.seq)

        // supersedes 的「必须是最新版」检查在函数内做，
        // 回填 superseded_by 也在函数内 —— 调用者没有 UPDATE 权限
        await c.query(`SELECT keel_commit_artifact($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`, [
          proposal.proposal_id,
          taskIdOf(proposal),
          proposal.kind,
          proposal.key,
          version,
          schemaVersion,
          JSON.stringify(body),
          ctx.run_id,
          seq,
          proposal.supersedes,
        ])
        return ok<ArtifactRef>(proposal.proposal_id)
      })
    } catch (e) {
      return toConflictOrThrow<ArtifactRef>(e)
    }
  }

  async get(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
    version: number,
  ): Promise<Result<Artifact>> {
    return this.one(
      `SELECT ${SELECT_COLS} FROM artifact
       WHERE task_id=$1 AND kind=$2 AND key=$3 AND version=$4`,
      [task_id, kind, key, version],
      `artifact ${kind}/${key}@${version}`,
    )
  }

  async latest(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
  ): Promise<Result<Artifact>> {
    return this.one(
      `SELECT ${SELECT_COLS} FROM artifact
       WHERE task_id=$1 AND kind=$2 AND key=$3 AND superseded_by IS NULL
       ORDER BY version DESC LIMIT 1`,
      [task_id, kind, key],
      `latest ${kind}/${key}`,
    )
  }

  async history(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
  ): Promise<Result<readonly Artifact[]>> {
    const rows = await asRole('keel_control', (c) =>
      c.query<ArtifactRow>(
        `SELECT ${SELECT_COLS} FROM artifact
         WHERE task_id=$1 AND kind=$2 AND key=$3 ORDER BY version ASC`,
        [task_id, kind, key],
      ),
    )
    return ok(await Promise.all(rows.rows.map(rowToArtifact)))
  }

  /**
   * 取某个事件序号时刻的版本。
   *
   * 用 committed_at_seq 而非 committed_at：event.seq 是全局单调的逻辑序，
   * committed_at 是墙上时钟，并发下两者不一致 —— 而重放依赖的是 seq。
   * 见 docs/03-domain-model.md §2.6。
   */
  async getAsOf(
    task_id: string,
    kind: PersistedArtifactKind,
    key: string,
    at_event_seq: number,
  ): Promise<Result<Artifact>> {
    return this.one(
      `SELECT ${SELECT_COLS} FROM artifact
       WHERE task_id=$1 AND kind=$2 AND key=$3 AND committed_at_seq <= $4
       ORDER BY version DESC LIMIT 1`,
      [task_id, kind, key, at_event_seq],
      `${kind}/${key} as of seq ${at_event_seq}`,
    )
  }

  async appendEvent(event: AEvent): Promise<Result<number>> {
    const r = await asRole('keel_control', (c) =>
      c.query<{ seq: string }>(
        `INSERT INTO event (task_id, run_id, type, payload, trace_id, span_id)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING seq`,
        [
          event.task_id,
          event.run_id ?? null,
          event.type,
          JSON.stringify(event.payload ?? {}),
          event.trace_id ?? null,
          event.span_id ?? null,
        ],
      ),
    )
    return ok(Number(r.rows[0]?.seq))
  }

  async readEvents(
    task_id: string,
    from_seq: number,
    limit: number,
  ): Promise<Result<readonly AEvent[]>> {
    const r = await asRole('keel_control', (c) =>
      c.query<{
        seq: string
        task_id: string
        run_id: string | null
        type: string
        payload: Record<string, unknown>
        trace_id: string | null
        span_id: string | null
        occurred_at: Date
      }>(
        `SELECT seq, task_id, run_id, type, payload, trace_id, span_id, occurred_at
         FROM event WHERE task_id=$1 AND seq >= $2 ORDER BY seq ASC LIMIT $3`,
        [task_id, from_seq, limit],
      ),
    )
    return ok(
      r.rows.map((row) => ({
        schema_version: '1.0' as const,
        seq: Number(row.seq),
        task_id: row.task_id,
        run_id: row.run_id,
        type: row.type as AEvent['type'],
        payload: row.payload,
        trace_id: row.trace_id,
        span_id: row.span_id,
        occurred_at: row.occurred_at.toISOString(),
      })),
    )
  }

  private async one(sql: string, params: unknown[], what: string): Promise<Result<Artifact>> {
    const r = await asRole('keel_control', (c) => c.query<ArtifactRow>(sql, params))
    const row = r.rows[0]
    if (row === undefined) return err(makeError('NOT_FOUND', `找不到 ${what}`))
    return ok(await rowToArtifact(row))
  }
}

// ─────────────────────────────── 辅助 ───────────────────────────────

/**
 * 下一个版本号 = 当前最大 + 1。
 *
 * 这里是乐观的：并发下两个调用可能算出同一个版本号，
 * 但 UNIQUE (task_id, kind, key, version) 会让后到者失败并转成 CONFLICT。
 * 不用 FOR UPDATE —— keel_control 没有 UPDATE 权限，行锁也拿不到。
 */
async function nextVersion(c: PoolClient, p: Proposal): Promise<number> {
  const r = await c.query<{ max: number | null }>(
    `SELECT max(version) AS max FROM artifact WHERE task_id=$1 AND kind=$2 AND key=$3`,
    [taskIdOf(p), p.kind, p.key],
  )
  return (r.rows[0]?.max ?? 0) + 1
}

/**
 * Proposal 自身不带 task_id —— 它在 produced_by_run 的上下文里。
 * v0.1 约定：proposal.body 中携带 task_id，或由调用方在 key 中体现。
 * 这里从 body 读，读不到则报错而不是猜。
 */
function taskIdOf(p: Proposal): string {
  const t = (p.body as { task_id?: unknown })?.task_id
  if (typeof t !== 'string') {
    throw new Error(`Proposal ${p.proposal_id} 的 body 缺少 task_id —— 无法确定归属`)
  }
  return t
}

function readSchemaVersion(body: unknown): string {
  const v = (body as { schema_version?: unknown })?.schema_version
  return typeof v === 'string' ? v : '1.0'
}
