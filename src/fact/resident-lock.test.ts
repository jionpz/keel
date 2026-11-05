/**
 * 常驻进程单实例锁 —— 真实 PostgreSQL 集成测试。
 *
 * 这里验证的是锁语义本身：同角色互斥、双角色共存、release 后可重取、
 * 以及「连接断开（等价 kill -9）后锁自动失效」。CLI 层不依赖真实锁状态，
 * 那部分由 `src/cli/poller.test.ts` / `src/cli/timer-worker.test.ts` 注入覆盖。
 */

import { Client } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { connectionString } from './db.js'
import {
  acquireResidentLock,
  lockErrorMessage,
  RESIDENT_LOCK_CLASS_ID,
  RESIDENT_LOCK_OBJ_IDS,
  type ResidentLock,
  type ResidentRole,
} from './resident-lock.js'

/** 统一收尾：失败路径也不能把锁留给后续用例 */
const acquired: ResidentLock[] = []

async function acquire(role: ResidentRole): Promise<ResidentLock> {
  const lock = await acquireResidentLock(role)
  expect(lock, `${role} 应能获取锁`).not.toBeNull()
  if (lock === null) throw new Error('unreachable')
  acquired.push(lock)
  return lock
}

afterEach(async () => {
  while (acquired.length > 0) {
    await acquired.pop()?.release()
  }
})

describe('acquireResidentLock', () => {
  it('同角色第二次获取返回 null（不阻塞、不等待）', async () => {
    await acquire('poller')

    const second = await acquireResidentLock('poller')
    expect(second).toBeNull()
  })

  it('poller 与 timer-worker 各自命名空间，可同时持有', async () => {
    await acquire('poller')
    await acquire('timer-worker')
  })

  it('release 后同角色可再次获取；重复 release 幂等', async () => {
    const first = await acquire('poller')
    await first.release()
    await first.release()

    const again = await acquireResidentLock('poller')
    expect(again).not.toBeNull()
    if (again !== null) acquired.push(again)
  })

  it('连接直接断开（等价 kill -9）后锁自动失效，无需手工清理', async () => {
    // 用裸 Client 模拟「持锁进程崩溃」：只加锁、不 unlock，直接 end()
    const client = new Client({ connectionString: connectionString() })
    await client.connect()
    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
        [RESIDENT_LOCK_CLASS_ID, RESIDENT_LOCK_OBJ_IDS.poller],
      )
      expect(result.rows[0]?.locked).toBe(true)
      // 持锁期间同角色确实拿不到 —— 证明下面成功获取不是「本来就没锁」
      expect(await acquireResidentLock('poller')).toBeNull()
    } finally {
      // 刻意的：不调用 pg_advisory_unlock，靠连接断开让服务器释放
      await client.end()
    }

    const lock = await acquireResidentLock('poller')
    expect(lock).not.toBeNull()
    if (lock !== null) acquired.push(lock)
  })
})

describe('lockErrorMessage', () => {
  it('postgres:// / postgresql:// 连接串替换为 postgres://***', () => {
    expect(
      lockErrorMessage(
        new Error('connect ECONNREFUSED postgres://user:secret@db.example:5432/keel down'),
      ),
    ).toBe('connect ECONNREFUSED postgres://*** down')
    expect(lockErrorMessage('postgresql://u:p@localhost/keel_test')).toBe('postgres://***')
  })

  it('不含连接串的消息原样保留', () => {
    expect(lockErrorMessage(new Error('boom'))).toBe('boom')
    expect(lockErrorMessage('plain failure')).toBe('plain failure')
  })
})
