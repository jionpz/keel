/**
 * 数据库连接与角色切换。
 *
 * 角色模型（docs/03-domain-model.md §4）：
 *   应用以实际用户连接，然后 SET ROLE 到 keel_control 或 keel_execution。
 *   两个角色都是 NOLOGIN —— 不需要为它们管理密码。
 *
 * ⚠️ SET ROLE 确实会降权，即使连接用户是 superuser：
 *    权限检查走 current_user（SET ROLE 后已切换），而非 session_user。
 *    这一点经实测确认，并由 invariants.test.ts 的反例测试持续保证。
 */

import { Pool, type PoolClient } from 'pg'

export type KeelRole = 'keel_control' | 'keel_execution'

export function connectionString(): string {
  return (
    process.env.KEEL_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://localhost/keel_dev'
  )
}

let pool: Pool | undefined

export function getPool(): Pool {
  if (pool === undefined) {
    pool = new Pool({ connectionString: connectionString() })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool !== undefined) {
    await pool.end()
    pool = undefined
  }
}

/**
 * 以指定角色执行一段操作。
 *
 * 用 SET LOCAL ROLE + 事务，保证角色不会泄漏到连接池中的下一个使用者 ——
 * 事务结束时 SET LOCAL 自动失效。
 */
export async function asRole<T>(
  role: KeelRole,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw e
  } finally {
    client.release()
  }
}

/** 以连接用户（属主）身份执行 —— 仅用于测试装置与迁移，生产代码不应使用 */
export async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
