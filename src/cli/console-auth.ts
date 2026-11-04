/**
 * 控制台鉴权：单口令 + 服务端会话 + 登录限流。
 *
 * 设计取舍见 .trellis/tasks/11-04-console-login-auth/design.md：
 *  - 口令只从环境变量或进程启动时的随机值来，不落盘、不下发页面；
 *  - 会话只存在进程内存里，重启即失效（明确接受）；
 *  - 口令比较走 scrypt + timingSafeEqual，失败文案统一；
 *  - 限流按来源 IP 与全局双窗口，避免控制台被当成口令靶子。
 *
 * 本文件不碰 HTTP：Cookie 只做解析/序列化，路由与状态码在 `console.ts`。
 */

import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'keel_console_session'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MINUTE_MS = 60 * 1000
const SCRYPT_KEYLEN = 32
/** 全局失败计数的键；真实 IP 不可能包含 NUL。 */
const GLOBAL_KEY = '\u0000global'
/** 去掉 0/o/1/l/i 等易混字符，方便从终端抄写。 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export interface AuthOptions {
  readonly password: string
  readonly sessionTtlMs?: number
  readonly rememberTtlMs?: number
  readonly perIpLimit?: number
  readonly globalLimit?: number
  readonly windowMs?: number
  readonly maxSessions?: number
  /** 测试注入时钟；生产用 Date.now。 */
  readonly now?: () => number
}

export type LoginOutcome =
  | { readonly ok: true; readonly token: string; readonly maxAgeSec: number }
  | { readonly ok: false; readonly reason: 'bad-password' }
  | { readonly ok: false; readonly reason: 'rate-limited'; readonly retryAfterSec: number }

interface SessionRecord {
  readonly expiresAt: number
}

interface FailureRecord {
  count: number
  resetAt: number
}

/**
 * 解析 Cookie 头。容错优先：空值、缺 `=`、非法百分号编码都不抛错。
 * 同名 Cookie 只取第一个 —— 与浏览器发送顺序一致。
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (header === undefined || header === '') return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (name === '') continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    try {
      value = decodeURIComponent(value)
    } catch {
      // 保留原值：非法编码不应让整个会话解析失败。
    }
    if (!out.has(name)) out.set(name, value)
  }
  return out
}

/** 4 组 4 位，约 79 bit；终端里一眼能读、可抄。 */
export function generatePassword(): string {
  const groups: string[] = []
  for (let g = 0; g < 4; g += 1) {
    let chunk = ''
    for (let i = 0; i < 4; i += 1) {
      chunk += PASSWORD_ALPHABET[randomInt(0, PASSWORD_ALPHABET.length)] ?? 'a'
    }
    groups.push(chunk)
  }
  return groups.join('-')
}

/**
 * 口令来源：显式环境变量优先；没有就为本次进程生成一个。
 * 不返回「无口令」这种状态 —— 控制台没有无鉴权模式。
 */
export function resolveConsoleAuth(env: NodeJS.ProcessEnv = process.env): {
  readonly password: string
  readonly source: 'env' | 'generated'
} {
  const configured = env.KEEL_CONSOLE_PASSWORD
  if (configured !== undefined && configured !== '') {
    return { password: configured, source: 'env' }
  }
  return { password: generatePassword(), source: 'generated' }
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class ConsoleAuth {
  private readonly passwordHash: Buffer
  private readonly salt: Buffer
  private readonly sessionTtlMs: number
  private readonly rememberTtlMs: number
  private readonly perIpLimit: number
  private readonly globalLimit: number
  private readonly windowMs: number
  private readonly maxSessions: number
  private readonly now: () => number
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly failures = new Map<string, FailureRecord>()

  constructor(opts: AuthOptions) {
    if (opts.password === '') throw new Error('控制台口令不能为空')
    this.salt = randomBytes(16)
    this.passwordHash = scryptSync(opts.password, this.salt, SCRYPT_KEYLEN)
    this.sessionTtlMs = opts.sessionTtlMs ?? 12 * HOUR_MS
    this.rememberTtlMs = opts.rememberTtlMs ?? 7 * DAY_MS
    this.perIpLimit = opts.perIpLimit ?? 5
    this.globalLimit = opts.globalLimit ?? 20
    this.windowMs = opts.windowMs ?? 5 * MINUTE_MS
    this.maxSessions = opts.maxSessions ?? 64
    this.now = opts.now ?? Date.now
  }

  /**
   * 校验口令并签发会话。顺序固定：先看限流，再算口令，最后才记失败 ——
   * 被限流的请求不再消耗 scrypt。
   */
  login(password: string, ip: string, remember: boolean): LoginOutcome {
    const retryAfterSec = this.retryAfter(ip)
    if (retryAfterSec !== undefined) {
      return { ok: false, reason: 'rate-limited', retryAfterSec }
    }
    if (!this.matches(password)) {
      this.recordFailure(ip)
      return { ok: false, reason: 'bad-password' }
    }
    this.failures.delete(ip)
    const token = randomBytes(32).toString('base64url')
    const ttl = remember ? this.rememberTtlMs : this.sessionTtlMs
    this.storeSession(token, ttl)
    return { ok: true, token, maxAgeSec: Math.floor(ttl / 1000) }
  }

  /** Cookie 里有会话、未过期、且服务端仍记得它。 */
  isValid(cookieHeader: string | undefined): boolean {
    this.pruneSessions()
    const token = parseCookies(cookieHeader).get(SESSION_COOKIE)
    if (token === undefined || token === '') return false
    const key = digestToken(token)
    const record = this.sessions.get(key)
    if (record === undefined) return false
    if (record.expiresAt <= this.now()) {
      this.sessions.delete(key)
      return false
    }
    return true
  }

  /** 幂等：没有会话、Cookie 损坏都不抛错。 */
  logout(cookieHeader: string | undefined): void {
    const token = parseCookies(cookieHeader).get(SESSION_COOKIE)
    if (token === undefined || token === '') return
    this.sessions.delete(digestToken(token))
  }

  sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
    return [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  clearCookie(secure: boolean): string {
    return [
      `${SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      ...(secure ? ['Secure'] : []),
    ].join('; ')
  }

  private matches(password: string): boolean {
    const candidate = scryptSync(password, this.salt, SCRYPT_KEYLEN)
    return timingSafeEqual(candidate, this.passwordHash)
  }

  private storeSession(token: string, ttlMs: number): void {
    this.pruneSessions()
    this.sessions.set(digestToken(token), { expiresAt: this.now() + ttlMs })
    while (this.sessions.size > this.maxSessions) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, record] of this.sessions) {
        if (record.expiresAt < oldestAt) {
          oldestAt = record.expiresAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.sessions.delete(oldestKey)
    }
  }

  private pruneSessions(): void {
    const now = this.now()
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(key)
    }
  }

  private retryAfter(ip: string): number | undefined {
    const now = this.now()
    const ipRecord = this.failures.get(ip)
    if (ipRecord !== undefined && now < ipRecord.resetAt && ipRecord.count >= this.perIpLimit) {
      return Math.max(1, Math.ceil((ipRecord.resetAt - now) / 1000))
    }
    const globalRecord = this.failures.get(GLOBAL_KEY)
    if (
      globalRecord !== undefined &&
      now < globalRecord.resetAt &&
      globalRecord.count >= this.globalLimit
    ) {
      return Math.max(1, Math.ceil((globalRecord.resetAt - now) / 1000))
    }
    return undefined
  }

  private recordFailure(ip: string): void {
    this.bump(ip)
    this.bump(GLOBAL_KEY)
    if (this.failures.size > 1024) this.pruneFailures()
  }

  private bump(key: string): void {
    const now = this.now()
    const record = this.failures.get(key)
    if (record === undefined || now >= record.resetAt) {
      this.failures.set(key, { count: 1, resetAt: now + this.windowMs })
      return
    }
    record.count += 1
  }

  private pruneFailures(): void {
    const now = this.now()
    for (const [key, record] of this.failures) {
      if (now >= record.resetAt) this.failures.delete(key)
    }
  }
}
