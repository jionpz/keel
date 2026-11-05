/**
 * `KEEL_HUMAN_REVIEW_TTL_H` 的 CLI 侧解析。
 *
 * `src/shared/timers.ts` 的 `parseHumanReviewTtlHours` 是纯函数、非法值直接 throw；
 * 这里把异常翻译成 `Result`，让四个入口（run-task / run-issue / timer-worker /
 * decide）用同一种方式在**任何数据库动作之前**失败 —— 与 `--ci` / `--harness` /
 * `KEEL_LIVENESS_MODE` 同一条纪律：拼错的值不静默回退。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { parseHumanReviewTtlHours } from '../shared/timers.js'

/**
 * 解析环境变量并换算成毫秒。
 *
 * - `undefined` → `ok(24h)`
 * - `'0'` → `ok(null)`（关闭调度）
 * - 非法 → `err(CAPABILITY_UNSUPPORTED)`，文案点名变量与收到的值
 */
export function resolveHumanReviewTtlMs(raw: string | undefined): Result<number | null> {
  try {
    const hours = parseHumanReviewTtlHours(raw)
    return ok(hours === null ? null : hours * 3600 * 1000)
  } catch (error) {
    return err(
      makeError('CAPABILITY_UNSUPPORTED', error instanceof Error ? error.message : String(error)),
    )
  }
}
