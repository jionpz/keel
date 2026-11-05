/**
 * 执行面模型路由 —— profile / 阶段表 / 解析。
 *
 * 事实来源：`.trellis/tasks/11-03-execution-model-routing/design.md` §1。
 *
 * 这里是 profile 与阶段表的**唯一**一处定义（R4）：adapter / CLI / 编排器
 * 都从这里取，不允许在别处复制一份 —— 两份定义会在某次改动后悄悄漂移，
 * 表现是「某个阶段实际跑的模型与清单不符」。
 *
 * 只放模型 id，不放企业网关地址 / 密钥：那由部署方通过 harness 配置注入。
 */

import { err, makeError, ok, type Result } from '../contracts/errors.js'
import { STAGES, type Stage } from '../shared/ids.js'

export const MODEL_PROFILES = ['default', 'enterprise'] as const
export type ModelProfile = (typeof MODEL_PROFILES)[number]

/**
 * omp 的缺省模型（github.com 时期的五连基线）。
 *
 * 唯一字面量在本文件；`adapters/omp.ts` 只 re-export。
 * 放到路由模块而不是 adapter 里，是因为「缺省」也是优先级链的一环 ——
 * 它必须和 profile / allowlist 一起被同一个函数裁决。
 */
export const DEFAULT_OMP_MODEL = 'deepseek-v4-flash'

/**
 * 企业内推理网关的阶段目录（R2）。
 *
 * develop / qa / review 要读改代码，用代码能力更强的模型；
 * 其余阶段偏分析与写作，用另一个目录。
 */
export const ENTERPRISE_STAGE_MODELS: Readonly<Record<Stage, string>> = {
  pm: 'zai-org/GLM-5.3',
  brainstorm: 'zai-org/GLM-5.3',
  critic: 'zai-org/GLM-5.3',
  rfc_draft: 'zai-org/GLM-5.3',
  develop: 'moonshotai/Kimi-K3',
  qa: 'moonshotai/Kimi-K3',
  review: 'moonshotai/Kimi-K3',
}

/**
 * `KEEL_MODEL_PROFILE` → `ModelProfile`。未设置 = `default`。
 *
 * 拼错的值必须拒绝，不能静默退回 `default` —— 否则使用者会以为企业网关目录
 * 已经生效，实际所有阶段仍在跑缺省模型，且没有任何一处报错。
 */
export function parseProfile(raw: string | undefined): Result<ModelProfile> {
  if (raw === undefined) return ok('default')
  const trimmed = raw.trim()
  const found = MODEL_PROFILES.find((profile) => profile === trimmed)
  if (found === undefined) {
    const shown = trimmed === '' ? '（空）' : trimmed
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_PROFILE=${shown} 非法：只接受 ${MODEL_PROFILES.join(' | ')}。` +
          '拼错的取值不能静默退回 default。',
      ),
    )
  }
  return ok(found)
}

/**
 * `KEEL_MODEL_ALLOWLIST` → 允许的模型清单。未设置 = 不校验。
 *
 * 空项拒绝：`a,,b` 多半是拼写事故；静默跳过会让清单比写的人以为的更宽松，
 * 最终某个本不该跑的模型被放行。
 */
export function parseAllowlist(raw: string | undefined): Result<readonly string[]> {
  if (raw === undefined) return ok([])
  const items = raw.split(',').map((item) => item.trim())
  const emptyAt = items.indexOf('')
  if (emptyAt >= 0) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `KEEL_MODEL_ALLOWLIST 必须是逗号分隔的非空模型 id，第 ${emptyAt + 1} 项为空。` +
          '空项不会静默忽略。',
      ),
    )
  }
  return ok(items)
}

export interface StageModelInput {
  readonly stage: Stage
  /**
   * `--model` / `KEEL_MODEL` 合并后的**显式**覆盖；undefined = 未指定。
   * 不含缺省 —— 缺省由本函数按 profile 补齐，否则 profile 永远轮不到生效。
   */
  readonly override?: string | undefined
  readonly profile: ModelProfile
  /** 非空时最终值必须命中，否则拒绝（R6） */
  readonly allowlist?: readonly string[]
}

/**
 * 解析一个 stage 最终要 spawn 的模型。
 *
 * 优先级（R3）：`override` > profile 阶段表 > `DEFAULT_OMP_MODEL`。
 *
 * 返回值同时用于 spawn argv 与 `run.requested_model` —— 调用方不得各算一次，
 * 否则会出现「库里记 A、实际跑 B」而两边都自洽的假象（R5）。
 */
export function resolveStageModel(input: StageModelInput): Result<string> {
  const override = input.override?.trim()
  if (input.override !== undefined && override === '') {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        '模型覆盖为空。空白值不会静默回退到 profile 或缺省模型，拒绝。',
      ),
    )
  }

  const model =
    override !== undefined && override !== ''
      ? override
      : input.profile === 'enterprise'
        ? ENTERPRISE_STAGE_MODELS[input.stage]
        : DEFAULT_OMP_MODEL

  const allowlist = input.allowlist ?? []
  if (allowlist.length > 0 && !allowlist.includes(model)) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `模型 ${model}（stage=${input.stage}，profile=${input.profile}）不在 ` +
          `KEEL_MODEL_ALLOWLIST 内：${allowlist.join(', ')}。` +
          '不允许静默回退到清单内其它模型。',
      ),
    )
  }

  return ok(model)
}

export interface RoutingPreflightInput {
  /** 目标 harness；`omp` 按 profile 阶段表展开，其余只校验显式模型 */
  readonly harnessId: string
  readonly profile: ModelProfile
  /** 空清单 = 不校验 */
  readonly allowlist: readonly string[]
  /** 显式 `--model` / `KEEL_MODEL` 合并后的值；undefined = 未指定 */
  readonly override?: string | undefined
}

/**
 * 启动期预检：allowlist 必须覆盖本次调用可能 spawn 的**全部**模型。
 *
 * 单个 run 会跨多个 stage（pm → … → review 都可能发生）。若把校验留到认领后
 * 逐 stage 解析，`run-issue` / `poller` 已经先 ingest 并写了 feedback / task，
 * 于是「配置根本不可能成功」却留下了一条驱动不了的记录。
 *
 * omp 用**同一个** `resolveStageModel` 把所有阶段推演一遍，避免预检与运行时
 * 各有一套优先级；claude 不按 profile 路由（R7），只在显式模型上应用清单。
 */
export function preflightModelRouting(input: RoutingPreflightInput): Result<void> {
  if (input.allowlist.length === 0) return ok(undefined)

  if (input.harnessId === 'omp') {
    for (const stage of STAGES) {
      const resolved = resolveStageModel({
        stage,
        profile: input.profile,
        ...(input.override === undefined ? {} : { override: input.override }),
        allowlist: input.allowlist,
      })
      if (!resolved.ok) return resolved
    }
    return ok(undefined)
  }

  // 非 omp：只有显式模型会进 argv（claude 未指定时根本不传 --model）。
  if (input.override === undefined) return ok(undefined)
  const model = input.override.trim()
  if (!input.allowlist.includes(model)) {
    return err(
      makeError(
        'CAPABILITY_UNSUPPORTED',
        `模型 ${model} 不在 KEEL_MODEL_ALLOWLIST 内：${input.allowlist.join(', ')}。` +
          '显式模型同样受清单约束，不允许静默忽略。',
      ),
    )
  }
  return ok(undefined)
}
