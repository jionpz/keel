/**
 * Human L0 最小闭环 —— **确定性**验证，HumanAdapter 在真实编排循环中跑通 PM 阶段。
 *
 * ADR-0005 的刻意选择是「首批必须包含一个 L0」：只有 L2 的话，
 * 降级路径在 v0.1 期间完全不会被执行。HumanAdapter 的单测只钉住了
 * Adapter 自身的契约；本测试把它放进 runTaskToCompletion，证明
 * 「人工作为一种 Harness」在**编排层面**真的成立 ——
 * 人和 AI 走同一个 Run 记账、同一条 Proposal 校验流水线、同一套 ContextBuilt 事件。
 *
 * HumanInbox 用同步桩（相当于一个秒回的人），不调模型、结果确定，
 * 因此留在默认 `pnpm run check` 里 —— 这条路径一旦回归，
 * 「人可以接管任何阶段」这个主张就只剩文档了。
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunSpec } from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HumanAdapter, type HumanInbox } from '../execution/adapters/human.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'

const store = new PgArtifactStore()
const FEEDBACK = '设置页希望能改昵称'

/**
 * 同步收件箱：notify 记录待办，await 立即以人的身份提交合法的 PM 结论。
 *
 * 它模拟的是**响应速度**，不是省掉人的角色 ——
 * 提交的内容仍要过与 AI 完全相同的五步校验，不合格同样会被 R-007 打回。
 */
class SyncInbox implements HumanInbox {
  readonly notified: RunSpec[] = []

  async notify(spec: RunSpec): Promise<void> {
    this.notified.push(spec)
  }

  async await(runId: string): Promise<{ text: string } | null> {
    return {
      text: JSON.stringify({
        schema_version: '1.0',
        run_id: runId,
        stage: 'pm',
        verdict: 'actionable',
        reason: '人工判定：需求明确、范围小，可直接进 RFC',
        details: { needs_design: false },
      }),
    }
  }

  async withdraw(): Promise<void> {
    // 本测试不走撤回路径
  }
}

let ws: string

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  ws = mkdtempSync(join(tmpdir(), 'keel-human-'))
})

afterAll(async () => {
  rmSync(ws, { recursive: true, force: true })
  await closePool()
})

async function seedTask(): Promise<string> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const feedbackId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
      [repoId, `file://${ws}`],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,$3)`,
      [feedbackId, `ref-${feedbackId}`, FEEDBACK],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW',$2,$3,'main',$4)`,
      [taskId, FEEDBACK, repoId, `ai/task-${taskId.slice(0, 8)}`],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
  })
  return taskId
}

describe('Human L0 · 人工作为 Harness 在编排循环中跑通 PM 阶段', () => {
  it('人工提交的结论经同一条校验流水线落库，run 记账 harness_id=human', async () => {
    const taskId = await seedTask()
    const inbox = new SyncInbox()
    const adapter = new HumanAdapter(inbox)

    // 这不是巧合，是 ADR-0005 选它进首批的理由之一：人工恰好是 L0
    expect(adapter.describe().tier).toBe('L0')

    // maxSteps=2：派发 + PM 一个阶段。之后停下 —— 本测试只钉 L0 路径本身，
    // 完整闭环由 v01-criterion 系列验收覆盖。
    const result = await runTaskToCompletion(
      taskId,
      {
        driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
        sessions: new HarnessSessionManager(),
        adapter,
        workspace: { mode: 'fixed', path: ws },
        now: () => '2026-08-26T10:00:00Z',
      },
      { maxSteps: 2 },
    )

    // maxSteps 用尽时循环如实报告「未到终态」；PM 判 actionable ∧ ¬needs_design
    // 应经 T-004 停在 S-RFC_DRAFT —— 这正是 verdict 驱动了状态机的证据
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toContain('S-RFC_DRAFT')

    // ── 1. 人被通知过，且工作区不可信声明与 AI 路径完全相同（S3）──
    expect(inbox.notified.length).toBeGreaterThan(0)
    expect(inbox.notified[0]?.run.stage).toBe('pm')
    expect(inbox.notified[0]?.workspace.untrusted).toBe(true)

    // ── 2. 产物真实落库，且挂在真实的 run 上 ──
    const outcome = await store.latest(taskId, 'stage_outcome', 'pm')
    expect(outcome.ok, outcome.ok ? '' : outcome.error.detail).toBe(true)
    if (!outcome.ok) return
    expect((outcome.value.body as { verdict: string }).verdict).toBe('actionable')
    expect(outcome.value.produced_by_run, 'produced_by_run 不能为空').not.toBeNull()

    // ── 3. run 记账：执行者是 human、层级 L0 —— L0 路径真的被执行过 ──
    const run = await asOwner((c) =>
      c.query<{ status: string; harness_id: string | null; harness_tier: string | null }>(
        `SELECT status, harness_id, harness_tier FROM run WHERE task_id=$1 AND stage='pm'`,
        [taskId],
      ),
    )
    expect(run.rows[0]?.status).toBe('SUCCEEDED')
    expect(run.rows[0]?.harness_id).toBe('human')
    expect(run.rows[0]?.harness_tier).toBe('L0')

    // ── 4. 事件流与 AI 路径同构：ContextBuilt / ProposalAccepted / T-004 ──
    const evs = await store.readEvents(taskId, 0, 200)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const types = evs.value.map((e) => e.type)
    expect(types).toContain('ContextBuilt')
    expect(types).toContain('ProposalAccepted')
    const t004 = evs.value.find(
      (e) =>
        e.type === 'TaskStatusChanged' &&
        (e.payload as { transition: string }).transition === 'T-004',
    )
    expect(t004, 'PM 结论应经 T-004 推进状态').toBeDefined()
  })
})
