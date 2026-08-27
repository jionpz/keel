/**
 * 编排器的工作区隔离 —— **确定性**验证，不调真实模型。
 *
 * 这条断言必须留在默认 `check` 里。理由：
 * 「每个 Task 在自己的 worktree 里跑」是并发正确性（`N1`）与
 * 工作区污染清理（`S1`）的落点，一旦回归就是安全问题 ——
 * 不能只在花钱的验收测试里才发现。
 *
 * 用桩 Adapter 是因为这里要验的是**编排器把 session 放在哪个目录**，
 * 与模型说了什么无关。真实模型只会给这条断言加噪声，不加证据。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../contracts/harness-adapter.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor, GitWorkspace } from '../fact/git-workspace.js'

/**
 * 桩 Adapter：记录每次 session 拿到的工作目录，并在其中留下一个可辨认的文件。
 *
 * `emitPmOutcome` 决定它是否产出一份合法的 pm 阶段结论：
 *   - `false`：不产出 ⇒ R-007 回灌三次后这个 run 推不动，编排停在 PM 阶段。
 *     隔离断言在**第一次 startRun** 时就已可观察，不需要跑完整条链。
 *   - `true`：产出 ⇒ run 判成功，编排器会提交工作树 —— 那条断言要的就是这个。
 */
class RecordingAdapter implements HarnessAdapter {
  readonly seen: { path: string; branch: string }[] = []
  private lastRunId = ''

  constructor(private readonly emitPmOutcome = false) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: 'recording-stub',
      version: '0',
      tier: 'L0',
      capabilities: ['CAP-UNTRUSTED_WORKSPACE'],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.seen.push({ path: spec.workspace.path, branch: spec.workspace.branch })
    this.lastRunId = spec.run.run_id
    // 留个印子，用来证明「这个 Task 写的东西只在自己的树里」
    writeFileSync(join(spec.workspace.path, `touched-by-${spec.run.task_id}.txt`), 'x')
    return ok({ run_id: spec.run.run_id, harness_id: 'recording-stub' })
  }

  async awaitResult(): Promise<Result<RunResult>> {
    const text = this.emitPmOutcome
      ? JSON.stringify({
          schema_version: '1.0',
          run_id: this.lastRunId,
          stage: 'pm',
          verdict: 'actionable',
          reason: '桩：这条反馈可做',
          details: { needs_design: false },
        })
      : '没有提案'
    return ok({
      status: 'SUCCEEDED',
      text,
      proposals: [],
      // 桩不上报用量。null 而非 0 —— 「没上报」与「花了 0」是不同的事实
      usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
      session_ref: null,
    })
  }

  async collectChanges(): Promise<Result<WorkspaceDiff>> {
    return ok({ files_changed: [], patch: null, commits: [], is_dirty: false })
  }

  async interrupt(): Promise<Result<void>> {
    return ok(undefined)
  }

  async dispose(): Promise<Result<DisposeReport>> {
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}

let origin: string
let root: string

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  origin = mkdtempSync(join(tmpdir(), 'keel-origin-'))
  root = mkdtempSync(join(tmpdir(), 'keel-root-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: origin })
  execFileSync('git', ['config', 'user.email', 'o@test'], { cwd: origin })
  execFileSync('git', ['config', 'user.name', 'o'], { cwd: origin })
  // 夹具不继承操作者的全局签名配置：签名程序在无人值守环境里可能提示或变慢
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: origin })
  writeFileSync(join(origin, 'README.md'), '# base\n')
  execFileSync('git', ['add', '.'], { cwd: origin })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: origin })
})

afterAll(async () => {
  rmSync(origin, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  await closePool()
})

async function seedTask(repoId: string): Promise<string> {
  const taskId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','隔离验证',$2,'main',$3)`,
      [taskId, repoId, branchFor(taskId)],
    ),
  )
  return taskId
}

describe('N1 · 编排器为每个 Task 用独立 worktree', () => {
  it('两个 Task 的 session 拿到不同目录，且写入互不可见', async () => {
    const git = new GitWorkspace({ root })
    const repoId = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
        [repoId, `file://${origin}`],
      ),
    )
    expect((await git.ensureBareRepo(repoId, `file://${origin}`)).ok).toBe(true)

    const adapter = new RecordingAdapter()
    const deps = {
      driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
        git,
        repoId,
        baseBranch: 'main',
      }),
      sessions: new HarnessSessionManager(),
      adapter,
      workspace: { mode: 'worktree', git, repoId, baseBranch: 'main' } as const,
      now: () => '2026-08-23T13:00:00Z',
    }

    const t1 = await seedTask(repoId)
    const t2 = await seedTask(repoId)
    // 没有提案 ⇒ 推不动，停在 PM 阶段返回 —— 这里要验的东西已经发生
    await runTaskToCompletion(t1, deps, { maxSteps: 4 })
    await runTaskToCompletion(t2, deps, { maxSteps: 4 })

    // 断言的是**用过几个不同目录**，不是起过几次 session ——
    // R-007 会为同一个 run 回灌重试多次，次数是流水线的实现细节，
    // 而「一个 Task 只用一个目录」才是这条测试要钉住的东西。
    const paths = [...new Set(adapter.seen.map((s) => s.path))]
    expect(paths.length, '两个 Task 应各用一个目录，共两个').toBe(2)
    const a = adapter.seen.find((s) => s.branch === branchFor(t1))
    const b = adapter.seen.find((s) => s.branch === branchFor(t2))
    expect(a, 't1 应有自己的分支').toBeDefined()
    expect(b, 't2 应有自己的分支').toBeDefined()
    if (a === undefined || b === undefined) return

    // ── 1. 不是共用一个目录 ──
    expect(a.path).not.toBe(b.path)

    // ── 2. 各自的写入对方看不见 —— 这才是 N1 的实质 ──
    expect(existsSync(join(a.path, `touched-by-${t1}.txt`))).toBe(true)
    expect(existsSync(join(a.path, `touched-by-${t2}.txt`))).toBe(false)
    expect(existsSync(join(b.path, `touched-by-${t2}.txt`))).toBe(true)

    // ── 3. 基线内容确实在（worktree 是从 main 拉出来的，不是空目录）──
    expect(readFileSync(join(a.path, 'README.md'), 'utf8')).toContain('# base')
  })

  it('worktree 模式下，session 的改动被提交到该 Task 的分支 —— 否则清理时会丢', async () => {
    const git = new GitWorkspace({ root })
    const repoId = randomUUID()
    await asOwner((c) =>
      c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
        [repoId, `file://${origin}`],
      ),
    )
    await git.ensureBareRepo(repoId, `file://${origin}`)

    const taskId = await seedTask(repoId)
    await runTaskToCompletion(
      taskId,
      {
        driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
          git,
          repoId,
          baseBranch: 'main',
        }),
        sessions: new HarnessSessionManager(),
        adapter: new RecordingAdapter(true),
        workspace: { mode: 'worktree', git, repoId, baseBranch: 'main' } as const,
        now: () => '2026-08-23T13:00:00Z',
      },
      { maxSteps: 4 },
    )

    // 桩 Adapter 写的文件应已落成一个 commit，且在裸仓库里可见 ——
    // 分支是崩溃后仍存在的东西，工作树不是。
    const files = execFileSync(
      'git',
      [
        '-C',
        join(root, 'repos', `${repoId}.git`),
        'ls-tree',
        '-r',
        '--name-only',
        branchFor(taskId),
      ],
      { encoding: 'utf8' },
    )
    expect(files).toContain(`touched-by-${taskId}.txt`)
  })
})
