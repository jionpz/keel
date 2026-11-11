import { describe, expect, it } from 'vitest'
import { evaluateTrial, type TrialMetrics } from './trial.js'

const NOW = '2026-11-11T00:00:00.000Z'

function metrics(over: Partial<TrialMetrics> = {}): TrialMetrics {
  return {
    delegated_decisions: 0,
    human_confirmed_decisions: 0,
    owner_required_decisions: 0,
    denied_decisions: 0,
    completed_tasks: 0,
    open_questions: 0,
    uncertain_actions: 0,
    dead_letter_actions: 0,
    by_project: [],
    ...over,
  }
}

function trial(over: Partial<NonNullable<Parameters<typeof evaluateTrial>[0]['trial']>> = {}) {
  return {
    id: 'trial-1',
    started_at: '2026-11-01T00:00:00.000Z',
    ended_at: null,
    stop_reason: null,
    note: null,
    project_ids: ['p1', 'p2'],
    ...over,
  }
}

describe('JT-07 试运行门槛', () => {
  it('没有开始记录时明确返回 NOT_STARTED，不把零样本当通过', () => {
    const status = evaluateTrial({
      observed_at: NOW,
      trial: null,
      metrics: metrics(),
    })
    expect(status.state).toBe('NOT_STARTED')
    expect(status.eligible_for_owner_review).toBe(false)
    expect(status.thresholds.duration.remaining).toBe(7)
    expect(status.thresholds.delegated_decisions.remaining).toBe(30)
    expect(status.thresholds.completed_tasks.remaining).toBe(5)
  })

  it('必须同时满足 7 天、30 次代决与 5 个完成任务', () => {
    const sixDays = evaluateTrial({
      observed_at: NOW,
      trial: trial({ started_at: '2026-11-05T00:00:00.000Z' }),
      metrics: metrics({ delegated_decisions: 30, completed_tasks: 5 }),
    })
    expect(sixDays.elapsed_days).toBe(6)
    expect(sixDays.eligible_for_owner_review).toBe(false)

    const exact = evaluateTrial({
      observed_at: NOW,
      trial: trial({ started_at: '2026-11-04T00:00:00.000Z' }),
      metrics: metrics({ delegated_decisions: 30, completed_tasks: 5 }),
    })
    expect(exact.elapsed_days).toBe(7)
    expect(exact.eligible_for_owner_review).toBe(true)
    expect(exact.notes.join('\n')).toContain('不等同生产正确率')
  })

  it('停止后的试运行即使样本足够也不能冒充连续试运行通过', () => {
    const stopped = evaluateTrial({
      observed_at: NOW,
      trial: trial({
        started_at: '2026-11-01T00:00:00.000Z',
        ended_at: '2026-11-09T00:00:00.000Z',
        stop_reason: 'owner stopped',
      }),
      metrics: metrics({ delegated_decisions: 40, completed_tasks: 8 }),
    })
    expect(stopped.state).toBe('STOPPED')
    expect(stopped.thresholds.duration.met).toBe(true)
    expect(stopped.eligible_for_owner_review).toBe(false)
    expect(stopped.notes.join('\n')).toContain('需要重新开始一轮')
  })

  it('uncertain 与失败动作出现时给出复核提示', () => {
    const status = evaluateTrial({
      observed_at: NOW,
      trial: trial(),
      metrics: metrics({ uncertain_actions: 1, dead_letter_actions: 2 }),
    })
    expect(status.notes.join('\n')).toContain('uncertain')
    expect(status.notes.join('\n')).toContain('dead-letter')
  })

  it('负数或非整数样本直接拒绝，不做静默截断', () => {
    expect(() =>
      evaluateTrial({
        observed_at: NOW,
        trial: trial(),
        metrics: metrics({ delegated_decisions: -1 }),
      }),
    ).toThrow('delegated_decisions')
    expect(() =>
      evaluateTrial({
        observed_at: NOW,
        trial: trial(),
        metrics: metrics({ completed_tasks: 1.5 }),
      }),
    ).toThrow('completed_tasks')
  })
})
