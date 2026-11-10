import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { access, open, readdir } from 'node:fs/promises'
import path from 'node:path'
import { err, makeError, ok, type Result } from '../contracts/errors.js'

export interface FileObservation {
  readonly path: string
  readonly digest: string
  readonly content: string
}

const MAX_FILE = 64 * 1024
const MAX_TOTAL = 256 * 1024
const MAX_FILES = 1000
const excluded = new Set(['node_modules', 'dist', 'coverage'])
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

function safeSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  return (
    segment !== '' &&
    !segment.startsWith('.') &&
    !excluded.has(lower) &&
    !/^(?:env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/.test(lower) &&
    !/\.(?:pem|key)$/.test(lower)
  )
}

function safePath(value: string): boolean {
  return !value.startsWith('/') && !value.includes('\\') && value.split('/').every(safeSegment)
}

function childPath(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`
}

async function supported(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    await access('/proc/self/fd')
    return true
  } catch {
    return false
  }
}

// 管理员提供的根路径也从 / 开始逐级打开，每一级锚定父目录 FD，不跟随软链。
async function openRoot(root: string): Promise<FileHandle> {
  if (!path.isAbsolute(root) || root.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('invalid root')
  }
  let current = await open('/', directoryFlags)
  try {
    for (const segment of root.split('/').filter(Boolean)) {
      const next = await open(childPath(current, segment), directoryFlags)
      await current.close()
      current = next
    }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}

function unsupported<T>(): Result<T> {
  return err(makeError('CAPABILITY_UNSUPPORTED', '需要 Linux 和可用的 /proc/self/fd'))
}

export async function indexManagedWorkspace(root: string): Promise<Result<readonly string[]>> {
  if (!(await supported())) return unsupported()
  try {
    const base = await openRoot(root)
    try {
      const files: string[] = []
      async function walk(directory: FileHandle, prefix: string): Promise<boolean> {
        const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })
        for (const entry of entries) {
          if (!safeSegment(entry.name) || entry.isSymbolicLink()) continue
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            // 并发替换可令打开失败，但不能把目录 FD 重定向到软链目标。
            let child: FileHandle
            try {
              child = await open(childPath(directory, entry.name), directoryFlags)
            } catch {
              continue
            }
            try {
              if (!(await walk(child, relative))) return false
            } finally {
              await child.close()
            }
          } else if (entry.isFile()) {
            let child: FileHandle
            try {
              child = await open(childPath(directory, entry.name), fileFlags)
            } catch {
              continue
            }
            try {
              if (!(await child.stat()).isFile()) continue
              files.push(relative)
              if (files.length > MAX_FILES) return false
            } finally {
              await child.close()
            }
          }
        }
        return true
      }
      if (!(await walk(base, '')))
        return err(makeError('CONTEXT_BUDGET_EXCEEDED', '文件索引超过 1000 项'))
      return ok(files.sort())
    } finally {
      await base.close()
    }
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法索引工作区'))
  }
}

export async function readManagedFiles(
  root: string,
  paths: readonly string[],
): Promise<Result<readonly FileObservation[]>> {
  if (!(await supported())) return unsupported()
  if (paths.length > 8) return err(makeError('CONTEXT_BUDGET_EXCEEDED', '每次最多读取 8 个文件'))
  if (paths.some((value) => !safePath(value)))
    return err(makeError('PERMISSION_DENIED', '文件路径不允许读取'))
  try {
    const base = await openRoot(root)
    try {
      const observations: FileObservation[] = []
      let total = 0
      for (const relative of paths) {
        const segments = relative.split('/')
        const parents: FileHandle[] = []
        try {
          let parent = base
          for (const segment of segments.slice(0, -1)) {
            parent = await open(childPath(parent, segment), directoryFlags)
            parents.push(parent)
          }
          const name = segments.at(-1)
          if (name === undefined) return err(makeError('PERMISSION_DENIED', '文件路径不允许读取'))
          const handle = await open(childPath(parent, name), fileFlags)
          try {
            const stat = await handle.stat()
            if (!stat.isFile()) return err(makeError('PERMISSION_DENIED', '只允许读取普通文件'))
            if (stat.size > MAX_FILE || total + stat.size > MAX_TOTAL)
              return err(makeError('CONTEXT_BUDGET_EXCEEDED', '文件内容超出大小限制'))
            const bytes = Buffer.alloc(MAX_FILE + 1)
            let length = 0
            while (length < bytes.length) {
              const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
              if (bytesRead === 0) break
              length += bytesRead
            }
            if (length > MAX_FILE || total + length > MAX_TOTAL)
              return err(makeError('CONTEXT_BUDGET_EXCEEDED', '文件内容超出大小限制'))
            const data = bytes.subarray(0, length)
            if (data.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))
              return err(makeError('PERMISSION_DENIED', '只允许读取 UTF-8 文本'))
            let content: string
            try {
              content = new TextDecoder('utf-8', { fatal: true }).decode(data)
            } catch {
              return err(makeError('PERMISSION_DENIED', '只允许读取 UTF-8 文本'))
            }
            total += length
            observations.push({
              path: relative,
              digest: createHash('sha256').update(data).digest('hex'),
              content,
            })
          } finally {
            await handle.close()
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ELOOP' || code === 'ENOTDIR')
            return err(makeError('PERMISSION_DENIED', '不允许读取软链接或非目录路径'))
          throw error
        } finally {
          for (const parent of parents.reverse()) await parent.close()
        }
      }
      return ok(observations)
    } finally {
      await base.close()
    }
  } catch {
    return err(makeError('WORKSPACE_ERROR', '无法读取工作区文件'))
  }
}
