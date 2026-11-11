/** JT-07 试运行账本命令；只核算门槛，不修改授权或自动扩大范围。 */

import type { Result } from '../contracts/errors.js'
import type { TrialEvaluation } from '../control/trial.js'
import { readTrialStatus, startTrial, stopTrial } from '../control/trial-store.js'
import { parseArgs } from './argv.js'

type FlagValue = string | number | boolean

export interface TrialMainDeps {
  readonly now?: () => string
  readonly start?: typeof startTrial
  readonly stop?: typeof stopTrial
  readonly status?: (now: string) => Promise<Result<TrialEvaluation>>
}

const TRIAL_HELP = `用法:
  keel trial-start --projects <uuid,uuid> --confirm [--note TEXT]
  keel trial-status [--json] [--require-eligible]
  keel trial-stop --reason TEXT --confirm

试运行要求 2–3 个项目、连续 7 天、至少 30 个实际代决和 5 个完成任务。
trial-status 只说明是否达到最低复核门槛，不计算生产正确率，也不自动扩大授权。`

function noPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) throw new Error(`不接受位置参数：${positionals.join(' ')}`)
}

function allowedFlags(flags: Readonly<Record<string, FlagValue>>, names: readonly string[]): void {
  const allowed = new Set(names)
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) throw new Error(`未知选项：--${key}`)
  }
}

function requiredString(flags: Readonly<Record<string, FlagValue>>, name: string): string {
  const value = flags[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} 需要非空值`)
  return value.trim()
}

function optionalString(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} 需要非空值`)
  return value.trim()
}

function requireConfirm(flags: Readonly<Record<string, FlagValue>>): void {
  if (flags.confirm !== true) throw new Error('该命令需要显式 --confirm')
}

function projectIds(raw: string): string[] {
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (ids.length === 0) throw new Error('--projects 至少需要一个项目 ID')
  return ids
}

function assertResult<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.detail)
  return result.value
}

function printStatus(status: TrialEvaluation): void {
  if (status.trial === null) {
    console.log('keel trial: NOT_STARTED（没有试运行记录）')
    return
  }
  console.log(
    `keel trial: ${status.state} ${status.trial.id} ` +
      `days=${status.elapsed_days}/${status.thresholds.duration.required_days} ` +
      `delegated=${status.metrics.delegated_decisions}/${status.thresholds.delegated_decisions.required} ` +
      `completed=${status.metrics.completed_tasks}/${status.thresholds.completed_tasks.required} ` +
      `eligible=${status.eligible_for_owner_review}`,
  )
  for (const project of status.metrics.by_project) {
    console.log(
      `- ${project.remote_url}: delegated=${project.delegated_decisions} ` +
        `completed=${project.completed_tasks}`,
    )
  }
  for (const note of status.notes) console.log(`note: ${note}`)
}

export async function trialMain(argv: readonly string[], deps: TrialMainDeps = {}): Promise<void> {
  try {
    const [command, ...rest] = argv
    if (command === undefined || command === '--help' || command === '-h') {
      console.log(TRIAL_HELP)
      return
    }
    const now = deps.now ?? (() => new Date().toISOString())
    const { positionals, flags } = parseArgs(rest)
    noPositionals(positionals)
    if (flags.help === true) {
      console.log(TRIAL_HELP)
      return
    }

    switch (command) {
      case 'trial-start': {
        allowedFlags(flags, ['projects', 'note', 'confirm'])
        requireConfirm(flags)
        const note = optionalString(flags, 'note')
        const id = assertResult(
          await (deps.start ?? startTrial)({
            projectIds: projectIds(requiredString(flags, 'projects')),
            now: now(),
            ...(note === undefined ? {} : { note }),
          }),
        )
        console.log(`trial started: ${id}`)
        return
      }
      case 'trial-stop': {
        allowedFlags(flags, ['reason', 'confirm'])
        requireConfirm(flags)
        const id = assertResult(
          await (deps.stop ?? stopTrial)(now(), requiredString(flags, 'reason')),
        )
        console.log(`trial stopped: ${id}`)
        return
      }
      case 'trial-status': {
        allowedFlags(flags, ['json', 'require-eligible'])
        const status = assertResult(await (deps.status ?? readTrialStatus)(now()))
        if (flags.json === true) console.log(JSON.stringify(status, null, 2))
        else printStatus(status)
        if (flags['require-eligible'] === true && !status.eligible_for_owner_review) {
          process.exitCode = 1
        }
        return
      }
      default:
        throw new Error(`未知 trial 子命令：${command}`)
    }
  } catch (error) {
    console.error(`trial: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
