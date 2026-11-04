/**
 * GitHub 凭据纯逻辑测试 —— 不碰真实网络或 git。
 *
 * 凭据纪律的可验证部分只有两条：注入的环境长什么样、错误里还剩什么。
 * 真连一个 https git server 既慢，也证明不了「token 不在 argv / 不在文件里」。
 */

import { describe, expect, it } from 'vitest'
import { authEnvFor, gitAuthSecrets, readTokenFromEnv, redactSecrets } from './github-auth.js'

const TOKEN = 'ghp_transport_auth_test'
const B64 = Buffer.from(`oauth2:${TOKEN}`).toString('base64')

function noEnv(): NodeJS.ProcessEnv {
  return {}
}

describe('authEnvFor', () => {
  it('https remote + token → 一组 GIT_CONFIG_*，header 指向该 host', () => {
    const env = authEnvFor('https://github.com/acme/widget.git', TOKEN, noEnv())
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${B64}`,
    })
  })

  it('http remote 用 http 前缀，不升格成 https', () => {
    const env = authEnvFor('http://github.example.com/acme/widget.git', TOKEN, noEnv())
    expect(env.GIT_CONFIG_KEY_0).toBe('http.http://github.example.com/.extraheader')
  })

  it('GHES host 用自己的 host 作为 config 作用域，不打公网', () => {
    const env = authEnvFor('https://github.example.com/acme/widget.git', TOKEN, noEnv())
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.example.com/.extraheader')
  })

  it('无 token / 空白 token → 空对象', () => {
    expect(authEnvFor('https://github.com/acme/widget.git', undefined, noEnv())).toEqual({})
    expect(authEnvFor('https://github.com/acme/widget.git', '   ', noEnv())).toEqual({})
  })

  it('ssh:// 与 SCP-like 一律不注入 —— 走部署方 ssh key', () => {
    expect(authEnvFor('ssh://git@github.com/acme/widget.git', TOKEN, noEnv())).toEqual({})
    expect(authEnvFor('git@github.com:acme/widget.git', TOKEN, noEnv())).toEqual({})
  })

  it('file:// 与解析失败的 remote 不注入，也不在认证层吞错', () => {
    expect(authEnvFor('file:///tmp/repo.git', TOKEN, noEnv())).toEqual({})
    expect(authEnvFor('not a url', TOKEN, noEnv())).toEqual({})
  })

  it('非 GitHub https host 不注入 —— token 不发往非 GitHub 服务', () => {
    expect(authEnvFor('https://gitlab.com/acme/widget.git', TOKEN, noEnv())).toEqual({})
  })

  it('非默认端口写进作用域 —— 否则 git 的 URL 匹配不到，认证静默失效', () => {
    const env = authEnvFor('https://github.example.com:8443/acme/widget.git', TOKEN, noEnv())
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.example.com:8443/.extraheader')
  })

  it('默认端口被 URL 规范化掉，与 git 的默认端口语义一致', () => {
    // git 会把省略端口按 scheme 默认端口处理，所以 :443 不该出现在 key 里
    expect(
      authEnvFor('https://github.example.com:443/acme/widget.git', TOKEN, noEnv()).GIT_CONFIG_KEY_0,
    ).toBe('http.https://github.example.com/.extraheader')
    expect(
      authEnvFor('http://github.example.com:80/acme/widget.git', TOKEN, noEnv()).GIT_CONFIG_KEY_0,
    ).toBe('http.http://github.example.com/.extraheader')
  })

  it('既有 GIT_CONFIG_COUNT 时追加，不覆盖操作者配置', () => {
    const existing: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_VALUE_0: 'less',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'operator',
    }
    const env = authEnvFor('https://github.com/acme/widget.git', TOKEN, existing)

    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect(env.GIT_CONFIG_KEY_2).toBe('http.https://github.com/.extraheader')
    expect(env.GIT_CONFIG_VALUE_2).toBe(`AUTHORIZATION: basic ${B64}`)
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined()

    // 合并进子进程环境后，原有两项仍在
    const merged = { ...existing, ...env }
    expect(merged.GIT_CONFIG_COUNT).toBe('3')
    expect(merged.GIT_CONFIG_KEY_1).toBe('user.name')
  })

  it('非数字的既有 GIT_CONFIG_COUNT 按 0 处理', () => {
    const env = authEnvFor('https://github.com/acme/widget.git', TOKEN, {
      GIT_CONFIG_COUNT: 'oops',
    })
    expect(env.GIT_CONFIG_COUNT).toBe('1')
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
  })
})

describe('redactSecrets', () => {
  it('明文 token 与它的 base64 都被替换', () => {
    const text = `cmd http.header=AUTHORIZATION: basic ${B64}; token=${TOKEN}`
    const out = redactSecrets(text, gitAuthSecrets(TOKEN))
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(B64)
    expect(out).toBe('cmd http.header=AUTHORIZATION: basic ***; token=***')
  })

  it('Bearer <token> 形态只留下 ***，无关文本不变', () => {
    const text = `fatal: Authorization: Bearer ${TOKEN}\nremote: not found`
    const out = redactSecrets(text, gitAuthSecrets(TOKEN))
    expect(out).toBe('fatal: Authorization: Bearer ***\nremote: not found')
  })

  it('无凭据时原样返回；空 secret 不会破坏文本', () => {
    expect(redactSecrets('plain text', [])).toBe('plain text')
    expect(redactSecrets('plain text', [''])).toBe('plain text')
    expect(redactSecrets('plain text', ['', TOKEN])).toBe('plain text')
  })
})

describe('readTokenFromEnv', () => {
  it('KEEL_GITHUB_TOKEN 优先于 GITHUB_TOKEN', () => {
    const savedKeel = process.env.KEEL_GITHUB_TOKEN
    const savedGithub = process.env.GITHUB_TOKEN
    try {
      process.env.KEEL_GITHUB_TOKEN = 'keel-token'
      process.env.GITHUB_TOKEN = 'github-token'
      expect(readTokenFromEnv()).toBe('keel-token')
      delete process.env.KEEL_GITHUB_TOKEN
      expect(readTokenFromEnv()).toBe('github-token')
    } finally {
      if (savedKeel === undefined) delete process.env.KEEL_GITHUB_TOKEN
      else process.env.KEEL_GITHUB_TOKEN = savedKeel
      if (savedGithub === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = savedGithub
    }
  })
})
