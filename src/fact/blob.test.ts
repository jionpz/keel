/**
 * blob 根的位置决定「artifact 正文还在不在」。
 *
 * 这里只钉路径解析：显式 override 最高优先，否则必须跟随 KEEL_HOME，
 * 不能独立地相对 cwd —— 那会让同一个项目在不同目录启动时读到两个 blob 库。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobRoot } from './blob.js'

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'keel-blob-')))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('blobRoot', () => {
  it('显式 KEEL_BLOB_DIR 最高优先级（不解析、不改写）', () => {
    expect(blobRoot({ KEEL_BLOB_DIR: '/tmp/elsewhere' }, sandbox)).toBe('/tmp/elsewhere')
  })

  it('空字符串视为未设置，回落到 KEEL_HOME', () => {
    mkdirSync(join(sandbox, '.keel'))
    expect(blobRoot({ KEEL_BLOB_DIR: '' }, sandbox)).toBe(join(sandbox, '.keel', 'blob'))
  })

  it('跟随显式 KEEL_HOME', () => {
    expect(blobRoot({ KEEL_HOME: 'nested/home' }, sandbox)).toBe(
      join(sandbox, 'nested', 'home', 'blob'),
    )
  })

  it('未设置时跟随向上查找的项目根', () => {
    mkdirSync(join(sandbox, '.git'))
    const nested = join(sandbox, 'src', 'fact')
    mkdirSync(nested, { recursive: true })
    expect(blobRoot({}, nested)).toBe(join(sandbox, '.keel', 'blob'))
  })

  it('同一棵树内不同子目录得到同一个 blob 根', () => {
    mkdirSync(join(sandbox, '.keel'))
    const a = join(sandbox, 'a')
    const b = join(sandbox, 'b', 'c')
    mkdirSync(a)
    mkdirSync(b, { recursive: true })
    expect(blobRoot({}, a)).toBe(blobRoot({}, b))
  })
})
