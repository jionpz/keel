/**
 * Critic 能力路径端到端 —— #1-15。
 *
 * 覆盖 flow 步骤 8-14(brainstorm 请求评审 → Policy 裁决 → critic run →
 * 评审回灌 → brainstorm 收敛 → RFC_DRAFT):
 *   - brainstorm(1) 收敛产物带 needs_critic → loop 合成 A-CapabilityRequest → T-009
 *   - T-009(guard policy=allow, P-ALLOW-CRITIC)创建 run(critic)
 *   - critic run 产出 A-CriticReview → T-009b 回流 brainstorm(2)
 *   - brainstorm(2) 收敛(不带 needs_critic)→ T-010 → S-RFC_DRAFT
 *
 * fixed workspace + 按 stage 路由的 fake adapter:不起真实 LLM、不起 git。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import { HarnessSessionManager } from '../../execution/session/manager.js'
import { asOwner, closePool } from '../../fact/db.js'
import { WorkflowDriver } from '../driver/driver.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { runTaskToCompletion } from './loop.js'

/** 按 startRun 调用顺序分配 body 的 fake LLM */
class StageAdapter implements HarnessAdapter {
  calls: string[] = []
  private readonly bodyByRun = new Map<string, Record<string, unknown>>()
  describe(): HarnessDescriptor {
    return {
      harness_id: 'stage-stub',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  /** 按(adapter 内)启动顺序给每个 run 分配产物 */
  appendBody(body: Record<string, unknown>): void {
    this.pending.push(body)
  }
  private readonly pending: Array<Record<string, unknown>> = []
  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    this.calls.push(spec.run.stage)
    const body = this.pending.shift()
    if (body === undefined) throw new Error(`没有为 ${spec.run.stage} 准备产物`)
    this.bodyByRun.set(spec.run.run_id, body)
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'stage-stub' } }
  }
  async awaitResult(handle: RunHandle): Promise<{ ok: true; value: RunResult }> {
    const body = this.bodyByRun.get(handle.run_id) ?? {}
    return {
      ok: true,
      value: {
        status: 'SUCCEEDED',
        text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      },
    }
  }
  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    return { ok: true, value: { files_changed: [], patch: null, commits: [], is_dirty: false } }
  }
  async interrupt(): Promise<{ ok: true; value: undefined }> {
    return { ok: true, value: undefined }
  }
  async dispose(): Promise<{ ok: true; value: DisposeReport }> {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } }
  }
}

let adapter: StageAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new StageAdapter()
})

afterAll(async () => {
  await closePool()
})

/** 铺 task 到 S-NEW,返回 taskId */
async function seedTask(): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','critic 路径',$2,'main','ai/t')`,
      [taskId, repoId],
    )
  })
  return taskId
}

function depsFor() {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
    now: () => '2026-08-24T12:00:00Z',
  }
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

describe('#1-15 · Critic 能力路径全链路', () => {
  it('brainstorm needs_critic → T-009 → critic run → 回流 → T-010 → S-RFC_DRAFT', async () => {
    const taskId = await seedTask()

    // 各 run 的期望产物(按 startRun 调用顺序):
    // 1. pm: actionable + needs_design=true → T-003 → S-BRAINSTORM
    // 2. brainstorm(1): converged + needs_critic=true → 合成 capability_request → T-009
    // 3. critic: A-CriticReview → T-009b → 回流
    // 4. brainstorm(2): converged(无 needs_critic)→ T-010 → S-RFC_DRAFT
    for (const body of [
      {
        schema_version: '1.0',
        run_id: 'r',
        stage: 'pm',
        verdict: 'actionable',
        reason: '范围明确',
        details: { needs_design: true },
      },
      {
        schema_version: '1.0',
        run_id: 'r',
        stage: 'brainstorm',
        verdict: 'converged',
        reason: '提出候选项',
        details: { needs_critic: true, candidates: [{ id: 'A', summary: '方案A' }] },
      },
      {
        schema_version: '1.0',
        review_type: 'architecture',
        request_id: 'creq_1',
        subject_ref: 'artifact:state@2',
        scale: { min: 0, max: 10, higher_is_better: true },
        criteria: ['改动范围'],
        scores: [{ option_id: 'A', total: 8, by_criterion: { 改动范围: 8 } }],
        findings: [],
        recommendation: 'A',
        confidence: 0.75,
        dissent: null,
      },
      {
        schema_version: '1.0',
        run_id: 'r',
        stage: 'brainstorm',
        verdict: 'converged',
        reason: '采纳方案A',
      },
      {
        schema_version: '1.0',
        title: 'critic 路径 RFC',
        problem: 'p',
        goals: ['g'],
        non_goals: [],
        proposed_change: { summary: 's', affected_areas: ['x'], approach: 'a' },
        acceptance_criteria: [{ id: 'AC1', text: 't', verifiable_by: '测试' }],
        policy_facts: {
          risk: 'low',
          complexity: 'low',
          estimated_files_changed: 1,
          security_related: false,
        },
      },
    ]) {
      adapter.appendBody(body)
    }

    // maxSteps 用尽 → 循环如实报告未到终态(第 6 轮完成 rfc_draft,停在 S-RFC_READY)
    const result = await runTaskToCompletion(taskId, depsFor(), { maxSteps: 6 })

    if (result.ok) {
      // 若真走到了更远的终态(不太可能),至少别低于验收点
      expect(result.value.finalStatus).toBe('S-RFC_READY')
    }
    // 停在 RFC_READY 即证明 critic 评审 → 回流 → 收敛 → RFC 全链路走通
    expect(await statusOf(taskId)).toBe('S-RFC_READY')

    // 阶段调用序列:pm → brainstorm → critic → brainstorm → rfc_draft
    expect(adapter.calls).toEqual(['pm', 'brainstorm', 'critic', 'brainstorm', 'rfc_draft'])

    // T-009 创建了 critic run
    const runs = await asOwner((c) =>
      c.query<{ stage: string }>('SELECT DISTINCT stage FROM run WHERE task_id=$1', [taskId]),
    )
    expect(runs.rows.map((r) => r.stage)).toEqual(
      expect.arrayContaining(['pm', 'brainstorm', 'critic', 'rfc_draft']),
    )

    // Critic 评审落库
    const review = await asOwner((c) =>
      c.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM artifact WHERE task_id=$1 AND kind='critic_review'`,
        [taskId],
      ),
    )
    expect(review.rows.length, '应落一条 A-CriticReview').toBe(1)
    const reviewBody = review.rows[0]?.body as { recommendation?: string } | undefined
    expect(reviewBody?.recommendation).toBe('A')

    // capability_request 落库(合成的 + 事件可重建)
    const req = await asOwner((c) =>
      c.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM artifact WHERE task_id=$1 AND kind='capability_request'`,
        [taskId],
      ),
    )
    expect(req.rows.length, '应落一条能力请求').toBe(1)

    // 事件流:Critic 路径的裁决与派发可重建
    const evs = await asOwner((c) =>
      c.query<{ type: string; payload: { transition?: string } }>(
        `SELECT type, payload FROM event WHERE task_id=$1`,
        [taskId],
      ),
    )
    const types = evs.rows.map((r) => r.type)
    // T-009 的 EvaluatePolicy 副作用落 PolicyEvaluated + policy_decision
    expect(types).toContain('PolicyEvaluated')
    // T-009 自环(TaskStatusChanged)在事件流里有记录
    const transitionIds = evs.rows
      .filter((r) => r.type === 'TaskStatusChanged')
      .map((r) => r.payload?.transition)
    expect(transitionIds).toContain('T-009')
    expect(transitionIds).toContain('T-010')
  })
})
