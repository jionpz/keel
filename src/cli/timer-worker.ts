/**
 * keel timer-worker —— 到期收割(issue #27)。
 *
 * 默认单次 drain;--interval <ms> 常驻(SIGTERM 优雅退出)。
 */

import { WorkflowDriver } from '../control/driver/driver.js'
import { livenessMode } from '../control/liveness/policy.js'
import { LivenessStore } from '../control/liveness/store.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { drainAllDueTimers, runForever } from '../timer/worker.js'
import { parseArgs } from './argv.js'

export async function timerWorkerMain(argv: readonly string[]): Promise<void> {
  const { flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel timer-worker [--interval <ms>]

默认单次收割到期 timer;--interval <ms> 常驻循环(SIGTERM 退出)。`)
    return
  }

  // 非法 KEEL_LIVENESS_MODE 在这里就拒绝启动,而不是每轮 drain 才抛
  const mode = livenessMode()
  const now = () => new Date().toISOString()
  const store = new LivenessStore()
  const deps = {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    now,
    store,
  }

  const interval =
    typeof flags.interval === 'number'
      ? flags.interval
      : typeof flags.interval === 'string'
        ? Number(flags.interval)
        : undefined

  try {
    if (interval === undefined || Number.isNaN(interval)) {
      const stats = await drainAllDueTimers(deps)
      console.log(
        `timer-worker: clarificationFired=${stats.clarificationFired} runTimeout=${stats.runTimeout} ` +
          `skipped=${stats.skipped} patrol(reaped=${stats.patrol.reaped}, killed=${stats.patrol.orphansKilled}, ` +
          `errors=${stats.patrol.errors}) liveness=${mode}`,
      )
      return
    }

    console.log(`timer-worker: 常驻循环, interval=${interval}ms, liveness=${mode} (SIGTERM 退出)`)
    await runForever(deps, { intervalMs: interval })
  } finally {
    await store.close()
  }
}
