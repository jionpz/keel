/**
 * keel timer-worker —— 到期收割(issue #27)。
 *
 * 默认单次 drain;--interval <ms> 常驻(SIGTERM 优雅退出)。
 *
 * 单实例约束：同一个数据库只允许一个 timer-worker，用 PostgreSQL 会话级
 * advisory lock 强制（见 `src/fact/resident-lock.ts`）。单次收割也持锁 ——
 * 它和常驻实例并发会重复收割、重复投递 `RunStalled`。
 */

import { WorkflowDriver } from '../control/driver/driver.js'
import { livenessMode } from '../control/liveness/policy.js'
import { LivenessStore } from '../control/liveness/store.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { acquireResidentLock, lockErrorMessage, type ResidentLock } from '../fact/resident-lock.js'
import { drainAllDueTimers, type ReapStats, runForever, type WorkerDeps } from '../timer/worker.js'
import { parseArgs } from './argv.js'
import { resolveHumanReviewTtlMs } from './human-review-ttl.js'

export interface TimerWorkerMainDeps {
  /**
   * 单实例锁；测试注入后不碰真实数据库锁。
   * 返回 `null` 表示同库已有 timer-worker 在运行（明确的启动失败，不等待）。
   */
  readonly acquireLock?: () => Promise<ResidentLock | null>
  /** 测试注入；缺省 `drainAllDueTimers` */
  readonly drain?: (deps: WorkerDeps) => Promise<ReapStats>
  /** 测试注入；缺省 `runForever` */
  readonly run?: (deps: WorkerDeps, opts: { intervalMs: number }) => Promise<void>
}

export async function timerWorkerMain(
  argv: readonly string[],
  deps: TimerWorkerMainDeps = {},
): Promise<void> {
  const { flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(`用法: keel timer-worker [--interval <ms>]

默认单次收割到期 timer;--interval <ms> 常驻循环(SIGTERM 退出)。
同一数据库只允许一个 timer-worker(单次收割也持锁);poller 与它互不阻塞。
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

  // 锁在创建 store / 连接数据库之前获取：第二个实例不应产生任何收割副作用。
  // 锁是会话级的：正常退出显式释放，kill -9 / 掉电由 PostgreSQL 自动释放。
  let lock: ResidentLock | null
  try {
    lock = await (deps.acquireLock ?? (() => acquireResidentLock('timer-worker')))()
  } catch (e) {
    console.error(`timer-worker: 无法获取单实例锁：${lockErrorMessage(e)}`)
    process.exitCode = 1
    return
  }
  if (lock === null) {
    console.error('timer-worker: 已有实例在运行（同一数据库）；单次收割也持锁，请先停常驻实例。')
    process.exitCode = 1
    return
  }

  const now = () => new Date().toISOString()
  let store: LivenessStore | undefined

  try {
    store = new LivenessStore()
    const workerDeps: WorkerDeps = {
      driver: new WorkflowDriver(
        new RuleBasedPolicyEngine(DEFAULT_RULESET),
        undefined,
        undefined,
        humanReviewTtl.value,
      ),
      now,
      store,
      // 与 driver 同源：只解析一次 env，两处用同一个值
      humanReviewTtlMs: humanReviewTtl.value,
    }

    const interval =
      typeof flags.interval === 'number'
        ? flags.interval
        : typeof flags.interval === 'string'
          ? Number(flags.interval)
          : undefined

    if (interval === undefined || Number.isNaN(interval)) {
      const stats = await (deps.drain ?? drainAllDueTimers)(workerDeps)
      console.log(
        `timer-worker: clarificationFired=${stats.clarificationFired} ` +
          `humanReviewFired=${stats.humanReviewFired} ` +
          `humanReviewArmed=${stats.humanReviewArmed} runTimeout=${stats.runTimeout} ` +
          `skipped=${stats.skipped} patrol(reaped=${stats.patrol.reaped}, killed=${stats.patrol.orphansKilled}, ` +
          `errors=${stats.patrol.errors}) liveness=${mode}`,
      )
      return
    }

    console.log(`timer-worker: 常驻循环, interval=${interval}ms, liveness=${mode} (SIGTERM 退出)`)
    await (deps.run ?? runForever)(workerDeps, { intervalMs: interval })
  } finally {
    // 先关 store 再放锁；store.close() 抛错不能跳过 release（嵌套 try/finally）。
    try {
      if (store !== undefined) await store.close()
    } finally {
      await lock.release().catch(() => undefined)
    }
  }
}
