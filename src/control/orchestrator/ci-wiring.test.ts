/**
 * 编排器 CI 与 PR 接线的**确定性**验证。
 *
 * 覆盖 implement.md Stage 5.3:
 *   - `opts.ci` 传入时优先于 `externalCi`,S-PR_OPEN 用真实 gateway 路径
 *   - waitForCi 返回 passed → CIPassed → T-042，留在 S-PR_OPEN
 *   - PR merged → PRMerged → T-024 → S-DONE；closed 未合并 → T-027
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
import type { CiGateway, CiObservation, CiWaitInput } from '../../contracts/ci-gateway.js'
import type { Result } from '../../contracts/errors.js'
import { err, makeError, ok } from '../../contracts/errors.js'
import type {
  HarnessAdapter,
  HarnessDescriptor,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import type {
  PullRequestState,
  PullRequestStateGateway,
  PullRequestStateInput,
} from '../../contracts/pull-request-state.js'
import type { Proposal } from '../../contracts/types.js'
import { HarnessSessionManager } from '../../execution/session/manager.js'
import { PgArtifactStore } from '../../fact/artifact-store.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import { branchFor, GitWorkspace, type PreparedProject } from '../../fact/git-workspace.js'
import { FactPlaneContextBuilder } from '../context/builder.js'
import { WorkflowDriver } from '../driver/driver.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { runTaskToCompletion } from './loop.js'
import { legacyProjectBinding, runLegacyProjectQa } from './project-verification.js'

const store = new PgArtifactStore()

class FakeCi implements CiGateway {
  readonly calls: CiWaitInput[] = []
  constructor(private readonly result: 'passed' | 'failed') {}
  async waitForCi(input: CiWaitInput): Promise<Result<'passed' | 'failed'>> {
    this.calls.push(input)
    return { ok: true, value: this.result }
  }
}

class FakePullRequests implements PullRequestStateGateway {
  readonly calls: PullRequestStateInput[] = []
  constructor(private readonly state: PullRequestState) {}
  async getPullRequest(input: PullRequestStateInput): Promise<Result<PullRequestState>> {
    this.calls.push(input)
    return { ok: true, value: this.state }
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

async function seedPullRequest(taskId: string, number = 7): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO event (task_id, type, payload)
       VALUES ($1,'SideEffectApplied',$2::jsonb)`,
      [
        taskId,
        JSON.stringify({
          kind: 'CreatePullRequest',
          dedupe_key: `ai/${taskId}`,
          pr_number: number,
          pr_url: `file://${origin}/pull/${number}`,
          head_branch: branchFor(taskId),
        }),
      ],
    ),
  )
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
  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    // 本测试不关心改动内容，只要求「采集这一步不会炸」
    return { ok: true, value: { files_changed: [], patch: null, commits: [], is_dirty: false } }
  }
  async interrupt() {
    return { ok: true, value: undefined } as const
  }
  async dispose() {
    return { ok: true, value: { session_ref_retained: false, workspace_cleaned: false } } as const
  }
}

function depsFor(repoId: string, git: GitWorkspace, project: PreparedProject) {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
      git,
      repoId,
      project,
    }),
    sessions: new HarnessSessionManager(),
    adapter: new NoSessionAdapter(),
    workspace: { mode: 'worktree', git, repoId, project } as const,
    now: () => '2026-08-23T13:00:00Z',
  }
}

describe('绑定 PR 的真实 CI 恢复', () => {
  const headSha = 'a'.repeat(40)
  const mergeSha = 'b'.repeat(40)
  const failed: CiObservation = {
    state: 'failed',
    rerun: { runId: 42, attempt: 1 },
    evidence: {
      key: 'first-attempt',
      checks: [{ name: 'test', conclusion: 'failure' }],
      jobs: [{ name: 'test', failedSteps: ['Run Vitest'] }],
      url: 'https://github.com/acme/widget/actions/runs/42',
    },
  }

  async function scenario(rerunFailedCi: NonNullable<CiGateway['rerunFailedCi']>) {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId)
    const git = new GitWorkspace({ root })
    const deps = depsFor(repoId, git, await prepareFor(git, repoId))
    let ci: CiObservation = failed
    let currentHead = headSha
    let merged = false
    let onPullRead = () => {}
    const drive = (observePrOnly = false) =>
      runTaskToCompletion(taskId, deps, {
        observePrOnly,
        ci: {
          waitForCi: async () => {
            throw new Error('不得复用旧终态')
          },
          observeCi: async (input) => {
            expect(input).toMatchObject({ prNumber: 7 })
            return ok(ci)
          },
          rerunFailedCi,
        },
        pullRequests: {
          getPullRequest: async () => {
            onPullRead()
            return ok({
              number: 7,
              url: 'https://github.com/acme/widget/pull/7',
              state: merged ? 'closed' : 'open',
              merged,
              mergedAt: merged ? '2026-08-23T13:00:00Z' : null,
              mergeSha: merged ? mergeSha : null,
              closedAt: merged ? '2026-08-23T13:00:00Z' : null,
              headSha: currentHead,
            })
          },
        },
      })
    const developRuns = () =>
      asOwner(
        async (c) =>
          (await c.query("SELECT 1 FROM run WHERE task_id=$1 AND stage='develop'", [taskId]))
            .rowCount,
      )
    return {
      taskId,
      deps,
      drive,
      developRuns,
      observe: (value: CiObservation) => {
        ci = value
      },
      moveHead: (sha: string) => {
        currentHead = sha
      },
      whenReadingPr: (callback: () => void) => {
        onPullRead = callback
      },
      merge: () => {
        merged = true
      },
    }
  }

  it('同一 SHA 失败只请求重跑一次，转绿及合并全程不派 develop', async () => {
    let requested = 0
    const task = await scenario(async () => {
      requested++
      return ok(true)
    })
    const failing = await Promise.all([task.drive(), task.drive()])
    for (const result of failing)
      expect(result).toMatchObject({ ok: true, value: { stopReason: 'awaiting-external-ci' } })
    expect(requested).toBe(1)
    task.observe({ state: 'pending' })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { stopReason: 'awaiting-external-ci' },
    })
    task.observe({ state: 'passed' })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { stopReason: 'awaiting-pr-merge' },
    })
    task.merge()
    expect(await task.drive()).toMatchObject({ ok: true, value: { finalStatus: 'S-DONE' } })
    expect(await task.developRuns()).toBe(1)
  })

  it('重跑权限不足进入 CI 等待，重复轮询和关闭 issue 都不丢交付', async () => {
    let requested = 0
    const task = await scenario(async () => {
      requested++
      return err(makeError('AUTH_FAILED', '没有 Actions 写权限'))
    })
    expect(await task.drive()).toMatchObject({ ok: true, value: { finalStatus: 'S-HUMAN_REVIEW' } })
    await task.drive()
    expect(requested).toBe(1)
    const cancelled = await task.deps.driver.advance(
      task.taskId,
      { type: 'Cancelled', reason: 'issue_closed' },
      task.deps.now(),
    )
    expect(cancelled).toMatchObject({ ok: true, value: { advanced: false } })
    task.merge()
    expect(await task.drive()).toMatchObject({ ok: true, value: { finalStatus: 'S-DONE' } })
    const recorded = await asOwner((c) =>
      c.query("SELECT payload FROM event WHERE task_id=$1 AND payload->>'transition'='T-043'", [
        task.taskId,
      ]),
    )
    expect(recorded.rows[0]?.payload).toMatchObject({ merge_sha: mergeSha })
    expect(await task.developRuns()).toBe(1)
  })

  it('重跑检查期间 PR head 改变，旧失败不会进入人工等待', async () => {
    let requested = 0
    const nextHead = 'c'.repeat(40)
    const task = await scenario(async (input) => {
      expect(input.headSha).toBe(headSha)
      requested++
      task.moveHead(nextHead)
      return ok(false)
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
    })
    task.observe({ state: 'passed' })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-pr-merge' },
    })
    expect(requested).toBe(1)
    expect(await task.developRuns()).toBe(1)
    const observations = await asOwner((c) =>
      c.query(
        `SELECT payload->>'event' AS event, payload->>'head_sha' AS head FROM event
         WHERE task_id=$1 AND payload->>'event' IN ('CIFailed','CIPassed') ORDER BY seq`,
        [task.taskId],
      ),
    )
    expect(observations.rows).toEqual([{ event: 'CIPassed', head: nextHead }])
  })

  it('重跑请求拒绝后已观察到同一提交的新检查轮次，旧失败不会进入人工等待', async () => {
    let requested = 0
    const task = await scenario(async () => {
      requested++
      task.observe({
        state: 'failed',
        evidence: { ...failed.evidence, key: 'second-attempt' },
      })
      return ok(false)
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-HUMAN_REVIEW', stopReason: 'awaiting-human' },
    })
    expect(requested).toBe(1)
    expect(await task.developRuns()).toBe(1)
  })

  it('网关已证明轮次过期时，后续轮询也不消费仍可见的旧失败', async () => {
    let requested = 0
    const task = await scenario(async () => {
      requested++
      return err(makeError('STALE_EVIDENCE', 'Actions 轮次已变化'))
    })
    for (let poll = 0; poll < 2; poll++)
      expect(await task.drive()).toMatchObject({
        ok: true,
        value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
      })
    task.observe({
      state: 'failed',
      evidence: { ...failed.evidence, key: 'second-attempt' },
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-HUMAN_REVIEW', stopReason: 'awaiting-human' },
    })
    expect(requested).toBe(1)
    expect(await task.developRuns()).toBe(1)
  })

  it('复核 PR 时同一 SHA 开始新一轮检查，旧失败不会进入人工等待', async () => {
    const task = await scenario(async () => ok(false))
    let reads = 0
    task.whenReadingPr(() => {
      if (++reads === 2) task.observe({ state: 'pending' })
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
    })
    expect(await task.developRuns()).toBe(1)
  })

  it('PR 恢复原 SHA 后可以重新观察该提交的真实失败', async () => {
    let requested = 0
    const task = await scenario(async () => {
      requested++
      task.moveHead('c'.repeat(40))
      return err(makeError('CONFLICT', 'PR head SHA 已变化'))
    })
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', stopReason: 'awaiting-external-ci' },
    })
    task.moveHead(headSha)
    expect(await task.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-HUMAN_REVIEW', stopReason: 'awaiting-human' },
    })
    expect(requested).toBe(1)
  })

  it('已合并 PR 可以在待返工时收口，并取消尚未认领的 develop', async () => {
    const task = await scenario(async () => ok(false))
    await task.drive()
    await task.deps.driver.advance(task.taskId, { type: 'HumanApproved' }, task.deps.now(), {
      note: '明确修复已确认的断言',
    })
    task.merge()
    expect(await task.drive(true)).toMatchObject({ ok: true, value: { finalStatus: 'S-DONE' } })
    const run = await asOwner((c) =>
      c.query("SELECT status FROM run WHERE task_id=$1 AND stage='develop' AND attempt=2", [
        task.taskId,
      ]),
    )
    expect(run.rows[0]?.status).toBe('CANCELLED')
  })

  it('存量的 CI 自动返工零改动等待也能消费同一 SHA 的新结果', async () => {
    const task = await scenario(async () => ok(false))
    await asOwner(async (c) => {
      await c.query("UPDATE task SET status='S-HUMAN_REVIEW' WHERE id=$1", [task.taskId])
      await c.query(
        `INSERT INTO event (task_id,type,payload) VALUES
         ($1,'TaskStatusChanged','{"transition":"T-025","source":"github","to":"S-DEVELOPING"}'),
         ($1,'TaskStatusChanged','{"transition":"T-031","to":"S-HUMAN_REVIEW"}')`,
        [task.taskId],
      )
      await c.query(
        `INSERT INTO run (id,task_id,stage,role,attempt,status,idempotency_key,error_detail,ended_at)
         VALUES ($1,$2,'develop','DEV',2,'FAILED',$3,$4,now())`,
        [
          randomUUID(),
          task.taskId,
          `${task.taskId}/develop/2`,
          'develop 声称 implemented，但工作区在 git 上没有任何改动（0 文件、0 提交）。',
        ],
      )
    })
    task.observe({ state: 'passed' })
    expect(await task.drive()).toMatchObject({ ok: true, value: { finalStatus: 'S-PR_OPEN' } })
    expect(await task.developRuns()).toBe(2)
  })

  it('转绿解除 CI 等待；重复失败时人工必须提供修复理由并传给 develop', async () => {
    const recovered = await scenario(async () => ok(false))
    await recovered.drive()
    recovered.observe({ state: 'passed' })
    expect(await recovered.drive()).toMatchObject({
      ok: true,
      value: { finalStatus: 'S-PR_OPEN', steps: [{ transition: 'T-045' }] },
    })
    expect(await recovered.developRuns()).toBe(1)

    const task = await scenario(async () => ok(true))
    await task.drive()
    task.observe({ ...failed, evidence: { ...failed.evidence, key: 'second-attempt' } })
    expect(await task.drive()).toMatchObject({ ok: true, value: { finalStatus: 'S-HUMAN_REVIEW' } })
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    const denied = await driver.advance(task.taskId, { type: 'HumanApproved' }, task.deps.now())
    expect(denied).toMatchObject({ ok: true, value: { advanced: false } })
    const approved = await driver.advance(
      task.taskId,
      { type: 'HumanApproved', repairCi: true },
      task.deps.now(),
      { note: '修复 Vitest 输出中已确认的断言' },
    )
    expect(approved).toMatchObject({ ok: true, value: { advanced: true } })
    const context = await asRole('keel_control', async (c) => {
      const run = await c.query<{ id: string }>(
        "SELECT id FROM run WHERE task_id=$1 AND stage='develop' AND attempt=2",
        [task.taskId],
      )
      const runId = run.rows[0]?.id
      if (runId === undefined) throw new Error('返工 run 不存在')
      return new FactPlaneContextBuilder({ Developer: 'developer' }).build(c, {
        task_id: task.taskId,
        run_id: runId,
        role: 'Developer',
        stage: 'develop',
        budget_tokens: 5000,
      })
    })
    expect(
      context.ok
        ? context.value.sections.find((s) => s.id === 'ci_failure')?.content
        : context.error,
    ).toMatch(/修复 Vitest.*[\s\S]+Run Vitest/)
  })
})

/** managed 绑定 + 开工前同步 —— 裸仓库落在 `<root>/repos/<repoId>.git` */
async function prepareFor(git: GitWorkspace, repoId: string): Promise<PreparedProject> {
  const r = await git.prepareProject({ mode: 'managed', repoId }, `file://${origin}`, 'main')
  if (!r.ok) throw new Error(r.error.detail)
  return r.value
}

describe('编排器 CI 接线(opts.ci 优先)', () => {
  it.skipIf(process.platform !== 'darwin')('legacy QA 执行注册检查，PR 拒绝旧 SHA', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId)
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    const deps = depsFor(repoId, git, project)
    const worktree = await git.ensureWorktree(project, taskId)
    if (!worktree.ok) throw new Error(worktree.error.detail)
    const runId = randomUUID()
    await asOwner(async (client) => {
      await client.query('UPDATE repo SET verification_contract=$2::jsonb WHERE id=$1', [
        repoId,
        JSON.stringify({
          version: '1',
          checks: [{ id: 'guard', kind: 'local', argv: ['/usr/bin/grep', 'fixture', 'README.md'] }],
        }),
      ])
      await client.query(
        `INSERT INTO run (id,task_id,stage,role,attempt,status,idempotency_key)
         VALUES ($1,$2,'qa','QA',1,'RUNNING',$3)`,
        [runId, taskId, `${taskId}/qa/1`],
      )
    })
    const binding = await legacyProjectBinding({
      taskId,
      worktree: deps.workspace,
      path: worktree.value.path,
      allowBind: true,
      now: deps.now(),
    })
    if (!binding.ok || binding.value === null) throw new Error('缺少 legacy QA 绑定')
    writeFileSync(join(worktree.value.path, 'README.md'), 'fixture verified\n')
    const committed = await git.commitAll(taskId, 'fixture ready')
    if (!committed.ok) throw new Error(committed.error.detail)
    expect(
      await runLegacyProjectQa({
        taskId,
        worktree: deps.workspace,
        binding: binding.value,
        runId,
        now: deps.now,
        timeoutMs: 5000,
      }),
    ).toMatchObject({ ok: true })
    const evidence = await asOwner((client) =>
      client.query(
        `SELECT payload FROM event WHERE run_id=$1 AND type='ProjectVerificationExecuted'`,
        [runId],
      ),
    )
    const head = await git.headSha(project, taskId)
    if (!head.ok) throw new Error(head.error.detail)
    expect(evidence.rows).toMatchObject([
      {
        payload: {
          head_sha: head.value,
          required_check_ids: ['guard'],
          output_trust: 'untrusted',
          local: [{ id: 'guard', exit_code: 0, output_excerpt: 'fixture verified\n' }],
        },
      },
    ])
    const merged = (headSha: string) =>
      new FakePullRequests({
        number: 7,
        url: `file://${origin}/pull/7`,
        state: 'closed',
        merged: true,
        mergedAt: '2026-08-24T01:02:03Z',
        mergeSha: 'b'.repeat(40),
        closedAt: '2026-08-24T01:02:03Z',
        headSha,
      })
    const ci = new FakeCi('passed')
    expect(
      await runTaskToCompletion(taskId, deps, {
        ci,
        pullRequests: merged(project.baseSha),
      }),
    ).toMatchObject({ ok: false, error: { kind: 'STALE_EVIDENCE' } })
    expect(
      await runTaskToCompletion(taskId, deps, { ci, pullRequests: merged(head.value) }),
    ).toMatchObject({ ok: true, value: { finalStatus: 'S-DONE' } })
  })

  it('waitForCi=passed → T-042 留在 S-PR_OPEN；PR merged → T-024 → S-DONE', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId)
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    // 分支要有 HEAD 才能读 SHA —— 在**裸仓库**(编排器读的就是它)里建出该 Task 的分支
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('passed')
    const result = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 4,
      ci,
      externalCi: async () => {
        throw new Error('externalCi 不应被调用 —— opts.ci 优先')
      },
    })

    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-PR_OPEN')
    expect(result.value.stopReason).toBe('awaiting-pr-merge')
    expect(await statusOf(taskId)).toBe('S-PR_OPEN')

    expect(ci.calls.length).toBe(1)
    const expectedSha = execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'rev-parse', `refs/heads/${branchFor(taskId)}`],
      { encoding: 'utf8' },
    ).trim()
    expect(ci.calls[0]?.headSha).toBe(expectedSha)
    expect(ci.calls[0]?.remoteUrl).toBe(`file://${origin}`)

    const stepsNote = result.value.steps.map((s) => s.note).join('|')
    expect(stepsNote).toContain('外部 CI（GitHub）：passed')
    expect(stepsNote).not.toContain('PR 已合并')

    const ciEvents = await asOwner((c) =>
      c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
         AND payload->>'event'='CIPassed' ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(ciEvents.rows[0]?.payload).toMatchObject({
      event: 'CIPassed',
      source: 'github',
      transition: 'T-042',
      head_sha: expectedSha,
    })

    const pr = new FakePullRequests({
      number: 7,
      url: `file://${origin}/pull/7`,
      state: 'closed',
      merged: true,
      mergedAt: '2026-08-24T01:02:03Z',
      mergeSha: 'b'.repeat(40),
      closedAt: '2026-08-24T01:02:03Z',
      headSha: expectedSha,
    })
    const done = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 3,
      ci,
      pullRequests: pr,
    })
    expect(done.ok, done.ok ? '' : done.error.detail).toBe(true)
    if (!done.ok) return
    expect(done.value.finalStatus).toBe('S-DONE')
    expect(await statusOf(taskId)).toBe('S-DONE')
    expect(pr.calls).toEqual([{ repoId, remoteUrl: `file://${origin}`, number: 7 }])
    // CI 已通过：第二次驱动不应再等一次 CI
    expect(ci.calls.length).toBe(1)

    const merged = await asOwner((c) =>
      c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
         ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(merged.rows[0]?.payload).toMatchObject({
      event: 'PRMerged',
      transition: 'T-024',
      merged_at: '2026-08-24T01:02:03Z',
      merge_sha: 'b'.repeat(40),
    })
  })

  it('模拟 CI 成功只记录 CI 事实，缺少 PR 观察时仍等待合并', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)

    const result = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 3,
      externalCi: async () => 'passed',
    })
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-PR_OPEN')
    expect(result.value.stopReason).toBe('awaiting-pr-merge')
    expect(result.value.steps.map((s) => s.note).join('|')).toContain('外部 CI（模拟）：passed')

    const events = await asOwner((c) =>
      c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
         AND payload->>'event'='CIPassed' ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(events.rows[0]?.payload).toMatchObject({ event: 'CIPassed', source: 'simulated' })
    const merged = await asOwner((c) =>
      c.query(`SELECT seq FROM event WHERE task_id=$1 AND payload->>'event'='PRMerged'`, [taskId]),
    )
    expect(merged.rows).toHaveLength(0)
  })

  it('PR closed 未合并先于失败 CI 收口 → T-027 → S-ABANDONED，理由可查', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId, 11)
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('failed')
    const result = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 4,
      ci,
      pullRequests: new FakePullRequests({
        number: 11,
        url: `file://${origin}/pull/11`,
        state: 'closed',
        merged: false,
        mergedAt: null,
        mergeSha: null,
        closedAt: '2026-08-24T02:00:00Z',
        headSha: null,
      }),
    })
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-ABANDONED')
    expect(result.value.stopReason).toBe('terminal')
    expect(ci.calls).toEqual([])

    const events = await asOwner((c) =>
      c.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM event WHERE task_id=$1 AND type='TaskStatusChanged'
         ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(events.rows[0]?.payload).toMatchObject({
      event: 'PRClosed',
      transition: 'T-027',
      reason: 'pr_closed_unmerged',
      closed_at: '2026-08-24T02:00:00Z',
    })
  })

  it('仅注入 PR 网关也能复用已记录的 CI 事实 → merged → S-DONE', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId, 12)
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('passed')
    const first = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 3,
      ci,
    })
    expect(first.ok, first.ok ? '' : first.error.detail).toBe(true)
    if (!first.ok) return
    expect(first.value.stopReason).toBe('awaiting-pr-merge')

    const second = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 2,
      pullRequests: new FakePullRequests({
        number: 12,
        url: `file://${origin}/pull/12`,
        state: 'closed',
        merged: true,
        mergedAt: '2026-08-24T03:00:00Z',
        mergeSha: 'c'.repeat(40),
        closedAt: '2026-08-24T03:00:00Z',
        headSha: null,
      }),
    })
    expect(second.ok, second.ok ? '' : second.error.detail).toBe(true)
    if (!second.ok) return
    expect(second.value.finalStatus).toBe('S-DONE')
    expect(ci.calls.length).toBe(1)
  })

  it('merged=true 但缺少 merged_at → PROTOCOL_ERROR，不让异常逃出编排器', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    await seedPullRequest(taskId, 13)
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const result = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 4,
      ci: new FakeCi('passed'),
      pullRequests: new FakePullRequests({
        number: 13,
        url: `file://${origin}/pull/13`,
        state: 'closed',
        merged: true,
        mergedAt: null,
        mergeSha: null,
        closedAt: '2026-08-24T04:00:00Z',
        headSha: null,
      }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('PROTOCOL_ERROR')
    expect(await statusOf(taskId)).toBe('S-PR_OPEN')
  })

  it('waitForCi=failed → CIFailed → T-025 → 回 S-DEVELOPING 并开新 develop run', async () => {
    const { taskId, repoId } = await seedTaskAtPrOpen()
    const git = new GitWorkspace({ root })
    const project = await prepareFor(git, repoId)
    execFileSync(
      'git',
      ['-C', join(root, 'repos', `${repoId}.git`), 'branch', branchFor(taskId), 'main'],
      { stdio: 'pipe' },
    )

    const ci = new FakeCi('failed')
    // maxSteps=1:推进这一步后就停 —— 我们只关心转移与 run 创建
    const result = await runTaskToCompletion(taskId, depsFor(repoId, git, project), {
      maxSteps: 1,
      ci,
    })

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
    expect(events.rows[0]?.payload).toMatchObject({
      from: 'S-PR_OPEN',
      to: 'S-DEVELOPING',
      event: 'CIFailed',
      source: 'github',
    })
  })
})
