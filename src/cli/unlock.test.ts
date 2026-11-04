/**
 * `keel unlock` —— 只在人确认后删除文件锁。
 *
 * 关键不是「能删」，而是「不乱删」：无 --force 时锁目录与 owner.json
 * 必须原样保留，非法 repoId 不能借路径拼接碰到锁目录之外的东西。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockPathFor, unlockRepo } from './unlock.js'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'keel-unlock-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function hold(repoId: string): string {
  const lock = lockPathFor(root, repoId)
  mkdirSync(lock, { recursive: true })
  writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid: 123, host: 'h', op: 'prepare', started_at: '2026-11-04T00:00:00Z' }),
  )
  return lock
}

describe('unlockRepo', () => {
  it('没有锁 → absent，不创建任何东西', () => {
    const r = unlockRepo('r1', { root })
    expect(r.status).toBe('absent')
    expect(existsSync(join(root, 'locks'))).toBe(false)
  })

  it('无 --force → held，锁目录与 owner.json 原样保留', () => {
    const lock = hold('r1')
    const r = unlockRepo('r1', { root })
    expect(r.status).toBe('held')
    if (r.status === 'held') {
      expect(r.holder?.pid).toBe(123)
      expect(r.holder?.op).toBe('prepare')
    }
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(join(lock, 'owner.json'), 'utf8')).toContain('"pid":123')
  })

  it('有 --force → unlocked，锁目录被删除', () => {
    const lock = hold('r1')
    const r = unlockRepo('r1', { root, force: true })
    expect(r.status).toBe('unlocked')
    if (r.status === 'unlocked') expect(r.holder?.pid).toBe(123)
    expect(existsSync(lock)).toBe(false)
  })

  it('--force 对不存在的锁也是幂等的', () => {
    expect(unlockRepo('r1', { root, force: true }).status).toBe('absent')
  })

  it.each(['../evil', 'a/b', 'a\\b', '..', '', 'a b', '.'])(
    '非法 repoId %j → invalid，不触碰文件系统',
    (repoId) => {
      hold('r1')
      const r = unlockRepo(repoId, { root, force: true })
      expect(r.status).toBe('invalid')
      // 合法锁还在，且没有在锁目录之外写出任何东西
      expect(existsSync(lockPathFor(root, 'r1'))).toBe(true)
      expect(existsSync(join(root, 'evil.lock'))).toBe(false)
    },
  )
})
