/**
 * v0.1 完成判据的**完整**验证。
 *
 * 此前是分段验证的：
 *   - driver 那条 S-NEW → S-DONE 用的是测试提交的产物
 *   - 无人干预那条只走了 PM 一个阶段
 *
 * 本文件把两者合一：**一条真实反馈，全程由真实 OMP session 驱动**。
 *
 * 诚实边界：`S-PR_OPEN → S-DONE` 需要 CI 结果，而 CI 是 Keel 的
 * **外部事实源**（docs/09-roadmap.md §3），系统本身不产生它。
 * 真实 git/CI 接入已完成（子任务 7：GitHubProvider + `opts.ci`），
 * 但本文件**刻意**仍由测试注入 CI —— 保留一个不依赖远程仓库与凭据的
 * 本地 cheap 版本；真实 GitHub 全链路由
 * `v01-criterion-github.acceptance.test.ts` 验证。注入处显式标记为模拟。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { OmpAdapter } from '../execution/adapters/omp.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor, GitWorkspace } from '../fact/git-workspace.js'

const store = new PgArtifactStore()
const FEEDBACK = '导出的 Excel 希望能够按照日期筛选'

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

interface Seeded {
  taskId: string
  ws: string
  repoId: string
}

/**
 * 只铺**输入**：仓库、反馈、Task。
 *
 * 测试在此之后不再写入任何产物 —— 那是「无人干预」的定义。
 */
async function seed(): Promise<Seeded> {
  const ws = mkdtempSync(join(tmpdir(), 'keel-v01-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: ws })
  execFileSync('git', ['config', 'user.email', 'keel@test'], { cwd: ws })
  execFileSync('git', ['config', 'user.name', 'keel'], { cwd: ws })
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

  return { taskId, ws, repoId }
}

describe('v0.1 完成判据（完整）', () => {
  it('一条真实反馈在无人干预下走完 S-NEW → S-DONE，事件流可完整重建', async () => {
    const { taskId, ws, repoId } = await seed()
    let ciCalls = 0

    // 每个 Task 一个独立 worktree —— 与生产接线一致（docs/08-cross-cutting.md §4.1）。
    // 裸仓库与工作树都建在临时目录下，测试结束一并清掉。
    const git = new GitWorkspace({ root: mkdtempSync(join(tmpdir(), 'keel-v01-root-')) })
    const bare = await git.ensureBareRepo(repoId, `file://${ws}`)
    expect(bare.ok, bare.ok ? '' : `建裸仓库失败：${bare.error.detail}`).toBe(true)
    if (!bare.ok) return
    const binding = { git, repoId, baseBranch: 'main' } as const

    const result = await runTaskToCompletion(
      taskId,
      {
        driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding),
        sessions: new HarnessSessionManager(),
        adapter: new OmpAdapter(),
        workspace: { mode: 'worktree', ...binding },
        // 时间由外部注入 —— Control Plane 不读时钟
        now: () => '2026-08-23T13:00:00Z',
      },
      {
        maxSteps: 25,
        /**
         * ⚠️ 模拟的外部 CI（本地版的刻意设计）。
         *
         * CI 是 Keel 的外部事实源，系统本身不产生它。
         * 真实接入已存在（`opts.ci` + GitHubProvider），本文件刻意不用 ——
         * 保持本测试无远程依赖；真实路径由 v01-criterion-github 覆盖。
         * 这**不是**编排器自己造活 —— 它造的是外部世界的回应。
         */
        externalCi: async () => {
          ciCalls++
          return 'passed'
        },
      },
    )

    expect(result.ok, result.ok ? '' : `编排失败：${result.error.detail}`).toBe(true)
    if (!result.ok) return

    // ── 1. 走到终态 ──
    expect(result.value.finalStatus).toBe('S-DONE')
    expect(ciCalls, 'CI 应被问过一次').toBe(1)

    // ── 2. 途中每个阶段的产物都由真实 run 产出 ──
    const artifacts = await asOwner((c) =>
      c.query<{ kind: string; produced_by_run: string | null }>(
        'SELECT kind, produced_by_run FROM artifact WHERE task_id=$1',
        [taskId],
      ),
    )
    const bySession = artifacts.rows.filter((a) => a.kind === 'stage_outcome' || a.kind === 'rfc')
    expect(bySession.length, '应有多个由 session 产出的产物').toBeGreaterThan(2)
    for (const a of bySession) {
      // 不是测试代码塞的 —— 每个都挂在一个真实的 run 上
      expect(a.produced_by_run, `${a.kind} 应有 produced_by_run`).not.toBeNull()
    }

    // ── 3. develop 阶段做了真实的文件改动 ──
    //
    // 查的是**分支**而不是工作树：进 S-DONE 时 CleanWorkspace 会移除工作树，
    // 分支留在裸仓库里。这正是「能在进程崩溃后存活的只有 Artifact」的
    // git 侧对应物 —— 没提交的东西不算数。
    const branch = branchFor(taskId)
    const commits = execFileSync(
      'git',
      ['-C', bare.value, 'log', '--format=%s', `main..${branch}`],
      { encoding: 'utf8' },
    ).trim()
    expect(commits, 'develop 阶段应在该 Task 的分支上留下提交').not.toBe('')

    // ── 4. 事件流能完整重建全过程 ──
    const evs = await store.readEvents(taskId, 0, 1000)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return

    const transitions = evs.value
      .filter((e) => e.type === 'TaskStatusChanged')
      .map((e) => (e.payload as { transition: string }).transition)

    // 与编排器记录的路径一致
    expect(transitions).toEqual(
      result.value.steps.map((s) => s.transition).filter((t) => t !== null),
    )

    // 起于 T-002（派发），终于 T-024（CI 通过）
    expect(transitions[0]).toBe('T-002')
    expect(transitions.at(-1)).toBe('T-024')

    // ── 5. 每次给 Agent 的上下文都可复现 ──
    const ctxEvents = evs.value.filter((e) => e.type === 'ContextBuilt')
    expect(ctxEvents.length, '每个 session 都应有 ContextBuilt 事件').toBeGreaterThan(2)
    for (const e of ctxEvents) {
      const p = e.payload as {
        sections: { source_ref: string }[]
        dropped: unknown[]
        context_id: string
      }
      expect(p.context_id).toBeTruthy()
      // dropped 必填 —— 被砍掉的东西必须显式记录
      expect(Array.isArray(p.dropped)).toBe(true)
      for (const s of p.sections) expect(s.source_ref).toBeTruthy()
    }

    // ── 6. Policy 裁决落库且是自动放行 ──
    const decision = await store.latest(taskId, 'policy_decision', 'rfc_ready')
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect((decision.value.body as { decision: string }).decision).toBe('auto_develop')

    // 打印路径，便于人工核对
    console.log(
      '\n走过的路径：',
      result.value.steps.map((s) => `${s.transition}(${s.note})`).join(' → '),
    )

    rmSync(ws, { recursive: true, force: true })
  }, 900_000)
})
