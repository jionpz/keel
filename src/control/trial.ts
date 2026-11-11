/**
 * JT-07 试运行门槛（纯计算）。
 *
 * 门槛只回答“是否已经有足够真实样本供 owner 复核”，不回答“代决正确率”。
 * 满足门槛也不会自动扩大授权；输出刻意使用 eligible_for_owner_review，
 * 避免把 7 天 / 30 次代决误写成“生产验收通过”。
 */

export const TRIAL_MIN_PROJECTS = 2
export const TRIAL_MAX_PROJECTS = 3
export const TRIAL_REQUIRED_DAYS = 7
export const TRIAL_REQUIRED_DELEGATED_DECISIONS = 30
export const TRIAL_REQUIRED_COMPLETED_TASKS = 5

const DAY_MS = 24 * 60 * 60 * 1000

export interface TrialProjectMetrics {
  readonly project_id: string
  readonly remote_url: string
  readonly delegated_decisions: number
  readonly human_confirmed_decisions: number
  readonly owner_required_decisions: number
  readonly denied_decisions: number
  readonly completed_tasks: number
}

export interface TrialMetrics {
  readonly delegated_decisions: number
  readonly human_confirmed_decisions: number
  readonly owner_required_decisions: number
  readonly denied_decisions: number
  readonly completed_tasks: number
  readonly open_questions: number
  readonly uncertain_actions: number
  readonly dead_letter_actions: number
  readonly by_project: readonly TrialProjectMetrics[]
}

export interface TrialThreshold {
  readonly required: number
  readonly actual: number
  readonly met: boolean
  readonly remaining: number
}

export interface TrialEvaluation {
  readonly format: 'keel-trial-status/v1'
  readonly observed_at: string
  readonly state: 'NOT_STARTED' | 'RUNNING' | 'STOPPED'
  readonly eligible_for_owner_review: boolean
  readonly trial: {
    readonly id: string
    readonly started_at: string
    readonly ended_at: string | null
    readonly stop_reason: string | null
    readonly note: string | null
    readonly project_ids: readonly string[]
  } | null
  readonly elapsed_ms: number
  readonly elapsed_days: number
  readonly thresholds: {
    readonly duration: TrialThreshold & { readonly required_days: number }
    readonly delegated_decisions: TrialThreshold
    readonly completed_tasks: TrialThreshold
  }
  readonly metrics: TrialMetrics
  readonly notes: readonly string[]
}

export interface EvaluateTrialInput {
  readonly observed_at: string
  readonly trial: TrialEvaluation['trial']
  readonly metrics: TrialMetrics
}

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是非负安全整数`)
  return value
}

function threshold(required: number, actual: number): TrialThreshold {
  return {
    required,
    actual,
    met: actual >= required,
    remaining: Math.max(0, required - actual),
  }
}

function normalizedMetrics(metrics: TrialMetrics): TrialMetrics {
  return {
    delegated_decisions: integer(metrics.delegated_decisions, 'delegated_decisions'),
    human_confirmed_decisions: integer(
      metrics.human_confirmed_decisions,
      'human_confirmed_decisions',
    ),
    owner_required_decisions: integer(metrics.owner_required_decisions, 'owner_required_decisions'),
    denied_decisions: integer(metrics.denied_decisions, 'denied_decisions'),
    completed_tasks: integer(metrics.completed_tasks, 'completed_tasks'),
    open_questions: integer(metrics.open_questions, 'open_questions'),
    uncertain_actions: integer(metrics.uncertain_actions, 'uncertain_actions'),
    dead_letter_actions: integer(metrics.dead_letter_actions, 'dead_letter_actions'),
    by_project: metrics.by_project.map((project) => ({
      project_id: project.project_id,
      remote_url: project.remote_url,
      delegated_decisions: integer(project.delegated_decisions, 'project delegated_decisions'),
      human_confirmed_decisions: integer(
        project.human_confirmed_decisions,
        'project human_confirmed_decisions',
      ),
      owner_required_decisions: integer(
        project.owner_required_decisions,
        'project owner_required_decisions',
      ),
      denied_decisions: integer(project.denied_decisions, 'project denied_decisions'),
      completed_tasks: integer(project.completed_tasks, 'project completed_tasks'),
    })),
  }
}

export function evaluateTrial(input: EvaluateTrialInput): TrialEvaluation {
  const observedAt = Date.parse(input.observed_at)
  if (!Number.isFinite(observedAt)) throw new Error('observed_at 不是合法时间')
  const metrics = normalizedMetrics(input.metrics)
  if (input.trial === null) {
    return {
      format: 'keel-trial-status/v1',
      observed_at: input.observed_at,
      state: 'NOT_STARTED',
      eligible_for_owner_review: false,
      trial: null,
      elapsed_ms: 0,
      elapsed_days: 0,
      thresholds: {
        duration: { ...threshold(TRIAL_REQUIRED_DAYS, 0), required_days: TRIAL_REQUIRED_DAYS },
        delegated_decisions: threshold(
          TRIAL_REQUIRED_DELEGATED_DECISIONS,
          metrics.delegated_decisions,
        ),
        completed_tasks: threshold(TRIAL_REQUIRED_COMPLETED_TASKS, metrics.completed_tasks),
      },
      metrics,
      notes: ['尚未开始试运行；此状态没有生产准入含义。'],
    }
  }

  const startedAt = Date.parse(input.trial.started_at)
  if (!Number.isFinite(startedAt)) throw new Error('trial.started_at 不是合法时间')
  const endedAt = input.trial.ended_at === null ? null : Date.parse(input.trial.ended_at)
  if (endedAt !== null && !Number.isFinite(endedAt)) throw new Error('trial.ended_at 不是合法时间')
  if (endedAt !== null && endedAt < startedAt) throw new Error('trial 结束时间早于开始时间')
  const elapsedMs = Math.max(0, (endedAt ?? observedAt) - startedAt)
  const elapsedDays = Math.floor(elapsedMs / DAY_MS)
  const state = endedAt === null ? 'RUNNING' : 'STOPPED'
  const duration = {
    ...threshold(TRIAL_REQUIRED_DAYS, elapsedDays),
    required_days: TRIAL_REQUIRED_DAYS,
  }
  const delegated = threshold(TRIAL_REQUIRED_DELEGATED_DECISIONS, metrics.delegated_decisions)
  const completed = threshold(TRIAL_REQUIRED_COMPLETED_TASKS, metrics.completed_tasks)
  const eligible =
    state === 'RUNNING' &&
    duration.met &&
    delegated.met &&
    completed.met &&
    input.trial.project_ids.length >= TRIAL_MIN_PROJECTS

  const notes: string[] = []
  if (eligible) {
    notes.push(
      '已达到最低时间与样本门槛，仅供 owner 抽样复核；不等同生产正确率，也不自动扩大授权。',
    )
  } else if (state === 'STOPPED') {
    notes.push('试运行已停止；停止后的样本不能通过连续试运行门槛，需要重新开始一轮。')
  } else {
    notes.push('样本或时间尚未达到最低门槛；继续观察，不按日期自动扩权。')
  }
  if (metrics.uncertain_actions > 0) notes.push('存在 uncertain 外部动作；复核前必须逐项回查。')
  if (metrics.dead_letter_actions > 0)
    notes.push('存在 dead-letter 动作；复核前必须逐项解释并修复回归。')

  return {
    format: 'keel-trial-status/v1',
    observed_at: input.observed_at,
    state,
    eligible_for_owner_review: eligible,
    trial: input.trial,
    elapsed_ms: elapsedMs,
    elapsed_days: elapsedDays,
    thresholds: {
      duration,
      delegated_decisions: delegated,
      completed_tasks: completed,
    },
    metrics,
    notes,
  }
}
