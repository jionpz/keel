/**
 * 常驻进程单实例锁 —— PostgreSQL 会话级 advisory lock。
 *
 * 为什么用会话级 advisory lock：
 *   - 不新增外部服务，数据库本来就是常驻进程的必需依赖；
 *   - 锁绑定**后端连接**：进程正常退出显式解锁，`kill -9` / 掉电由服务器
 *     在连接断开时自动释放 —— 不需要 pidfile，也不需要手工清理；
 *   - 锁的键空间属于当前数据库，同库不同机器同样互斥（不是「同一台机器」）。
 *
 * 为什么用**专用连接**而不是连接池：池里的连接会随事务归还、被回收，
 * 锁的存活期就不受进程控制；池化连接还可能被 `pool.end()` 提前收掉。
 *
 * classid 固定为 ASCII `KEEL`（0x4b45454c），objid 按角色区分，
 * 于是 poller 与 timer-worker 各自一个命名空间，可以同时运行。
 */

import { Client } from 'pg'
import { connectionString } from './db.js'

export type ResidentRole = 'poller' | 'timer-worker'

/** advisory lock 的 classid：ASCII "KEEL" */
export const RESIDENT_LOCK_CLASS_ID = 0x4b45454c

/** 每个常驻角色一个 objid —— 不同的锁互不阻塞 */
export const RESIDENT_LOCK_OBJ_IDS = {
  poller: 1,
  'timer-worker': 2,
} as const satisfies Record<ResidentRole, number>

export interface ResidentLock {
  readonly role: ResidentRole
  /** 幂等：先 unlock 再 end；释放失败不改变调用方退出码 */
  release(): Promise<void>
}

/**
 * 尝试获取某个角色的单实例锁。
 *
 * - 拿到 → 返回 `ResidentLock`；
 * - 同库同角色已被持有 → 返回 `null`（明确的「已有实例」，由调用方决定退出）；
 * - 连接 / 查询失败 → 原样抛出（不能把基础设施故障说成「已有实例」）。
 *
 * 连接失败时尽力关闭客户端，避免半开连接留在事件循环里。
 */
export async function acquireResidentLock(role: ResidentRole): Promise<ResidentLock | null> {
  const client = new Client({ connectionString: connectionString() })
  const values = [RESIDENT_LOCK_CLASS_ID, RESIDENT_LOCK_OBJ_IDS[role]]

  try {
    await client.connect()
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
      values,
    )
    if (result.rows[0]?.locked !== true) {
      // 已有人持有：这条连接没有锁，直接收掉
      await client.end().catch(() => undefined)
      return null
    }
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }

  let released = false
  return {
    role,
    async release(): Promise<void> {
      if (released) return
      released = true
      // 先显式解锁，让「已释放」早于连接拆除；两步失败都吞掉 ——
      // 进程已经干完活了，释放失败只说明连接被对端提前关掉，不能改变退出码。
      await client
        .query('SELECT pg_advisory_unlock($1::int, $2::int)', values)
        .catch(() => undefined)
      await client.end().catch(() => undefined)
    },
  }
}

/**
 * 把获取锁时的错误变成可打印文案。
 *
 * `pg` 的错误消息可能带完整连接串（含用户名 / 密码）；这里只替换
 * `postgres://…` / `postgresql://…`，其余原样返回，便于定位问题。
 */
export function lockErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://***')
}
