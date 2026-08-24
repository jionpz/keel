/**
 * CreatePullRequest 副作用的 driver 层单测 —— **确定性**验证，不碰真实 GitHub。
 *
 * 覆盖 implement.md Stage 4.4:
 *   - 注入 fake gateway + 本地 git remote → 真实执行,事件流出现
 *     SideEffectApplied(首次)/ SideEffectSkipped(复用)
 *   - 未注入 gateway → SideEffectIntent(不假装成功)—— 与既有
 *     「CreateBranch 记意图」同一条纪律,这里钉住 CreatePullRequest
 *
 * 用 fake gateway 是因为本层要验的是**副作用记账是否诚实**,
 * gateway 的真实行为由 github-provider.test.ts(stub HTTP)与
 * 验收测试(真 GitHub)分层覆盖。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../../contracts/errors.js'
import type {
  PullRequestGateway,
  PullRequestInfo,
  PullRequestInput,
} from '../../contracts/git-provider.js'
import type { Proposal } from '../../contracts/types.js'
import { PgArtifactStore } from '../../fact/artifact-store.js'
import { asOwner, closePool } from '../../fact/db.js'
import { branchFor, GitWorkspace } from '../../fact/git-workspace.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { WorkflowDriver } from './driver.js'

const NOW = '2026-08-23T12:00:00Z'
const store = new PgArtifactStore()
/** artifact-store.commit 的提交上下文 —— 与 driver.test.ts 相同的最小形态 */
const commitCtx = {
  run_id: null,
  verdict: { accepted: true, artifact_ref: null, violations: [] },
  emit_event: true,
} as const

/** 记录调用的 fake gateway:返回值可编程 */
class FakeGateway implements PullRequestGateway {
  readonly calls: PullRequestInput[] = []
  constructor(private readonly response: (n: number) => Result<PullRequestInfo>) {}

  async createPullRequest(input: PullRequestInput): Promise<Result<PullRequestInfo>> {
    this.calls.push(input)
    return this.response(this.calls.length)
  }
}

function firstTimeCreated(): FakeGateway {
  let created = false
  return new FakeGateway(() => {
    if (!created) {
      created = true
      return ok({ number: 42, url: 'file://remote/pull/42', created: true })
    }
    return ok({ number: 42, url: 'file://remote/pull/42', created: false })
  })
}

let origin: string
let root: string

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  origin = mkdtempSync(join(tmpdir(), 'keel-pr-origin-'))
  root = mkdtempSync(join(tmpdir(), 'keel-pr-root-'))
  execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: origin })
  execFileSync('git', ['config', 'user.email', 'o@test'], { cwd: origin })
  execFileSync('git', ['config', 'user.name', 'o'], { cwd: origin })
  writeFileSync(join(origin, 'README.md'), '# base\n')
  execFileSync('git', ['add', '.'], { cwd: origin })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: origin })
})

afterAll(async () => {
  rmSync(origin, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  await closePool()
})

async function seedTaskWithRemote(): Promise<{ taskId: string; repoId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'local',$2,'main')`,
      [repoId, `file://${origin}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-REVIEW','PR 副作用测试',$2,'main',$3)`,
      [taskId, repoId, branchFor(taskId)],
    )
  })
  // push 要求分支存在于裸仓库 —— 直接从 base 建出来,模拟 develop 已提交的事实
  execFileSync('git', ['-C', join(root), 'clone', '-q', `file://${origin}`, 'seed'], {
    stdio: 'pipe',
  })
  execFileSync(
    'git',
    [
      '-C',
      join(root, 'seed'),
      'push',
      '-q',
      `file://${origin}`,
      `HEAD:refs/heads/${branchFor(taskId)}`,
    ],
    { stdio: 'pipe' },
  )

  // T-021 的 guard 读最新 A-StageOutcome 的 verdict —— review 阶段须为 pass
  const p: Proposal = {
    proposal_id: randomUUID(),
    task_id: taskId,
    kind: 'stage_outcome',
    key: 'review',
    body: {
      schema_version: '1.0',
      run_id: 'run-review',
      stage: 'review',
      verdict: 'pass',
      reason: '测试:review 通过',
    },
    supersedes: null,
    produced_by_run: 'run-review',
  }
  const committed = await store.commit(p, commitCtx)
  expect(committed.ok).toBe(true)

  return { taskId, repoId }
}

async function eventsOf(
  taskId: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const r = await store.readEvents(taskId, 0, 200)
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error('unreachable')
  return r.value.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }))
}

describe('CreatePullRequest 副作用记账', () => {
  it('注入 gateway → 真实执行,SideEffectApplied 含 pr_number / pr_url / head_branch', async () => {
    const { taskId, repoId } = await seedTaskWithRemote()
    const git = await (async () => {
      const g = new GitWorkspace({ root })
      expect((await g.ensureBareRepo(repoId, `file://${origin}`)).ok).toBe(true)
      return g
    })()
    const gateway = firstTimeCreated()
    const driver = new WorkflowDriver(
      new RuleBasedPolicyEngine(DEFAULT_RULESET),
      { git, repoId, baseBranch: 'main' },
      gateway,
    )

    const r = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'review' }, NOW)
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.to).toBe('S-PR_OPEN')

    // gateway 收到的输入:head 分支由 taskId 决定,不含任何凭据
    expect(gateway.calls.length).toBe(1)
    const input = gateway.calls[0]
    expect(input?.headBranch).toBe(branchFor(taskId))
    expect(input?.baseBranch).toBe('main')

    // 远端真的收到了这个分支
    const branches = execFileSync('git', ['-C', origin, 'branch', '--list'], {
      encoding: 'utf8',
    })
    expect(branches).toContain(branchFor(taskId))

    const evs = await eventsOf(taskId)
    const applied = evs.find((e) => e.type === 'SideEffectApplied')
    expect(applied, '应有 SideEffectApplied').toBeDefined()
    expect(applied?.payload.kind).toBe('CreatePullRequest')
    expect(applied?.payload.pr_number).toBe(42)
    expect(applied?.payload.pr_url).toBe('file://remote/pull/42')
    expect(applied?.payload.head_branch).toBe(branchFor(taskId))

    // payload 不含凭据形状的字段
    expect(JSON.stringify(applied?.payload)).not.toMatch(/token|credential/i)
  })

  it('gateway 报已存在 → SideEffectSkipped,不重复创建', async () => {
    const { taskId, repoId } = await seedTaskWithRemote()
    const git = new GitWorkspace({ root })
    await git.ensureBareRepo(repoId, `file://${origin}`)
    const gateway = new FakeGateway((n) =>
      n === 1
        ? ok({ number: 7, url: 'u7', created: false })
        : ok({ number: 99, url: 'x', created: true }),
    )
    const driver = new WorkflowDriver(
      new RuleBasedPolicyEngine(DEFAULT_RULESET),
      { git, repoId, baseBranch: 'main' },
      gateway,
    )

    const r = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'review' }, NOW)
    expect(r.ok && r.value.to === 'S-PR_OPEN').toBe(true)

    // 只调用过一次,且走了 skipped 分支 —— 幂等复用,不是新建
    expect(gateway.calls.length).toBe(1)
    const evs = await eventsOf(taskId)
    const skipped = evs.find((e) => e.type === 'SideEffectSkipped')
    expect(skipped, '应有 SideEffectSkipped').toBeDefined()
    expect(skipped?.payload.pr_number).toBe(7)
    expect(evs.some((e) => e.type === 'SideEffectApplied')).toBe(false)
  })

  it('未注入 gateway → SideEffectIntent,不报错也不假装成功', async () => {
    const { taskId, repoId } = await seedTaskWithRemote()
    const git = new GitWorkspace({ root })
    await git.ensureBareRepo(repoId, `file://${origin}`)
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), {
      git,
      repoId,
      baseBranch: 'main',
    })

    const r = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'review' }, NOW)
    expect(r.ok && r.value.to === 'S-PR_OPEN').toBe(true)

    const evs = await eventsOf(taskId)
    const intent = evs.find((e) => e.type === 'SideEffectIntent')
    expect(intent, '应有 SideEffectIntent').toBeDefined()
    expect(intent?.payload.kind).toBe('CreatePullRequest')
  })
})
