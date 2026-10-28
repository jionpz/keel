/**
 * collectChanges 接进编排的端到端回归 —— develop 的「真改了吗」闸门 + QA 看得到 diff。
 *
 * 用**真实的 L0 Harness**（HumanAdapter）跑完整链路：
 * 真实 git 工作树、真实 `collectGitDiff(since)`、真实事件与 ContextBuilt。
 * 不起任何 LLM —— 因此进默认 check，而不是验收套件。
 *
 * 钉住三件在真机上加起来才会暴露的事：
 *   1. 采集必须发生在 adapter.dispose 与 commitAll **之前**（否则读到 NOT_FOUND / 假空）
 *   2. 基线取 startRun 时的 HEAD —— 人/AI 自己 commit 过也要看得见
 *   3. QA 的上下文里有 develop 那一轮的真实 diff，且 source_ref 能指回那条事件
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { asOwner, closePool } from '../fact/db.js'
import { GitWorkspace } from '../fact/git-workspace.js'

const FEEDBACK = 'README 里补一句「导出支持按日期筛选」。'
const MARKER = '导出支持按日期筛选。'

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

/** 各阶段的合法产物 —— 声明形状见 promptFor() */
function outcomeFor(spec: RunSpec): Record<string, unknown> {
  const base = {
    schema_version: '1.0',
    run_id: spec.run.run_id,
    stage: spec.run.stage,
    reason: 'ok',
  }
  switch (spec.run.stage) {
    case 'pm':
      return { ...base, verdict: 'actionable', details: { needs_design: false } }
    case 'rfc_draft':
      // RFC 有独立 schema：多一个 run_id/stage 都会被 additionalProperties:false 拒掉
      return {
        schema_version: '1.0',
        title: 'README 补一句筛选说明',
        problem: 'README 没有说明导出支持按日期筛选',
        goals: ['补一句说明'],
        non_goals: [],
        proposed_change: {
          summary: '改 README',
          affected_areas: ['README.md'],
          approach: '加一行',
        },
        acceptance_criteria: [{ id: 'AC1', text: 'README 里有该句', verifiable_by: '人工核对' }],
        policy_facts: {
          risk: 'low',
          complexity: 'low',
          estimated_files_changed: 1,
          security_related: false,
        },
      }
    case 'develop':
      return { ...base, verdict: 'implemented', details: { files_changed: 1 } }
    default:
      return { ...base, verdict: 'pass' }
  }
}

interface Seeded {
  readonly taskId: string
  readonly repoId: string
  readonly ws: string
}

async function seed(): Promise<Seeded> {
  const ws = mkdtempSync(join(tmpdir(), 'keel-collect-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: ws })
  execFileSync('git', ['config', 'user.email', 'keel@test'], { cwd: ws })
  execFileSync('git', ['config', 'user.name', 'keel'], { cwd: ws })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: ws })
  writeFileSync(
    join(ws, 'README.md'),
    ['# 导出模块', '', '当前导出接口没有任何筛选参数。', ''].join('\n'),
  )
  execFileSync('git', ['add', '.'], { cwd: ws })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws })

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
  return { taskId, repoId, ws }
}

/** 人工通道：develop 阶段真的往工作树里写文件，其余阶段只交产物 */
function humanInbox(): HumanInbox {
  const specs = new Map<string, RunSpec>()
  return {
    notify: async (spec) => {
      specs.set(spec.run.run_id, spec)
    },
    await: async (runId) => {
      const spec = specs.get(runId)
      if (spec === undefined) throw new Error(`未知 run ${runId}`)
      if (spec.run.stage === 'develop') {
        writeFileSync(
          join(spec.workspace.path, 'README.md'),
          ['# 导出模块', '', '当前导出接口没有任何筛选参数。', MARKER, ''].join('\n'),
        )
      }
      return { text: `\`\`\`json\n${JSON.stringify(outcomeFor(spec))}\n\`\`\`` }
    },
    withdraw: async () => undefined,
  }
}

describe('collectChanges 接进编排（真实工作树 · L0 Harness）', () => {
  it('develop 收真实 diff → 事件落库 → QA 上下文里能看到它', async () => {
    const { taskId, repoId, ws } = await seed()
    const root = mkdtempSync(join(tmpdir(), 'keel-collect-root-'))
    const git = new GitWorkspace({ root })
    const prepared = await git.prepareProject({ mode: 'managed', repoId }, `file://${ws}`, 'main')
    expect(prepared.ok, prepared.ok ? '' : `建裸仓库失败：${prepared.error.detail}`).toBe(true)
    if (!prepared.ok) return
    const project = prepared.value

    const binding = { git, repoId, project } as const
    try {
      const result = await runTaskToCompletion(
        taskId,
        {
          driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding),
          sessions: new HarnessSessionManager(),
          adapter: new HumanAdapter(humanInbox()),
          workspace: { mode: 'worktree', ...binding },
          now: () => '2026-10-26T00:00:00Z',
        },
        { maxSteps: 25, externalCi: async () => 'passed' },
      )
      expect(result.ok, result.ok ? '' : `编排失败：${result.error.detail}`).toBe(true)
      if (!result.ok) return
      expect(result.value.finalStatus).toBe('S-DONE')

      // ── 1. develop 的 diff 事件：真实文件、真实 patch ──
      const evs = await asOwner((c) =>
        c.query<{ seq: string; payload: Record<string, unknown> }>(
          `SELECT seq, payload FROM event
           WHERE task_id=$1 AND type='WorkspaceDiffCollected' AND payload->>'stage'='develop'
           ORDER BY seq`,
          [taskId],
        ),
      )
      expect(evs.rows, 'develop 必须留下一条 diff 观测').toHaveLength(1)
      const payload = evs.rows[0]?.payload ?? {}
      const developSeq = Number(evs.rows[0]?.seq)
      expect(payload.collected).toBe(true)
      expect(payload.files_changed).toEqual([{ path: 'README.md', change: 'modified' }])
      expect(String(payload.patch)).toContain(MARKER)
      expect(payload.patch_truncated).toBe(false)
      // commitAll 在采集之后，所以此刻工作树还是脏的
      expect(payload.is_dirty).toBe(true)

      // ── 2. QA 的上下文里有 diff section，且能指回那条事件 ──
      const qaBuilt = await asOwner((c) =>
        c.query<{ payload: { sections?: { id: string; source_ref: string }[] } }>(
          `SELECT payload FROM event
           WHERE task_id=$1 AND type='ContextBuilt'
             AND payload->>'recipe_id'='QA'
           ORDER BY seq DESC LIMIT 1`,
          [taskId],
        ),
      )
      const sections = qaBuilt.rows[0]?.payload.sections ?? []
      const diffSection = sections.find((s) => s.id === 'diff')
      expect(diffSection, 'QA 必须拿到 diff').toBeDefined()
      expect(diffSection?.source_ref).toBe(`event:WorkspaceDiffCollected@${developSeq}`)

      // ── 3. 这一轮的改动真的提交进了 Task 分支（没提交就等于没做）──
      const branch = `ai/task-${taskId.slice(0, 8)}`
      const stat = execFileSync(
        'git',
        ['-C', project.gitDir, 'show', '--stat', '--oneline', branch],
        {
          encoding: 'utf8',
        },
      )
      expect(stat).toContain('README.md')
    } finally {
      await git.remove(project, taskId)
      rmSync(ws, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
