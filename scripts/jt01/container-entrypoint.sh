#!/bin/sh
set -eu

[ -n "${HOME:-}" ] || { echo 'jt01: HOME 未设置' >&2; exit 1; }
[ -r "$HOME/.pi/agent/models.json" ] || { echo 'jt01: Pi home 未初始化' >&2; exit 1; }

exec node -e '
const net = require("node:net")

const LISTEN_HOST = "127.0.0.1"
const PORT = 3425
const UPSTREAM_HOST = "host.docker.internal"

const server = net.createServer((client) => {
  const upstream = net.connect(PORT, UPSTREAM_HOST)
  const closeBoth = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on("error", closeBoth)
  upstream.on("error", closeBoth)
  client.on("close", () => upstream.destroy())
  upstream.on("close", () => client.destroy())
  client.pipe(upstream)
  upstream.pipe(client)
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

server.on("error", (error) => {
  console.error(`jt01: 网关转发失败：${error.message}`)
  process.exit(1)
})

server.listen(PORT, LISTEN_HOST, () => {
  console.error(`jt01: 转发 ${LISTEN_HOST}:${PORT} -> ${UPSTREAM_HOST}:${PORT}`)
})
'
