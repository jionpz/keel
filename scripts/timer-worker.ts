/**
 * 独立 timer worker 启动示例(issue #26)。
 *
 * 用途:独立进程定期 drain timer 表,收割到期澄清与 run 超时,
 * 不依赖编排进程存活(进程崩溃恢复)。
 *
 * 运行:
 *   KEEL_DATABASE_URL=... pnpm tsx scripts/timer-worker.ts [--interval 5000]
 *
 * 默认单次 drain(--once);加 --interval <ms> 常驻循环,SIGTERM 优雅退出。
 * 接入层(未来 daemon/CLI)负责监督重启。
 */

import { WorkflowDriver } from '../src/control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../src/control/policy/engine.js'
import { DEFAULT_RULESET } from '../src/control/policy/ruleset.js'
import { drainAllDueTimers, runForever } from '../src/timer/worker.js'

const args = process.argv.slice(2)
const intervalIdx = args.indexOf('--interval')
const intervalMs =
  intervalIdx !== -1 && args[intervalIdx + 1] !== undefined
    ? Number(args[intervalIdx + 1])
    : undefined

const deps = {
  driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
  now: () => new Date().toISOString(),
}

async function main(): Promise<void> {
  if (intervalMs === undefined || Number.isNaN(intervalMs)) {
    // 单次 drain(供 cron / 手动触发)
    const stats = await drainAllDueTimers(deps)
    console.log(
      `timer-worker: clarificationFired=${stats.clarificationFired} runTimeout=${stats.runTimeout} skipped=${stats.skipped}`,
    )
    return
  }
  console.log(`timer-worker: 常驻循环, interval=${intervalMs}ms (SIGTERM 退出)`)
  await runForever(deps, { intervalMs })
}

main().catch((e) => {
  console.error('timer-worker 失败:', e)
  process.exitCode = 1
})
