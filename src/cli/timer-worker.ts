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
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'

export async function timerWorkerMain(argv: readonly string[]): Promise<void> {
  const { flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel timer-worker [--interval <ms>]

默认单次收割到期 timer;--interval <ms> 常驻循环(SIGTERM 退出)。
KEEL_HUMAN_REVIEW_TTL_H 控制 S-HUMAN_REVIEW 的超时自动弃单（小时，缺省 24；0 = 关闭；非法值启动即报错）。`)
    return
  }

  // 非法 KEEL_LIVENESS_MODE 在这里就拒绝启动,而不是每轮 drain 才抛
  const mode = livenessMode()
  const humanReviewTtl = resolveHumanReviewTtlMs(process.env.KEEL_HUMAN_REVIEW_TTL_H)
  if (!humanReviewTtl.ok) {
    console.error(`timer-worker: ${humanReviewTtl.error.detail}`)
    process.exitCode = 1
    return
  }
  const now = () => new Date().toISOString()
  const store = new LivenessStore()
  const deps = {
    driver: new WorkflowDriver(
      new RuleBasedPolicyEngine(DEFAULT_RULESET),
      undefined,
      undefined,
      humanReviewTtl.value,
    ),
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
        `timer-worker: clarificationFired=${stats.clarificationFired} ` +
          `humanReviewFired=${stats.humanReviewFired} runTimeout=${stats.runTimeout} ` +
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
