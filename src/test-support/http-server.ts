import { mkdtemp, rm } from 'node:fs/promises'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试 HTTP 只走临时目录的 Unix socket，保留真实请求/鉴权处理，
 * 不要求执行沙箱开放 TCP 监听或访问宿主回环服务。
 */
export async function listenTestServer(server: Server): Promise<{
  readonly baseUrl: string
  readonly fetch: typeof fetch
  close(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'http-'))
  const socketPath = join(root, 's')
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const baseUrl = 'http://127.0.0.1'
  const localFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init)
    const url = new URL(incoming.url)
    if (url.origin !== baseUrl) throw new Error(`测试请求不属于当前 HTTP 夹具：${url.origin}`)
    const body = Buffer.from(await incoming.arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      const pending = request(
        {
          socketPath,
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: incoming.method,
          headers: Object.fromEntries(incoming.headers),
          signal: incoming.signal,
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('error', reject)
          response.on('end', () => {
            const headers: [string, string][] = []
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              const key = response.rawHeaders[i]
              const value = response.rawHeaders[i + 1]
              if (key !== undefined && value !== undefined) headers.push([key, value])
            }
            const status = response.statusCode ?? 500
            resolve(
              new Response(
                [204, 205, 304].includes(status) || incoming.method === 'HEAD'
                  ? null
                  : new Uint8Array(Buffer.concat(chunks)),
                { status, headers },
              ),
            )
          })
        },
      )
      pending.on('error', reject)
      pending.end(body)
    })
  }
  return {
    baseUrl,
    fetch: localFetch,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
        server.closeAllConnections()
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}
