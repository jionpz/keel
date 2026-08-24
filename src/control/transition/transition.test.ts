import { describe, expect, it } from 'vitest'
import {
  GATE_STATUSES,
  isTerminal,
  STAGE_STATUSES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
} from '../../shared/ids.js'
import { TASK_TRANSITIONS, transition } from './index.js'
import type { TransitionEvent, TransitionFacts } from './types.js'

const baseFacts: TransitionFacts = {
  verdict: null,
  needs_design: false,
  dev_attempts: 0,
  max_dev_attempts: 3,
  stage_attempts: 0,
  max_stage_attempts: 3,
  capability_allowed: true,
}

const facts = (over: Partial<TransitionFacts> = {}): TransitionFacts => ({ ...baseFacts, ...over })

describe('转移表完备性', () => {
  it('状态数与文档一致（15 个）', () => {
    expect(TASK_STATUSES).toHaveLength(15)
    expect(STAGE_STATUSES).toHaveLength(6)
    expect(GATE_STATUSES).toHaveLength(5)
    expect(TERMINAL_STATUSES).toHaveLength(4)
  })

  it('无不可达状态：每个非初态都至少有一条入边', () => {
    const reachable = new Set<string>(['S-NEW']) // T-001 的目标，初态
    for (const rule of TASK_TRANSITIONS) {
      if (rule.to !== 'SELF') reachable.add(rule.to)
      // 通用规则 T-031 指向 S-HUMAN_REVIEW，T-040/041 指向终态，已被上一行覆盖
    }
    const unreachable = TASK_STATUSES.filter((s) => !reachable.has(s))
    expect(unreachable).toEqual([])
  })

  it('无非终态死端：每个非终态都至少有一条出边', () => {
    const deadEnds = TASK_STATUSES.filter((status) => {
      if (isTerminal(status)) return false
      // T-040 / T-041 覆盖全部非终态，因此不该有死端
      const r = transition(status, 'auto', { type: 'Cancelled' }, facts())
      return !r.matched
    })
    expect(deadEnds).toEqual([])
  })

  it('终态无出边', () => {
    const events: TransitionEvent[] = [
      { type: 'Dispatch' },
      { type: 'Cancelled' },
      { type: 'UnrecoverableError' },
      { type: 'CIPassed' },
    ]
    for (const status of TERMINAL_STATUSES) {
      for (const event of events) {
        const r = transition(status, 'auto', event, facts())
        expect(r.matched, `${status} 收到 ${event.type} 不应转移`).toBe(false)
      }
    }
  })
})

describe('ADR-0003：纯函数', () => {
  it('同输入重复调用，输出深相等', () => {
    const event: TransitionEvent = { type: 'RunSucceeded', stage: 'qa' }
    const f = facts({ verdict: 'fail', dev_attempts: 1 })
    const results = Array.from({ length: 20 }, () => transition('S-QA', 'auto', event, f))
    for (const r of results) expect(r).toEqual(results[0])
  })

  it('不修改入参', () => {
    const event: TransitionEvent = { type: 'RunSucceeded', stage: 'pm' }
    const f = facts({ verdict: 'actionable', needs_design: true })
    const eventSnapshot = structuredClone(event)
    const factsSnapshot = structuredClone(f)
    transition('S-PM_ANALYZING', 'auto', event, f)
    expect(event).toEqual(eventSnapshot)
    expect(f).toEqual(factsSnapshot)
  })

  it('副作用只以描述形式出现在返回值中', () => {
    const r = transition(
      'S-RFC_READY',
      'auto',
      { type: 'PolicyEvaluated', decision: 'auto_develop' },
      facts(),
    )
    expect(r.matched).toBe(true)
    if (!r.matched) return
    // 建分支这件事没有真的发生 —— 它只是被描述了出来
    expect(r.effects).toContainEqual({ kind: 'CreateBranch' })
    expect(r.effects.every((e) => typeof e.kind === 'string')).toBe(true)
  })
})

describe('control_mode 是与状态正交的维度', () => {
  it('paused 时不推进常规转移', () => {
    const r = transition('S-NEW', 'paused', { type: 'Dispatch' }, facts())
    expect(r.matched).toBe(false)
    if (r.matched) return
    expect(r.reason).toBe('control_mode_not_auto')
  })

  it('human 时不推进常规转移', () => {
    const r = transition(
      'S-DEVELOPING',
      'human',
      { type: 'RunSucceeded', stage: 'develop' },
      facts(),
    )
    expect(r.matched).toBe(false)
  })

  it('T-040 / T-041 无视 control_mode', () => {
    for (const mode of ['auto', 'paused', 'human'] as const) {
      const cancelled = transition('S-DEVELOPING', mode, { type: 'Cancelled' }, facts())
      expect(cancelled.matched, `Cancelled 在 ${mode} 下应生效`).toBe(true)
      if (cancelled.matched) expect(cancelled.next_status).toBe('S-ABANDONED')

      const fatal = transition('S-DEVELOPING', mode, { type: 'UnrecoverableError' }, facts())
      expect(fatal.matched).toBe(true)
      if (fatal.matched) expect(fatal.next_status).toBe('S-FAILED')
    }
  })
})

describe('具体规则优先于通用规则', () => {
  it('S-QA 的 RunSucceeded 走 T-018/019/020，不被通用规则截胡', () => {
    const pass = transition(
      'S-QA',
      'auto',
      { type: 'RunSucceeded', stage: 'qa' },
      facts({ verdict: 'pass' }),
    )
    expect(pass.matched && pass.id).toBe('T-018')
  })

  it('阶段态的 RunFailed 在未达上限时走 T-030 自环', () => {
    const r = transition(
      'S-DEVELOPING',
      'auto',
      { type: 'RunFailed', stage: 'develop' },
      facts({ stage_attempts: 1 }),
    )
    expect(r.matched).toBe(true)
    if (!r.matched) return
    expect(r.id).toBe('T-030')
    expect(r.next_status).toBe('S-DEVELOPING')
    expect(r.effects).toContainEqual({ kind: 'CreateRun', stage: 'SAME', attempt: 'next' })
  })

  it('阶段态的 RunFailed 达上限后走 T-031 升人工', () => {
    const r = transition(
      'S-QA',
      'auto',
      { type: 'RunTimeout', stage: 'qa' },
      facts({ stage_attempts: 3 }),
    )
    expect(r.matched && r.id).toBe('T-031')
    expect(r.matched && r.next_status).toBe('S-HUMAN_REVIEW')
  })
})

describe('端到端：docs/07-flows.md 流程一（Excel 日期筛选）', () => {
  it('S-NEW → S-DONE 的自动开发闭环可以走通', () => {
    const path: { status: string; id: string }[] = []
    let status: (typeof TASK_STATUSES)[number] = 'S-NEW'

    const step = (event: TransitionEvent, f: TransitionFacts = facts()) => {
      const r = transition(status, 'auto', event, f)
      expect(r.matched, `${status} + ${event.type} 应有转移`).toBe(true)
      if (!r.matched) throw new Error('unreachable')
      path.push({ status, id: r.id })
      status = r.next_status
    }

    step({ type: 'Dispatch' })
    expect(status).toBe('S-PM_ANALYZING')

    step(
      { type: 'RunSucceeded', stage: 'pm' },
      facts({ verdict: 'actionable', needs_design: true }),
    )
    expect(status).toBe('S-BRAINSTORM')

    step({ type: 'RunSucceeded', stage: 'brainstorm' }, facts({ verdict: 'converged' }))
    expect(status).toBe('S-RFC_DRAFT')

    step({ type: 'ArtifactCommitted', kind: 'rfc' })
    expect(status).toBe('S-RFC_READY')

    step({ type: 'PolicyEvaluated', decision: 'auto_develop' })
    expect(status).toBe('S-DEVELOPING')

    step({ type: 'RunSucceeded', stage: 'develop' }, facts({ verdict: 'implemented' }))
    expect(status).toBe('S-QA')

    step({ type: 'RunSucceeded', stage: 'qa' }, facts({ verdict: 'pass' }))
    expect(status).toBe('S-REVIEW')

    step({ type: 'RunSucceeded', stage: 'review' }, facts({ verdict: 'pass' }))
    expect(status).toBe('S-PR_OPEN')

    step({ type: 'CIPassed' })
    expect(status).toBe('S-DONE')

    expect(path.map((p) => p.id)).toEqual([
      'T-002',
      'T-003',
      'T-010',
      'T-011',
      'T-012',
      'T-017',
      'T-018',
      'T-021',
      'T-024',
    ])
  })

  it('复杂需求走 T-013 转人工，而不是自动开发', () => {
    const r = transition(
      'S-RFC_READY',
      'auto',
      { type: 'PolicyEvaluated', decision: 'human_review' },
      facts(),
    )
    expect(r.matched && r.id).toBe('T-013')
    expect(r.matched && r.next_status).toBe('S-HUMAN_REVIEW')
  })

  it('security_review 同样走 T-013 —— 守卫是「非 auto_develop」而非「仅 human_review」(#1-08)', () => {
    const r = transition(
      'S-RFC_READY',
      'auto',
      { type: 'PolicyEvaluated', decision: 'security_review' },
      facts(),
    )
    expect(r.matched && r.id).toBe('T-013')
    expect(r.matched && r.next_status).toBe('S-HUMAN_REVIEW')
  })

  it('T-013 的 guardText 与守卫一致：decision != auto_develop', () => {
    const t013 = TASK_TRANSITIONS.find((t) => t.id === 'T-013')
    expect(t013?.guardText).toBe('decision != auto_develop')
  })

  it('T-010 只匹配 brainstorm 收敛,不再误接 critic 完成(#1-15)', () => {
    const r = transition(
      'S-BRAINSTORM',
      'auto',
      { type: 'RunSucceeded', stage: 'brainstorm' },
      facts(),
    )
    expect(r.matched && r.id).toBe('T-010')
    expect(r.matched && r.next_status).toBe('S-RFC_DRAFT')
  })

  it('critic run 完成 → T-009b 回流 brainstorm(n+1),不推进状态', () => {
    const r = transition('S-BRAINSTORM', 'auto', { type: 'RunSucceeded', stage: 'critic' }, facts())
    expect(r.matched && r.id).toBe('T-009b')
    expect(r.matched && r.next_status).toBe('S-BRAINSTORM') // 自环
    expect(r.matched && r.effects).toContainEqual({
      kind: 'CreateRun',
      stage: 'brainstorm',
      attempt: 'next',
    })
  })

  it('非 brainstorm/critic 的 stage 完成在 S-BRAINSTORM 不匹配', () => {
    const r = transition('S-BRAINSTORM', 'auto', { type: 'RunSucceeded', stage: 'pm' }, facts())
    expect(r.matched).toBe(false)
  })
})
