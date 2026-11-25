import { readFileSync } from 'node:fs'
import { TIMEOUT_STAGES, type TimeoutStage } from '../execution/model-routing.js'
import { HARNESS_IDS, type HarnessId, resolveHarness } from './run-task.js'

export interface ManagedHarnessRouting {
  readonly defaultHarness: HarnessId
  readonly stages: Readonly<Partial<Record<TimeoutStage, HarnessId>>>
}

const CONFIG_ENV = 'KEEL_MANAGED_HARNESS_ROUTING_FILE'

function defaultHarness(cli: string | undefined, env: NodeJS.ProcessEnv): HarnessId {
  const harness = resolveHarness(cli, env.KEEL_HARNESS)
  if (!harness.ok) throw new Error(harness.error.detail)
  return harness.value
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${CONFIG_ENV}: ${field} 必须是 JSON 对象`)
  return value as Record<string, unknown>
}

function harnessId(value: unknown, field: string): HarnessId {
  const harness = HARNESS_IDS.find((id) => id === value)
  if (harness === undefined)
    throw new Error(`${CONFIG_ENV}: ${field} 只接受 ${HARNESS_IDS.join(' | ')}`)
  return harness
}

export function loadManagedHarnessRouting(
  cli: string | undefined,
  env: NodeJS.ProcessEnv,
): ManagedHarnessRouting {
  const file = env[CONFIG_ENV]?.trim()
  if (cli !== undefined || file === undefined)
    return { defaultHarness: defaultHarness(cli, env), stages: {} }
  if (file === '') throw new Error(`${CONFIG_ENV} 不能为空`)

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${CONFIG_ENV} 无法读取有效的 JSON：${file}`)
  }
  const config = object(raw, '配置')
  for (const key of Object.keys(config)) {
    if (key !== 'default_harness' && key !== 'stage_harnesses')
      throw new Error(`${CONFIG_ENV}: 未知字段 ${key}`)
  }
  const stages: Partial<Record<TimeoutStage, HarnessId>> = {}
  if (config.stage_harnesses !== undefined) {
    for (const [key, value] of Object.entries(object(config.stage_harnesses, 'stage_harnesses'))) {
      const stage = TIMEOUT_STAGES.find((name) => name === key)
      if (stage === undefined) throw new Error(`${CONFIG_ENV}: 未知阶段 stage_harnesses.${key}`)
      stages[stage] = harnessId(value, `stage_harnesses.${stage}`)
    }
  }
  return {
    defaultHarness:
      config.default_harness === undefined
        ? defaultHarness(undefined, env)
        : harnessId(config.default_harness, 'default_harness'),
    stages,
  }
}
