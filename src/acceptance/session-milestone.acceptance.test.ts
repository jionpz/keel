/**
 * 验收测试 —— 依赖真实 LLM 的输出内容。
 *
 * **不在默认 `check` 中**，理由见 src/acceptance/README.md。
 * 用 `pnpm run test:acceptance` 显式运行。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunSpec } from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { runSessionUntilValid } from '../control/proposal/pipeline.js'
import { OmpAdapter } from '../execution/adapters/omp.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'

const NOW = '2026-08-23T12:00:00Z'
const store = new PgArtifactStore()

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

// ═══════════════ 里程碑：无人干预 ═══════════════

describe('里程碑：真实 OMP session 驱动状态推进（无人干预）', () => {
  it('session 产出提案 → 校验 → 落成 A-StageOutcome → driver 推进 Task', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'keel-e2e-'))
    execFileSync('git', ['init', '-q', '.'], { cwd: ws })
    writeFileSync(join(ws, 'README.md'), '导出的 Excel 希望能够按照日期筛选\n')

    const repoId = randomUUID()
    const taskId = randomUUID()
    const runId = randomUUID()
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
           VALUES ($1,'local',$2,'main')`,
        [repoId, `file://${ws}`],
      )
      await c.query(
        `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
           VALUES ($1,'S-PM_ANALYZING','Excel 日期筛选',$2,'main','ai/e2e')`,
        [taskId, repoId],
      )
      await c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
           VALUES ($1,$2,'pm','PM',1,'RUNNING',$3)`,
        [runId, taskId, `${taskId}/pm/1`],
      )
    })

    const runSpec: RunSpec = {
      run: { run_id: runId, task_id: taskId, stage: 'pm', role: 'PM', attempt: 1 },
      idempotency_key: `${taskId}/pm/1`,
      workspace: { path: ws, repo_id: repoId, branch: 'main', untrusted: true },
      context: {
        context_id: 'c',
        recipe_id: 'pm',
        recipe_version: '1',
        sections: [],
        total_tokens: 0,
        dropped: [],
      },
      output_contract: { schema_ref: 'stage_outcome', mode: 'post_validate' },
      permissions: { allowed_tools: [], mode: 'manual' },
      limits: { wall_clock_s: 120, budget_usd: null, max_turns: 4 },
    }

    const prompt = [
      '你是 PM。用户反馈：「导出的 Excel 希望能够按照日期筛选」。',
      '判断这条反馈是否值得做。这是一个明确、可实现的小需求。',
      '',
      'JSON 必须形如：',
      '{"schema_version":"1.0","run_id":"<run id>","stage":"pm",',
      ' "verdict":"actionable","reason":"<一句话理由>",',
      ' "details":{"needs_design":false}}',
      `run_id 用：${runId}`,
    ].join('\n')

    // ⚠️ 测试代码在此之后**不提交任何产物** —— 那是无人干预的定义
    const r = await runSessionUntilValid(
      new HarnessSessionManager(),
      { runSpec, adapter: new OmpAdapter(), expect: { kind: 'stage_outcome', key: 'pm' } },
      prompt,
      { now: NOW },
    )

    expect(r.ok, r.ok ? '' : `session 未产出合法提案：${r.error.detail}`).toBe(true)
    if (!r.ok) return
    expect(r.value.committed).toBe(true)

    // 产物确实由那个 run 产出，不是测试代码塞进去的
    const outcome = await store.latest(taskId, 'stage_outcome', 'pm')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.produced_by_run).toBe(runId)
    expect((outcome.value.body as { verdict: string }).verdict).toBe('actionable')

    // driver 读它推进状态 —— 守卫的输入完全来自模型的产出
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    const adv = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, NOW)
    expect(adv.ok).toBe(true)
    if (!adv.ok) return
    expect(adv.value.advanced).toBe(true)
    // needs_design=false → T-004 直接起草 RFC；true → T-003 走 brainstorm
    expect(['T-003', 'T-004']).toContain(adv.value.transition_id)

    rmSync(ws, { recursive: true, force: true })
  }, 240_000)
})
