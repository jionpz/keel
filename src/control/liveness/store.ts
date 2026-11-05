/**
 * 运行 liveness 存储 —— 属 Control Plane。
 *
 * 设计约束（`.trellis/tasks/11-04-run-liveness-patrol/design.md` §4.3）：
 * - 这是**遥测**，不是 Fact：写失败只记日志，绝不让 Run 失败；
 * - 使用独立小 pool + 有界队列 + 合并写，不跟编排事务抢连接；
 * - 进展心跳最多 10s 一次；owner 心跳由 supervisor 按 15s 节奏调用；
 * - 所有写入走 `keel_control`；Execution 角色没有授权。
 */

import { Pool as PgPool, type Pool, type PoolClient } from 'pg'
import { connectionString } from '../../fact/db.js'

/** 进展心跳节流窗口；与控制面「多久算沉默」无关 */
const PROGRESS_THROTTLE_MS = 10_000
/** 有界队列上限：超过时丢最旧的一项（遥测可丢，Run 不可阻塞） */
const MAX_QUEUE = 1_000

interface PendingWrite {
  progress?: { at: string; kind: string }
  harness?: { pid: number; pgid: number; startedAt: string }
  owner?: { pid: number; at: string }
  /** null = 明确「本 run 不做沉默判定」，与「还没写入」在行内不可区分（保守方向：不误杀） */
  silence?: { ms: number | null }
}

export interface LivenessCandidate {
  readonly run_id: string
  readonly task_id: string
  readonly stage: string
  readonly last_progress_at: string | null
  readonly last_kind: string | null
  readonly owner_heartbeat_at: string | null
  readonly harness_pid: number | null
  readonly harness_pgid: number | null
  readonly harness_started_at: string | null
  /** run 创建时确定的沉默阈值；NULL = 巡检不得按沉默收割 */
  readonly silence_ms: number | null
  /** 没有进展观测时的回退基准 */
  readonly started_at: string | null
}

export interface LivenessStoreOptions {
  /** 测试可注入；默认与主 pool 同源 */
  readonly connectionString?: string
  /** 测试可注入；传了就由调用方负责关闭 */
  readonly pool?: Pool
  /** 写失败的结构化出口；默认 console.warn */
  readonly onError?: (error: unknown) => void
}

export class LivenessStore {
  private readonly pool: Pool
  private readonly ownsPool: boolean
  private readonly onError: (error: unknown) => void

  private readonly queue = new Map<string, PendingWrite>()
  private readonly lastProgressAt = new Map<string, number>()
  private flushPromise: Promise<void> | null = null
  private closed = false

  constructor(opts: LivenessStoreOptions = {}) {
    this.ownsPool = opts.pool === undefined
    this.pool =
      opts.pool ??
      new PgPool({
        connectionString: opts.connectionString ?? connectionString(),
        max: 2,
      })
    this.onError =
      opts.onError ??
      ((error) => {
        console.warn('[liveness] 遥测写入失败（不影响 Run）', error)
      })
  }

  /**
   * 记录一次进展。同步入队，不阻塞 stdout 消费。
   * @param at 事件的单调时钟读数
   * @param now 持久化时间戳（注入的墙钟）
   */
  recordProgress(runId: string, kind: string, at: number, now: string): void {
    const previous = this.lastProgressAt.get(runId)
    if (previous !== undefined && at - previous < PROGRESS_THROTTLE_MS) return
    this.lastProgressAt.set(runId, at)
    this.enqueue(runId, { progress: { at: now, kind } })
  }

  /** 首次进展事件携带的孤儿清理线索；只写一次，后续被 COALESCE 保留 */
  recordHarnessProcess(runId: string, pid: number, pgid: number, startedAt: string): void {
    this.enqueue(runId, { harness: { pid, pgid, startedAt } })
  }

  /**
   * 记录本 run 生效的沉默阈值（supervisor start 时一次）。
   *
   * 巡检是独立进程，只能从 DB 知道「这个 run 该不该按沉默判定」——
   * human / 无进展信号的 run 若按 stage 重算，会被误判成卡死。
   * 写入失败只丢这条遥测，方向是「巡检不介入」，不会误杀。
   */
  recordSilencePolicy(runId: string, silenceMs: number | null): void {
    this.enqueue(runId, { silence: { ms: silenceMs } })
  }

  /** owner 心跳：证明编排进程还活着，与模型是否在动无关 */
  heartbeatOwner(runId: string, pid: number, now: string): void {
    this.enqueue(runId, { owner: { pid, at: now } })
  }

  /** 巡检 claim：幂等，第二次返回 false */
  async markStallReported(runId: string, now: string): Promise<boolean> {
    return this.withRole(async (c) => {
      const r = await c.query(
        `UPDATE run_liveness SET stall_reported_at=$2, updated_at=now()
         WHERE run_id=$1 AND stall_reported_at IS NULL`,
        [runId, now],
      )
      return (r.rowCount ?? 0) > 0
    })
  }

  /**
   * 扫描 owner 心跳过期的 RUNNING run。
   *
   * 没有 liveness 行的旧 run 不在这里返回 —— 它们走既有 wall_clock 兜底，
   * 不能被巡检凭空判定为卡死。
   */
  async readStaleCandidates(
    ownerHeartbeatBefore: string,
    limit: number,
  ): Promise<readonly LivenessCandidate[]> {
    return this.withRole(async (c) => {
      const r = await c.query<LivenessCandidate>(
        `SELECT r.id AS run_id, r.task_id, r.stage, r.started_at,
                l.last_progress_at, l.last_kind, l.owner_heartbeat_at,
                l.harness_pid, l.harness_pgid, l.harness_started_at, l.silence_ms
         FROM run r
         JOIN run_liveness l ON l.run_id = r.id
         WHERE r.status='RUNNING'
           AND l.stall_reported_at IS NULL
           AND l.owner_heartbeat_at IS NOT NULL
           AND l.owner_heartbeat_at < $1
         ORDER BY l.owner_heartbeat_at ASC
         LIMIT $2`,
        [ownerHeartbeatBefore, limit],
      )
      return r.rows
    })
  }

  /** 巡检自身可观测：每轮写一次，异常写 last_error */
  async recordWorkerHealth(name: string, now: string, error: string | null): Promise<void> {
    await this.withRole(async (c) => {
      await c.query(
        `INSERT INTO worker_health (name, last_seen_at, last_error)
         VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET
           last_seen_at=EXCLUDED.last_seen_at,
           last_error=EXCLUDED.last_error`,
        [name, now, error],
      )
    })
  }

  /**
   * 终态 run 的 liveness 行保留 7 天后删除。
   * 只删终态；RUNNING / PENDING 一律保留。
   */
  async pruneTerminal(now: string, olderThanDays: number): Promise<number> {
    return this.withRole(async (c) => {
      const r = await c.query(
        `DELETE FROM run_liveness l
         USING run r
         WHERE l.run_id = r.id
           AND r.status NOT IN ('RUNNING','PENDING')
           AND l.updated_at < $1::timestamptz - ($2 || ' days')::interval`,
        [now, olderThanDays],
      )
      return r.rowCount ?? 0
    })
  }

  /** 等待队列排空（测试用；生产不调用） */
  async drain(): Promise<void> {
    for (;;) {
      if (this.flushPromise !== null) {
        await this.flushPromise
        continue
      }
      if (this.queue.size === 0) return
      this.kick()
    }
  }

  /** 关闭自建 pool；注入的 pool 由调用方关闭 */
  async close(): Promise<void> {
    this.closed = true
    await this.drain()
    if (this.ownsPool) await this.pool.end()
  }

  /** run 进入终态后清掉内存节流表，避免长期运行积累 */
  forget(runId: string): void {
    this.lastProgressAt.delete(runId)
    this.queue.delete(runId)
  }

  private enqueue(runId: string, write: PendingWrite): void {
    if (this.closed) return
    const existing = this.queue.get(runId)
    const merged: PendingWrite = {
      ...existing,
      ...(write.progress === undefined ? {} : { progress: write.progress }),
      ...(write.harness === undefined ? {} : { harness: write.harness }),
      ...(write.owner === undefined ? {} : { owner: write.owner }),
      ...(write.silence === undefined ? {} : { silence: write.silence }),
    }
    if (existing === undefined && this.queue.size >= MAX_QUEUE) {
      // 遥测可丢：丢最旧的一条，Run 不能因为遥测积压而阻塞
      const oldest = this.queue.keys().next()
      if (oldest.done !== true) this.queue.delete(oldest.value)
    }
    this.queue.set(runId, merged)
    this.kick()
  }

  private kick(): void {
    if (this.flushPromise !== null) return
    this.flushPromise = this.flushLoop().finally(() => {
      this.flushPromise = null
    })
  }

  private async flushLoop(): Promise<void> {
    while (this.queue.size > 0) {
      const entry = this.queue.entries().next()
      if (entry.done === true) return
      const [runId, write] = entry.value
      this.queue.delete(runId)
      try {
        await this.write(runId, write)
      } catch (error) {
        // 遥测失败不得影响 Run
        this.onError(error)
      }
    }
  }

  private async write(runId: string, write: PendingWrite): Promise<void> {
    const hasProgress = write.progress !== undefined
    await this.withRole(async (c) => {
      await c.query(
        `INSERT INTO run_liveness (
           run_id, last_progress_at, progress_seq, last_kind, silence_ms,
           owner_pid, owner_heartbeat_at,
           harness_pid, harness_pgid, harness_started_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
         ON CONFLICT (run_id) DO UPDATE SET
           last_progress_at = COALESCE(EXCLUDED.last_progress_at, run_liveness.last_progress_at),
           progress_seq = run_liveness.progress_seq + $3,
           last_kind = COALESCE(EXCLUDED.last_kind, run_liveness.last_kind),
           silence_ms = COALESCE(EXCLUDED.silence_ms, run_liveness.silence_ms),
           owner_pid = COALESCE(EXCLUDED.owner_pid, run_liveness.owner_pid),
           owner_heartbeat_at = COALESCE(EXCLUDED.owner_heartbeat_at, run_liveness.owner_heartbeat_at),
           harness_pid = COALESCE(run_liveness.harness_pid, EXCLUDED.harness_pid),
           harness_pgid = COALESCE(run_liveness.harness_pgid, EXCLUDED.harness_pgid),
           harness_started_at = COALESCE(run_liveness.harness_started_at, EXCLUDED.harness_started_at),
           updated_at = now()`,
        [
          runId,
          write.progress?.at ?? null,
          hasProgress ? 1 : 0,
          write.progress?.kind ?? null,
          write.silence === undefined ? null : write.silence.ms,
          write.owner?.pid ?? null,
          write.owner?.at ?? null,
          write.harness?.pid ?? null,
          write.harness?.pgid ?? null,
          write.harness?.startedAt ?? null,
        ],
      )
    })
  }

  private async withRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE keel_control')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
