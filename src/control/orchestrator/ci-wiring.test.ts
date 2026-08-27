/**
 * 编排器 CI 接线的**确定性**验证 —— fake CiGateway 驱动 T-024 / T-025。
 *
 * 覆盖 implement.md Stage 5.3:
 *   - `opts.ci` 传入时优先于 `externalCi`,S-PR_OPEN 用真实 gateway 路径
 *   - waitForCi 返回 passed → CIPassed → T-024 → S-DONE
 *   - waitForCi 返回 failed 且 dev_attempts < max → CIFailed → T-025 → S-DEVELOPING(新 develop run)
 *
 * 不调真实 GitHub:本层要验的是**编排器把外部事实转成哪个事件、走到哪条转移**,
 * gateway 的真实性由 github-provider.test.ts 与验收测试分层覆盖。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { CiGateway, CiWaitInput } from '../../contracts/ci-gateway.js'
import type { Result } from '../../contracts/errors.js'
import type { HarnessAdapter, HarnessDescriptor } from '../../contracts/harness-adapter.js'
import type { Proposal } from '../../contracts/types.js'
import { HarnessSessionManager } from '../../execution/session/manager.js'
import { PgArtifactStore } from '../../fact/artifact-store.js'
import { asOwner, closePool } from '../../fact/db.js'
import { branchFor, GitWorkspace } from '../../fact/git-workspace.js'
import { WorkflowDriver } from '../driver/driver.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { runTaskToCompletion } from './loop.js'

const store = new PgArtifactStore()

class FakeCi implements CiGateway {
  readonly calls: CiWaitInput[] = []
  constructor(private readonly result: 'passed' | 'failed') {}
  async waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>> {
    this.calls.push(input)
    return { ok: true, value: this.result }
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
  origin = mkdtempSync(join(tmpdir(), 'keel-ci-origin-'))
  root = mkdtempSync(join(tmpdir(), 'keel-ci-root-'))
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

const commitCtx = {
  run_id: null,
  verdict: { accepted: true, artifact_ref: null, violations: [] },
  emit_event: true,
} as const

/** 把 Task 直接铺到 S-PR_OPEN:run 记录齐全,T-024/T-025 的 guard 输入就位 */
async function seedTaskAtPrOpen(): Promise<{ taskId: string; repoId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
      [repoId, `file://${origin}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-PR_OPEN','CI 接线测试',$2,'main',$3)`,
      [taskId, repoId, branchFor(taskId)],
    )
    // develop 的第一次 run —— dev_attempts=1 < max=3,T-025 guard 成立
    await c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'develop','DEV',1,'SUCCEEDED',$3)`,
      [randomUUID(), taskId, `${taskId}/develop/1`],
    )
  })
  const outcome: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'stage_outcome',
    key: 'review',
    body: {
      schema_version: '1.0',
      run_id: 'run-review',
      stage: 'review',
      verdict: 'pass',
      reason: '测试:已到 PR_OPEN',
    },
    supersedes: null,
    produced_by_run: 'run-review',
  }
  expect((await store.commit(outcome, commitCtx)).ok).toBe(true)
  return { taskId, repoId }
}

async function statusOf(taskId: string): Promise<string> {
  const r = await asOwner((c) =>
    c.query<{ status: string }>('SELECT status FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]?.status ?? '(missing)'
}

/** 桩 Adapter:S-PR_OPEN 之后不应再起 session;若起了,让编排立刻可见地失败 */
class NoSessionAdapter implements HarnessAdapter {
  describe(): HarnessDescriptor {
    return {
      harness_id: 'no-session-stub',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  async startRun(): Promise<never> {
    throw new Error('CI 接线测试不应再起 session')
  }
  async awaitResult(): Promise<never> {
    throw new Error('CI 接线测试不应再等 session')
  }
  async collectChanges(): Promise<never> {
    throw new Error('CI 接线测试不应收集改动')
  }
  async interrupt() {
    return { ok: true, value: undefined } as const
  }
  async dispose() {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } } as const
  }
}

function depsFor(repoId: string, git: GitWorkspace) {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
      git,
      repoId,
      baseBranch: 'main',
    }),
    sessions: new HarnessSessionManager(),
    adapter: new NoSessionAdapter(),
    workspace: { mode: 'worktree', git, repoId, baseBranch: 'main' } as const,
    now: () => '2026-08-23T13:00:00Z',
  }
}

describe('编排器 CI 接线(opts.ci 优先)', () => {
  it('waitForCi=passed → CIPassed → T-024 → S-DONE,gateway 收到裸仓库 head SHA', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    const git = new GitWorkspace({ root })
    expect((await git.ensureBareRepo(repoId, `file://${origin}`)).ok).toBe(true)
    // 分支要有 HEAD 才能读 SHA —— 在**裸仓库**(编排器读的就是它)里建出该 Task 的分支
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('passed')
    const result = await runTaskToCompletion(taskId, depsFor(repoId, git), {
      maxSteps: 4,
      ci,
      externalCi: async () => {
        throw new Error('externalCi 不应被调用 —— opts.ci 优先')
      },
    })

    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-DONE')
    expect(await statusOf(taskId)).toBe('S-DONE')

    expect(ci.calls.length).toBe(1)
    const expectedSha = execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'rev-parse', `refs/heads/${branchFor(taskId)}`],
      { encoding: 'utf8' },
    ).trim()
    expect(ci.calls[0]?.headSha).toBe(expectedSha)
    expect(ci.calls[0]?.remoteUrl).toBe(`file://${origin}`)

    const stepsNote = result.value.steps.map((s) => s.note).join('|')
    expect(stepsNote).toContain('外部 CI：passed')
  })

  it('waitForCi=failed → CIFailed → T-025 → 回 S-DEVELOPING 并开新 develop run', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    const git = new GitWorkspace({ root })
    await git.ensureBareRepo(repoId, `file://${origin}`)
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('failed')
    // maxSteps=1:推进这一步后就停 —— 我们只关心转移与 run 创建
    const result = await runTaskToCompletion(taskId, depsFor(repoId, git), { maxSteps: 1, ci })

    // maxSteps 用尽时循环如实报告「未到终态」—— 这正是我们要的:S-DEVELOPING 非终态
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.detail).toContain('S-DEVELOPING')
    expect(await statusOf(taskId)).toBe('S-DEVELOPING')

    const runs = await asOwner((c) =>
      c.query<{ stage: string; attempt: number }>(
        'SELECT stage, attempt FROM run WHERE task_id=$1 AND stage=$2 ORDER BY attempt',
        [taskId, 'develop'],
      ),
    )
    expect(runs.rows.length, '应有第二个 develop run').toBe(2)
    // 转移轨迹:TaskStatusChanged 记录 CIFailed 驱动的 T-025(S-PR_OPEN → S-DEVELOPING)
    const events = await asOwner((c) =>
      c.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
         ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(events.rows[0]?.payload).toMatchObject({ from: 'S-PR_OPEN', to: 'S-DEVELOPING' })
  })
})
