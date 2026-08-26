#!/usr/bin/env node

/**
 * keel CLI 入口(issue #27)。
 *
 * 子命令:
 *   timer-worker [--interval <ms>]  到期收割(单次/常驻)
 *   run-task <taskId> [--max-steps N] [--ci passed|failed]
 *   status <taskId> [--events N]
 */

import { runTaskMain } from './run-task.js'
import { statusMain } from './status.js'
import { timerWorkerMain } from './timer-worker.js'

const VERSION = '0.1.0'

const HELP = `keel — AI Engineering Runtime CLI

用法:
  keel <command> [args]

命令:
  timer-worker [--interval <ms>]   到期收割 timer(默认单次;--interval 常驻)
  run-task <taskId> [--max-steps N] [--ci passed|failed]   驱动单 task 到终态
  status <taskId> [--events N]     查 task / run / 事件摘要

选项:
  --help, -h   显示帮助
  --version    显示版本
`

function usage(): void {
  console.log(HELP)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)

  switch (command) {
    case 'timer-worker':
      await timerWorkerMain(rest)
      return
    case 'run-task':
      await runTaskMain(rest)
      return
    case 'status':
      await statusMain(rest)
      return
    case '--version':
    case '-v':
      console.log(`keel ${VERSION}`)
      return
    case '--help':
    case '-h':
    case undefined:
      usage()
      return
    default:
      console.error(`未知命令: ${command}`)
      usage()
      process.exitCode = 2
  }
}

main().catch((e) => {
  console.error(`keel: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
