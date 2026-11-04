#!/usr/bin/env node

/**
 * keel CLI 入口(issue #27)。
 *
 * 这个文件**只有入口职责**:读 `process.argv`、跑 `runCli`、把未捕获异常
 * 变成退出码。分发与连接池收口在 `run.ts` —— 那里可以脱离进程被 import 测试。
 *
 * 子命令清单见 `run.ts` 的 HELP。
 */

import { runCli } from './run.js'

runCli(process.argv.slice(2)).catch((e) => {
  console.error(`keel: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
