/**
 * 文件锁。
 *
 * 这里测的是「互斥」本身，不是 git：如果锁允许两个 fn 同时进入，
 * 上面的 GitWorkspace 并发测试只是碰巧没撞上慢 clone。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import { readOwner, withFileLock } from './file-lock.js'

let root: string
let lock: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'keel-lock-'))
  lock = join(root, 'repo-r1.lock')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
}

describe('withFileLock', () => {
  it('持锁期间写 owner.json，释放后删除锁目录', async () => {
    const r = await withFileLock(lock, 'prepare', async () => {
      const owner = readOwner(lock) as { pid?: number; op?: string }
      expect(owner.pid).toBe(process.pid)
      expect(owner.op).toBe('prepare')
      const raw = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as {
        started_at: string
      }
      expect(raw.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      return ok('done')
    })
    expect(r.ok).toBe(true)
    const second = await withFileLock(lock, 'again', async () => ok('again'))
    expect(second.ok).toBe(true)
  })

  it('两个并发调用不重叠 —— 第二个在第一个释放后才进入', async () => {
    const events: string[] = []
    const first = withFileLock(lock, 'a', async () => {
      events.push('a:start')
      await sleep(60)
      events.push('a:end')
      return ok(undefined)
    })
    // 让第一个先拿到锁
    await sleep(10)
    const second = withFileLock(lock, 'b', async () => {
      events.push('b:start')
      events.push('b:end')
      return ok(undefined)
    })

    const [r1, r2] = await Promise.all([first, second])
    expect(r1.ok && r2.ok).toBe(true)
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('等锁超时 → lock_timeout，含锁路径与持有者', async () => {
    mkdirSync(lock)
    writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 99999, host: 'h', started_at: new Date().toISOString(), op: 'clone' }),
    )

    const started = Date.now()
    const r = await withFileLock(lock, 'prepare', async () => ok(undefined), {
      timeoutMs: 80,
      pollMs: 10,
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.detail).toMatch(/^\[lock_timeout\]/)
      expect(r.error.detail).toContain(lock)
      expect(r.error.detail).toContain('pid=99999')
      expect(r.error.detail).toContain('op=clone')
    }
    // 不自动破锁 —— 别人的锁还在
    expect(readOwner(lock)).toBeDefined()
  })

  it('fn 抛异常也会释放锁', async () => {
    await expect(
      withFileLock(lock, 'x', async (): Promise<Result<void>> => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const r = await withFileLock(lock, 'after', async () => ok('ok'))
    expect(r.ok).toBe(true)
  })

  it('锁目录无法创建（父路径是文件）→ lock_failed，而不是死等', async () => {
    const file = join(root, 'not-a-dir')
    writeFileSync(file, 'x')
    const r = await withFileLock(join(file, 'lock'), 'prepare', async () => ok(undefined))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.detail).toMatch(/^\[lock_failed\]/)
  })
})
