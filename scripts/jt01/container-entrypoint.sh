#!/bin/sh
set -eu

[ -n "${HOME:-}" ] || { echo 'jt01: HOME 未设置' >&2; exit 1; }
case "${JT01_RUNNER:-pi-compat}" in
  pi-compat)
    [ -r "$HOME/.pi/agent/models.json" ] || { echo 'jt01: Pi home 未初始化' >&2; exit 1; }
    ;;
  native-omp)
    [ -r "$HOME/.omp/agent/models.yml" ] || { echo 'jt01: OMP home 未初始化（缺少 models.yml）' >&2; exit 1; }
    [ -r "$HOME/.omp/agent/config.yml" ] || { echo 'jt01: OMP home 未初始化（缺少 agent/config.yml）' >&2; exit 1; }
    [ -n "${JT01_OMP_CLI:-}" ] || { echo 'jt01: JT01_OMP_CLI 未设置' >&2; exit 1; }
    [ -r "$JT01_OMP_CLI" ] || { echo "jt01: 找不到 OMP CLI：$JT01_OMP_CLI" >&2; exit 1; }
    [ -x "$JT01_OMP_CLI" ] || { echo "jt01: OMP CLI 不可执行：$JT01_OMP_CLI" >&2; exit 1; }
    command -v bun >/dev/null 2>&1 || { echo 'jt01: PATH 中缺少 bun' >&2; exit 1; }
    ln -sf "$JT01_OMP_CLI" /usr/local/bin/omp || { echo 'jt01: 无法建立 omp symlink' >&2; exit 1; }
    ;;
  *)
    echo "jt01: 不支持的 runner：${JT01_RUNNER}" >&2
    exit 1
    ;;
esac

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
