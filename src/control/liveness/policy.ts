/**
 * 每 stage 的 liveness 策略 —— 常量集中在 Control Plane。
 *
 * 阈值来源：`docs/archive/tasks/2026-11/11-04-run-liveness-patrol/prd.md` R6。
 * `silenceMs` 是「多久没有新进展算卡死」；`hardCapS` 是显式预算上限，
 * 不是 liveness 判据。`develop` 的 12h 覆盖合法的 10h 级长任务。
 */

import type { Stage } from '../../shared/ids.js'

export interface LivenessPolicy {
  /** null = 不做沉默判定（human / 无进展信号） */
  readonly silenceMs: number | null
  /** null = 不设默认硬上限（human） */
  readonly hardCapS: number | null
}

const MINUTE = 60_000

export const LIVENESS_POLICY: Readonly<Record<Stage, LivenessPolicy>> = {
  pm: { silenceMs: 5 * MINUTE, hardCapS: 30 * 60 },
  brainstorm: { silenceMs: 10 * MINUTE, hardCapS: 2 * 60 * 60 },
  critic: { silenceMs: 10 * MINUTE, hardCapS: 2 * 60 * 60 },
  rfc_draft: { silenceMs: 10 * MINUTE, hardCapS: 2 * 60 * 60 },
  develop: { silenceMs: 20 * MINUTE, hardCapS: 12 * 60 * 60 },
  qa: { silenceMs: 10 * MINUTE, hardCapS: 2 * 60 * 60 },
  review: { silenceMs: 10 * MINUTE, hardCapS: 2 * 60 * 60 },
}

/** human 不参与沉默判定，也没有默认硬上限 */
export const HUMAN_POLICY: LivenessPolicy = { silenceMs: null, hardCapS: null }

/** 无 CAP-STREAM：拿不到进展信号，只能退回硬上限 */
export function withoutProgressSignal(policy: LivenessPolicy): LivenessPolicy {
  return { silenceMs: null, hardCapS: policy.hardCapS }
}

export interface PolicyInput {
  readonly stage: Stage
  readonly isHuman: boolean
  readonly hasProgressSignal: boolean
}

export function policyFor(input: PolicyInput): LivenessPolicy {
  if (input.isHuman) return HUMAN_POLICY
  const base = LIVENESS_POLICY[input.stage]
  return input.hasProgressSignal ? base : withoutProgressSignal(base)
}

/**
 * 设计文档里的 `progressSource` 是 `silenceMs` 的派生视图：
 * 没有沉默阈值就等于没有进展信号。不额外存一份，避免两处说法漂移。
 */
export function progressSourceOf(policy: LivenessPolicy): 'stream' | 'none' {
  return policy.silenceMs === null ? 'none' : 'stream'
}

export const LIVENESS_MODES = ['progress', 'wallclock'] as const
export type LivenessMode = (typeof LIVENESS_MODES)[number]

/** `wallclock` 模式沿用改造前的全局上限（秒） */
export const LEGACY_WALLCLOCK_S = 180

/**
 * `KEEL_LIVENESS_MODE` 解析。非法值启动失败，不静默回退 ——
 * 静默回退会让一次拼写错误悄悄关掉整个巡检语义。
 */
export function livenessMode(env: NodeJS.ProcessEnv = process.env): LivenessMode {
  const raw = env.KEEL_LIVENESS_MODE
  if (raw === undefined || raw === '') return 'progress'
  if (raw === 'progress' || raw === 'wallclock') return raw
  throw new Error(`KEEL_LIVENESS_MODE=${raw} 非法：只接受 progress | wallclock`)
}

/**
 * run 的墙钟上限（秒）。优先级：显式 `--wall-clock` > 模式默认 > stage 策略。
 *
 * - `wallclock` 模式保持改造前的全局 180s，行为与旧版本一致；
 * - `progress` 模式用 stage 硬上限（human / 无默认值为 0 = 不挂 timer）；
 * - 显式值覆盖所有 stage 上限，是长任务的逃生阀。
 */
export function runWallClockS(
  mode: LivenessMode,
  explicitWallClockS: number | undefined,
  policy: LivenessPolicy,
): number {
  if (explicitWallClockS !== undefined) return explicitWallClockS
  if (mode === 'wallclock') return LEGACY_WALLCLOCK_S
  return policy.hardCapS ?? 0
}
