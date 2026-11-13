import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { listenTestServer } from './http-server.js'

describe('Unix HTTP 测试夹具', () => {
  it('真实传送方法、请求体、鉴权头与响应 Cookie，拒绝转向宿主或外部服务', async () => {
    const http = await listenTestServer(
      createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          res.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2; SameSite=Strict'])
          res.end(
            JSON.stringify({
              method: req.method,
              path: req.url,
              token: req.headers.authorization,
              body: Buffer.concat(chunks).toString(),
            }),
          )
        })
      }),
    )
    try {
      const response = await http.fetch(`${http.baseUrl}/test?q=1`, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture' },
        body: 'payload',
      })
      expect(await response.json()).toEqual({
        method: 'POST',
        path: '/test?q=1',
        token: 'Bearer fixture',
        body: 'payload',
      })
      expect(response.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2; SameSite=Strict'])
      await expect(http.fetch('http://127.0.0.1:3425/')).rejects.toThrow('不属于')
      await expect(http.fetch('https://example.invalid/')).rejects.toThrow('不属于')
    } finally {
      await http.close()
    }
  })
})
