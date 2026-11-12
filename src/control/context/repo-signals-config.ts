import { err, makeError, ok, type Result } from '../../contracts/errors.js'

export interface RepoSignalsConfig {
  readonly sinceDays: number
  readonly maxTokens: number
}

const DEFAULT_SINCE_DAYS = 14
const DEFAULT_MAX_TOKENS = 1_200

/**
 * `repo_signals` 的预算配置。
 *
 * 与 `KEEL_HUMAN_REVIEW_TTL_H` 同一条纪律：拼错的值启动即报错，
 * 不静默回退默认值 —— 否则「我明明调大了 token 上限」会变成假事实。
 */
export function resolveRepoSignalsConfig(
  env: NodeJS.ProcessEnv = process.env,
): Result<RepoSignalsConfig> {
  const sinceDays = parseInteger(
    env.KEEL_REPO_SIGNALS_DAYS,
    'KEEL_REPO_SIGNALS_DAYS',
    DEFAULT_SINCE_DAYS,
    1,
    365,
  )
  if (!sinceDays.ok) return sinceDays
  const maxTokens = parseInteger(
    env.KEEL_REPO_SIGNALS_MAX_TOKENS,
    'KEEL_REPO_SIGNALS_MAX_TOKENS',
    DEFAULT_MAX_TOKENS,
    100,
    8_000,
  )
  if (!maxTokens.ok) return maxTokens
  return ok({ sinceDays: sinceDays.value, maxTokens: maxTokens.value })
}

function parseInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): Result<number> {
  if (raw === undefined) return ok(fallback)
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    return err(makeError('WORKSPACE_ERROR', `${name}=${raw} 非法：必须是 ${min}–${max} 的整数`))
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return err(makeError('WORKSPACE_ERROR', `${name}=${raw} 非法：必须是 ${min}–${max} 的整数`))
  }
  return ok(value)
}
