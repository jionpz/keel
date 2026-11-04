/**
 * 控制台鉴权纯逻辑测试：口令、会话过期、限流窗口、Cookie 解析。
 *
 * 不起 HTTP —— 路由与状态码由 `console.test.ts` 覆盖。
 */

import { describe, expect, it } from 'vitest'
import {
  ConsoleAuth,
  generatePassword,
  parseCookies,
  resolveConsoleAuth,
  SESSION_COOKIE,
} from './console-auth.js'

const PASSWORD = 'correct-horse-battery'

function cookieOf(token: string): string {
  return `${SESSION_COOKIE}=${token}`
}

function authWith(overrides: Partial<ConstructorParameters<typeof ConsoleAuth>[0]> = {}) {
  let clock = 1_000_000
  const auth = new ConsoleAuth({
    password: PASSWORD,
    now: () => clock,
    ...overrides,
  })
  return {
    auth,
    advance(ms: number) {
      clock += ms
    },
  }
}

describe('parseCookies', () => {
  it('解析多个 Cookie 并去空白', () => {
    const cookies = parseCookies('a=1; b=two ; c=')
    expect(cookies.get('a')).toBe('1')
    expect(cookies.get('b')).toBe('two')
    expect(cookies.get('c')).toBe('')
  })

  it('容忍缺 =、空段与非法百分号编码', () => {
    const cookies = parseCookies('broken; ok=1; bad=%E0%A4%A')
    expect(cookies.has('broken')).toBe(false)
    expect(cookies.get('ok')).toBe('1')
    expect(cookies.get('bad')).toBe('%E0%A4%A')
  })

  it('去掉成对引号，同名只取第一个', () => {
    const cookies = parseCookies('a="x"; a=y')
    expect(cookies.get('a')).toBe('x')
  })

  it('空头返回空表', () => {
    expect(parseCookies(undefined).size).toBe(0)
    expect(parseCookies('').size).toBe(0)
  })
})

describe('generatePassword', () => {
  it('形如 4 组 4 位，且不含易混字符', () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generatePassword()
      expect(password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/)
      expect(password).not.toMatch(/[01loi]/)
    }
  })

  it('每次生成都不同', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generatePassword()))
    expect(seen.size).toBe(50)
  })
})

describe('resolveConsoleAuth', () => {
  it('环境变量优先', () => {
    const resolved = resolveConsoleAuth({ KEEL_CONSOLE_PASSWORD: 'from-env' })
    expect(resolved).toEqual({ password: 'from-env', source: 'env' })
  })

  it('未设置或空字符串都回落到随机口令', () => {
    for (const env of [{}, { KEEL_CONSOLE_PASSWORD: '' }]) {
      const resolved = resolveConsoleAuth(env)
      expect(resolved.source).toBe('generated')
      expect(resolved.password).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/)
    }
  })
})

describe('ConsoleAuth', () => {
  it('正确口令签发会话，错误口令不签', () => {
    const { auth } = authWith()
    const bad = auth.login('nope', '127.0.0.1', false)
    expect(bad).toEqual({ ok: false, reason: 'bad-password' })

    const good = auth.login(PASSWORD, '127.0.0.1', false)
    expect(good.ok).toBe(true)
    if (!good.ok) throw new Error('expected ok')
    expect(good.maxAgeSec).toBe(12 * 60 * 60)
    expect(auth.isValid(cookieOf(good.token))).toBe(true)
    expect(auth.isValid(undefined)).toBe(false)
    expect(auth.isValid(`${SESSION_COOKIE}=forged`)).toBe(false)
  })

  it('默认会话 12 小时过期', () => {
    const { auth, advance } = authWith()
    const result = auth.login(PASSWORD, '1.1.1.1', false)
    if (!result.ok) throw new Error('expected ok')
    advance(12 * 60 * 60 * 1000 - 1)
    expect(auth.isValid(cookieOf(result.token))).toBe(true)
    advance(2)
    expect(auth.isValid(cookieOf(result.token))).toBe(false)
  })

  it('保持登录会话 7 天过期', () => {
    const { auth, advance } = authWith()
    const result = auth.login(PASSWORD, '1.1.1.1', true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.maxAgeSec).toBe(7 * 24 * 60 * 60)
    advance(7 * 24 * 60 * 60 * 1000 - 1)
    expect(auth.isValid(cookieOf(result.token))).toBe(true)
    advance(2)
    expect(auth.isValid(cookieOf(result.token))).toBe(false)
  })

  it('退出后会话立即失效，重复退出不抛错', () => {
    const { auth } = authWith()
    const result = auth.login(PASSWORD, '1.1.1.1', false)
    if (!result.ok) throw new Error('expected ok')
    const cookie = cookieOf(result.token)
    auth.logout(cookie)
    auth.logout(cookie)
    expect(auth.isValid(cookie)).toBe(false)
  })

  it('同一 IP 连续 5 次失败后进入限流，窗口过后恢复', () => {
    const { auth, advance } = authWith()
    for (let i = 0; i < 5; i += 1) {
      expect(auth.login('wrong', '9.9.9.9', false)).toEqual({
        ok: false,
        reason: 'bad-password',
      })
    }
    const limited = auth.login(PASSWORD, '9.9.9.9', false)
    expect(limited.ok).toBe(false)
    if (limited.ok) throw new Error('expected limited')
    expect(limited.reason).toBe('rate-limited')
    if (limited.reason !== 'rate-limited') throw new Error('expected limited')
    expect(limited.retryAfterSec).toBeGreaterThan(0)

    advance(5 * 60 * 1000 + 1)
    expect(auth.login(PASSWORD, '9.9.9.9', false).ok).toBe(true)
  })

  it('限流按 IP 隔离：一个 IP 被限不影响另一个', () => {
    const { auth } = authWith()
    for (let i = 0; i < 5; i += 1) auth.login('wrong', '1.1.1.1', false)
    expect(auth.login(PASSWORD, '1.1.1.1', false).ok).toBe(false)
    expect(auth.login(PASSWORD, '2.2.2.2', false).ok).toBe(true)
  })

  it('全局失败达到 20 次后，新 IP 也被限流', () => {
    const { auth } = authWith()
    for (let i = 0; i < 20; i += 1) auth.login('wrong', `10.0.0.${i}`, false)
    const limited = auth.login(PASSWORD, '10.0.0.200', false)
    expect(limited.ok).toBe(false)
    if (limited.ok) throw new Error('expected limited')
    expect(limited.reason).toBe('rate-limited')
  })

  it('成功登录清零该 IP 的失败计数', () => {
    const { auth } = authWith()
    for (let i = 0; i < 4; i += 1) auth.login('wrong', '3.3.3.3', false)
    expect(auth.login(PASSWORD, '3.3.3.3', false).ok).toBe(true)
    for (let i = 0; i < 4; i += 1) {
      expect(auth.login('wrong', '3.3.3.3', false)).toEqual({
        ok: false,
        reason: 'bad-password',
      })
    }
  })

  it('Cookie 带 HttpOnly / SameSite=Strict，secure 时追加 Secure', () => {
    const { auth } = authWith()
    const plain = auth.sessionCookie('tok', 3600, false)
    expect(plain).toContain(`${SESSION_COOKIE}=tok`)
    expect(plain).toContain('HttpOnly')
    expect(plain).toContain('SameSite=Strict')
    expect(plain).toContain('Max-Age=3600')
    expect(plain).not.toContain('Secure')

    expect(auth.sessionCookie('tok', 3600, true)).toContain('Secure')

    const cleared = auth.clearCookie(true)
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('Secure')
  })

  it('会话数量超过上限时淘汰最早过期的', () => {
    const { auth } = authWith({ maxSessions: 2 })
    const first = auth.login(PASSWORD, '1.1.1.1', false)
    const second = auth.login(PASSWORD, '1.1.1.2', false)
    const third = auth.login(PASSWORD, '1.1.1.3', false)
    if (!first.ok || !second.ok || !third.ok) throw new Error('expected ok')
    expect(auth.isValid(cookieOf(first.token))).toBe(false)
    expect(auth.isValid(cookieOf(second.token))).toBe(true)
    expect(auth.isValid(cookieOf(third.token))).toBe(true)
  })

  it('空口令在构造时就失败，不留无鉴权路径', () => {
    expect(() => new ConsoleAuth({ password: '' })).toThrow('控制台口令不能为空')
  })
})
