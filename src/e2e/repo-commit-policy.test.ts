/** 使用脚本化 Developer、真实 PostgreSQL 与 git 验证提交门禁，不调用模型或外部服务。 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { ZERO_USAGE } from '../contracts/types.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { collectGitDiff } from '../execution/adapters/git-diff.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor, GitWorkspace } from '../fact/git-workspace.js'

function git(path: string, ...args: string[]): string {
  return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trim()
}

class DeveloperAdapter implements HarnessAdapter {
  readonly developerPrompts: string[] = []
  private current: RunSpec | undefined
  private baseline: string | null = null
  private rejectedTurns = 0

  constructor(
    private readonly badTurns: number,
    private readonly selfCommit = false,
  ) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: 'scripted-developer',
      version: '0',
      tier: 'L0',
      capabilities: ['CAP-UNTRUSTED_WORKSPACE'],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }
  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.current = spec
    this.baseline = git(spec.workspace.path, 'rev-parse', 'HEAD')
    if (spec.run.stage === 'develop') {
      this.developerPrompts.push(spec.context.sections.map((s) => s.content).join('\n'))
      writeFileSync(
        join(spec.workspace.path, 'feature.txt'),
        `修改 ${this.developerPrompts.length}\n`,
      )
      if (this.selfCommit) {
        git(spec.workspace.path, 'add', 'feature.txt')
        git(
          spec.workspace.path,
          '-c',
          'user.name=机器人',
          '-c',
          'user.email=bot@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          `feat(fact): 不合规的自行提交\n\nKeel-Run: ${spec.run.run_id} stage=develop`,
        )
      }
    }
    return ok({ run_id: spec.run.run_id, harness_id: 'scripted-developer' })
  }
  async awaitResult(): Promise<Result<RunResult>> {
    const spec = this.current
    if (spec === undefined) throw new Error('缺少当前 run')
    const stage = spec.run.stage
    const body =
      stage === 'rfc_draft'
        ? {
            schema_version: '1.0',
            title: '修复',
            problem: '问题',
            goals: ['修复'],
            non_goals: [],
            proposed_change: { summary: '修复', affected_areas: ['fact'], approach: '修改文件' },
            acceptance_criteria: [{ id: 'AC1', text: '修复有效', verifiable_by: '测试' }],
            policy_facts: {
              risk: 'low',
              complexity: 'low',
              estimated_files_changed: 1,
              security_related: false,
            },
          }
        : {
            schema_version: '1.0',
            run_id: spec.run.run_id,
            stage,
            verdict: stage === 'pm' ? 'actionable' : stage === 'develop' ? 'implemented' : 'pass',
            reason: '脚本化结果',
            ...(stage === 'pm' ? { details: { needs_design: false } } : {}),
            ...(stage === 'develop'
              ? {
                  commit_message: {
                    type: ++this.rejectedTurns <= this.badTurns ? 'feat' : 'fix',
                    scope: 'fact',
                    summary: '修复提交规范',
                  },
                }
              : {}),
          }
    return ok({
      status: 'SUCCEEDED',
      text: JSON.stringify(body),
      proposals: [],
      usage: ZERO_USAGE,
      session_ref: null,
    })
  }
  async collectChanges(): Promise<Result<WorkspaceDiff>> {
    if (this.current === undefined) throw new Error('缺少当前 run')
    return collectGitDiff(this.current.workspace.path, { since: this.baseline })
  }
  async interrupt(): Promise<Result<void>> {
    return ok(undefined)
  }
  async dispose(): Promise<Result<DisposeReport>> {
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}

let root: string
let origin: string
beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  root = mkdtempSync(join(tmpdir(), 'keel-policy-e2e-'))
  origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Fixture')
  git(origin, 'config', 'user.email', 'fixture@test')
  git(origin, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(origin, 'README.md'), '# base\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'init')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
afterAll(closePool)

async function setup(check: string, badTurns: number, selfCommit = false) {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const remoteUrl = `file://${origin}`
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch, commit_author,
       commit_message_template, commit_message_check, commit_types, commit_scopes)
       VALUES ($1,'local',$2,'main','机器人 <bot@example.com>',
       '{type}({scope}): {summary}',$3,ARRAY['fix','feat'],ARRAY['fact'])`,
      [repoId, remoteUrl, check],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
      VALUES ($1,'S-NEW','修复提交规范',$2,'main',$3)`,
      [taskId, repoId, branchFor(taskId)],
    )
  })
  const workspaceGit = new GitWorkspace({ root: join(root, 'keel') })
  const project = await workspaceGit.prepareProject({ mode: 'managed', repoId }, remoteUrl, 'main')
  if (!project.ok) throw new Error(project.error.detail)
  if (check === 'hook') {
    const hook = join(project.value.gitDir, 'hooks', 'commit-msg')
    writeFileSync(
      hook,
      '#!/bin/sh\ntest -f feature.txt || exit 9\ngrep -q "^fix(fact):" "$1" || { echo "hook: 需要 fix header" >&2; exit 1; }\n',
      { mode: 0o755 },
    )
  }
  const adapter = new DeveloperAdapter(badTurns, selfCommit)
  let pullRequests = 0
  const deps = {
    driver: new WorkflowDriver(
      new RuleBasedPolicyEngine(DEFAULT_RULESET),
      {
        git: workspaceGit,
        repoId,
        project: project.value,
      },
      {
        async createPullRequest() {
          pullRequests++
          return ok({ number: 1, url: 'https://example.test/pr/1', created: true })
        },
      },
    ),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'worktree', git: workspaceGit, repoId, project: project.value } as const,
    now: () => '2026-11-13T12:00:00Z',
  }
  return {
    taskId,
    adapter,
    deps,
    project: project.value,
    workspaceGit,
    pullRequests: () => pullRequests,
  }
}

async function evidence(taskId: string) {
  return asOwner(async (c) => ({
    runs: (
      await c.query(
        `SELECT status, error_detail, attempt FROM run WHERE task_id=$1 AND stage='develop' ORDER BY attempt`,
        [taskId],
      )
    ).rows,
    rejected: (
      await c.query(
        `SELECT payload FROM event WHERE task_id=$1 AND type='ProposalRejected' ORDER BY seq`,
        [taskId],
      )
    ).rows,
    notified: (
      await c.query(
        `SELECT payload FROM event WHERE task_id=$1 AND payload->>'kind'='NotifyHuman'`,
        [taskId],
      )
    ).rows,
  }))
}

describe('仓库提交门禁的真实编排', () => {
  it.each(['^fix\\(fact\\): .+$', 'hook'])(
    '%s 拒绝后回灌 Developer，修正后才交付',
    async (check) => {
      const fixture = await setup(check, 1)
      const result = await runTaskToCompletion(fixture.taskId, fixture.deps)
      expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
      expect(result.ok && result.value.finalStatus).toBe('S-PR_OPEN')
      expect(fixture.adapter.developerPrompts).toHaveLength(2)
      expect(fixture.adapter.developerPrompts[1]).toContain('commit_message_rejected:')
      expect(fixture.adapter.developerPrompts[0]).toContain('summary 使用来源 issue 的语言')
      const facts = await evidence(fixture.taskId)
      expect(facts.runs).toEqual([{ status: 'SUCCEEDED', error_detail: null, attempt: 1 }])
      expect(facts.rejected).toHaveLength(1)
      expect(fixture.pullRequests()).toBe(1)
      const message = git(
        origin,
        'log',
        '-1',
        '--format=%an <%ae>|%cn <%ce>|%G?%n%B',
        branchFor(fixture.taskId),
      )
      expect(message).toMatch(
        /^机器人 <bot@example.com>\|机器人 <bot@example.com>\|N\nfix\(fact\): 修复提交规范\n\nKeel-Run: \S+ stage=develop$/u,
      )
    },
  )

  it('run 内三次拒绝后重新派发 Developer，失败原因进入下一 run 的 prompt', async () => {
    const fixture = await setup('^fix\\(fact\\): .+$', 3)
    const result = await runTaskToCompletion(fixture.taskId, fixture.deps)
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    expect(fixture.adapter.developerPrompts).toHaveLength(4)
    expect(fixture.adapter.developerPrompts[3]).toContain(
      '上次提交被拒绝，请修正：commit_message_rejected:',
    )
    const facts = await evidence(fixture.taskId)
    expect(facts.runs.map((run) => run.status)).toEqual(['FAILED', 'SUCCEEDED'])
    expect(fixture.pullRequests()).toBe(1)
  })

  it('Harness 自行提交后工作树干净，历史门禁仍回灌并在重试耗尽后阻止交付', async () => {
    const fixture = await setup('^fix\\(fact\\): .+$', 0, true)
    const result = await runTaskToCompletion(fixture.taskId, fixture.deps)
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    expect(result.ok && result.value.finalStatus).toBe('S-HUMAN_REVIEW')
    const facts = await evidence(fixture.taskId)
    expect(facts.runs).toHaveLength(3)
    expect(facts.runs.every((run) => run.status === 'FAILED')).toBe(true)
    expect(facts.rejected).toHaveLength(9)
    expect(fixture.adapter.developerPrompts).toHaveLength(9)
    expect(fixture.adapter.developerPrompts[1]).toContain('header 不匹配正则')
    expect(facts.notified).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ reason: 'commit_message_rejected' }),
      }),
    ])
    const path = fixture.workspaceGit.preservePath(fixture.taskId)
    expect(git(path, 'status', '--porcelain')).toBe('')
    expect(git(path, 'rev-parse', 'HEAD')).not.toBe(fixture.project.baseSha)
    expect(git(path, 'rev-list', '--count', `${fixture.project.baseSha}..HEAD`)).toBe('9')
    expect(fixture.pullRequests()).toBe(0)
    expect(git(origin, 'for-each-ref', `refs/heads/${branchFor(fixture.taskId)}`)).toBe('')
  })

  it.each(['^fix\\(fact\\): .+$', 'hook'])(
    '%s 持续拒绝：不推送、不创建 PR，超限以闭合理由升人工',
    async (check) => {
      const fixture = await setup(check, 100)
      const result = await runTaskToCompletion(fixture.taskId, fixture.deps)
      expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
      expect(result.ok && result.value.finalStatus).toBe('S-HUMAN_REVIEW')
      const facts = await evidence(fixture.taskId)
      expect(facts.runs).toHaveLength(3)
      for (const run of facts.runs) {
        expect(run.status).toBe('FAILED')
        expect(run.error_detail).toMatch(/^commit_message_rejected:/)
      }
      expect(facts.rejected).toHaveLength(9)
      expect(facts.notified).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ reason: 'commit_message_rejected' }),
        }),
      ])
      expect(fixture.pullRequests()).toBe(0)
      expect(git(origin, 'for-each-ref', `refs/heads/${branchFor(fixture.taskId)}`)).toBe('')
      const path = fixture.workspaceGit.preservePath(fixture.taskId)
      expect(git(path, 'rev-parse', 'HEAD')).toBe(fixture.project.baseSha)
      expect(git(path, 'status', '--porcelain')).toContain('feature.txt')
    },
  )
})
