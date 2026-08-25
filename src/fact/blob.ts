/**
 * blob 存储 —— 内容寻址。
 *
 * ADR-0004：`artifact.body` 超过 256 KB 时落 blob，body 只存引用。
 * 理由：完整对话、大 diff 是 MB 级，放进热表的 JSONB 会让每次 latest() 查询
 * 都被无关的大字段拖累。
 *
 * 接口按**对象存储语义**设计（put(bytes) -> hash / get(hash) -> bytes），
 * v0.1 用本地文件系统实现，日后换 S3 兼容存储时不改调用方。
 *
 * ⚠️ 写入顺序：**先 blob，后 artifact**。
 * 孤儿 blob 由后台清理；反过来会产生悬空引用，不可接受。
 *
 * R13(issue #23)边界：blob 是**进程内文件系统**（对象存储语义），
 * **不经 DB 角色授权**（SET ROLE 之外）—— 它不是 Fact 平面的 DB 表。
 * I5 的强制边界是 DB 平面：`artifact` 表的写入由 GRANT 钉死，
 * blob 引用（hash）的完整性由 DB 授权保证；blob 本体由进程文件权限保护
 * （KEEL_BLOB_DIR 仅本进程可写）。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 超过此大小走 blob（ADR-0004） */
export const BLOB_THRESHOLD_BYTES = 256 * 1024

export interface BlobRef {
  $ref: string
  size: number
  preview: string
}

export function blobRoot(): string {
  return process.env.KEEL_BLOB_DIR ?? '.keel/blob'
}

/** 内容寻址路径：<root>/<h[0:2]>/<h[2:]> —— 分片避免单目录文件过多 */
function pathFor(hash: string): string {
  return join(blobRoot(), hash.slice(0, 2), hash.slice(2))
}

export function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function put(bytes: Buffer): Promise<string> {
  const hash = hashOf(bytes)
  const p = pathFor(hash)
  // 内容寻址天然去重：同一份内容只存一次
  if (await has(hash)) return hash
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, bytes)
  return hash
}

export async function get(hash: string): Promise<Buffer> {
  return readFile(pathFor(hash))
}

export async function has(hash: string): Promise<boolean> {
  try {
    await stat(pathFor(hash))
    return true
  } catch {
    return false
  }
}

/** 判断一个 artifact body 是否是 blob 引用 */
export function isBlobRef(body: unknown): body is BlobRef {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { $ref?: unknown }).$ref === 'string' &&
    (body as { $ref: string }).$ref.startsWith('blob://')
  )
}

export function refToHash(ref: BlobRef): string {
  return ref.$ref.slice('blob://'.length)
}

/**
 * 按阈值切分：小的原样返回，大的落 blob 并返回引用。
 * preview 保留前 200 字符，便于不取 blob 也能大致看出内容。
 */
export async function externalizeIfLarge(body: unknown): Promise<unknown> {
  const json = JSON.stringify(body)
  const bytes = Buffer.from(json, 'utf8')
  if (bytes.byteLength <= BLOB_THRESHOLD_BYTES) return body

  const hash = await put(bytes)
  const ref: BlobRef = {
    $ref: `blob://${hash}`,
    size: bytes.byteLength,
    preview: json.slice(0, 200),
  }
  return ref
}

/** 还原：是引用就取回，不是就原样返回 */
export async function materialize(body: unknown): Promise<unknown> {
  if (!isBlobRef(body)) return body
  const bytes = await get(refToHash(body))
  return JSON.parse(bytes.toString('utf8'))
}
