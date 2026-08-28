/**
 * 反馈里的显式约束要真的走到 rfc_draft 的提示词里(AC5)。
 *
 * 提示词单测(prompts.test.ts)只证明「给了 declared 就会渲染」;
 * 这里证明**编排器确实会去读**它 —— 中间隔着 DB 查询与 loop 的接线,
 * 那一段错了的话,提示词依旧是泛泛的「原样采用」,4b 照样第一轮就拒。
 *
 * 用 fixed workspace + 桩 adapter:不起真实 LLM、不起 git。
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

/** 与 src/acceptance/issue-e2e.acceptance.test.ts 的 ISSUE_BODY 同构 */
const ISSUE_BODY = [
  '目标:只改 README.md 一处文档,补一句「导出支持按日期筛选」。',
  '约束(必须遵守,写进 RFC.policy_facts):',
  '- risk=low',
  '- complexity=low',
  '- estimated_files=1',
  '- security_sensitive=false',
].join('\n')

/** 记下每个 stage 实际收到的提示词正文 */
class PromptCapturingAdapter implements HarnessAdapter {
  readonly promptByStage = new Map<string, string>()
  private readonly pending: Array<Record<string, unknown>> = []
  private readonly bodyByRun = new Map<string, Record<string, unknown>>()

  describe(): HarnessDescriptor {
    return {
      harness_id: 'prompt-capture',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  appendBody(body: Record<string, unknown>): void {
    this.pending.push(body)
  }

  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    const prompt = spec.context.sections.find((s) => s.id === 'prompt')?.content ?? ''
    this.promptByStage.set(spec.run.stage, prompt)
    const body = this.pending.shift()
    if (body === undefined) throw new Error(`没有为 ${spec.run.stage} 准备产物`)
    this.bodyByRun.set(spec.run.run_id, body)
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'prompt-capture' } }
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

let adapter: PromptCapturingAdapter

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  adapter = new PromptCapturingAdapter()
})

afterAll(closePool)

/** 铺一个 S-NEW task,并挂上一条正文为 `body` 的反馈 */
async function seedTaskWithFeedback(body: string): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const feedbackId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','显式约束进提示词',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,$3)`,
      [feedbackId, `acc#${feedbackId}`, body],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
  })
  return taskId
}

function depsFor() {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: '/tmp/fixed' } as const,
    now: () => '2026-08-28T12:00:00Z',
  }
}

/** pm 判 actionable 且不需要设计讨论 → 直接进 S-RFC_DRAFT */
function pmBody(): Record<string, unknown> {
  return {
    schema_version: '1.0',
    run_id: 'r',
    stage: 'pm',
    verdict: 'actionable',
    reason: '范围明确',
    details: { needs_design: false },
  }
}

/** 原样采用反馈声明的 policy_facts —— 应一次过 4b */
function rfcBody(facts: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1.0',
    title: '补一句文档',
    problem: 'README 未说明按日期筛选',
    goals: ['补充一句说明'],
    non_goals: ['任何代码改动'],
    proposed_change: { summary: '改 README', affected_areas: ['README.md'], approach: '加一行' },
    acceptance_criteria: [{ id: 'AC1', text: 'README 含该句', verifiable_by: '人工核对' }],
    policy_facts: facts,
  }
}

describe('rfc_draft 提示词携带反馈的显式约束', () => {
  it('反馈写了 risk=low 等约束 → 提示词里出现 4b 将核对的字面值', async () => {
    const taskId = await seedTaskWithFeedback(ISSUE_BODY)
    adapter.appendBody(pmBody())
    adapter.appendBody(
      rfcBody({
        risk: 'low',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
      }),
    )

    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 3 })

    const prompt = adapter.promptByStage.get('rfc_draft')
    expect(prompt, 'rfc_draft 应当被执行过').toBeDefined()
    expect(prompt).toContain('"risk": "low"')
    expect(prompt).toContain('"complexity": "low"')
    expect(prompt).toContain('"estimated_files_changed": 1')
    expect(prompt).toContain('"security_related": false')
  })

  it('提示词给的值原样填回 → 一次过 4b,不产生 ProposalRejected', async () => {
    const taskId = await seedTaskWithFeedback(ISSUE_BODY)
    adapter.appendBody(pmBody())
    adapter.appendBody(
      rfcBody({
        risk: 'low',
        complexity: 'low',
        estimated_files_changed: 1,
        security_related: false,
      }),
    )

    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 3 })

    // 这条断言是本次改动的目的:预料之中的拒绝不该再烧掉一轮 R-007 ——
    // 各轮共用一个 session 墙钟,白烧一轮就可能把 rfc_draft 推进超时。
    const rejected = await asOwner((c) =>
      c.query<{ n: string }>(
        `SELECT count(*) AS n FROM event WHERE task_id=$1 AND type='ProposalRejected'`,
        [taskId],
      ),
    )
    expect(Number(rejected.rows[0]?.n)).toBe(0)
  })

  it('反馈没写约束 → 提示词不预置取值,仍由模型自评估', async () => {
    const taskId = await seedTaskWithFeedback('把导出做得更好用一点,风险应该不大。')
    adapter.appendBody(pmBody())
    adapter.appendBody(
      rfcBody({
        risk: 'medium',
        complexity: 'medium',
        estimated_files_changed: 3,
        security_related: false,
      }),
    )

    await runTaskToCompletion(taskId, depsFor(), { maxSteps: 3 })

    const prompt = adapter.promptByStage.get('rfc_draft') ?? ''
    expect(prompt).not.toContain('机械核对')
    expect(prompt).toContain('按 RFC 的真实内容评估')
  })
})
