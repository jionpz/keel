import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../../contracts/errors.js'
import type { PullRequestGateway, PullRequestInfo } from '../../contracts/git-provider.js'
import type {
  GitPushGateway,
  GitPushInput,
  GitPushInspectInput,
  GitPushInspectResult,
  GitPushResult,
} from '../../contracts/git-push.js'
import type { ManagedCheckGatewayResult } from '../../contracts/managed.js'
import type {
  RequiredCheckFact,
  RequiredCheckGateway,
  RequiredCheckObservationInput,
  RequiredCheckSnapshot,
} from '../../contracts/required-checks.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type { DelegationPolicyVersion } from '../../generated/managed.js'
import { runActionGatewayOnce } from './action-gateway.js'
import { enqueueActionIntent } from './action-store.js'
import { runCheckGatewayOnce } from './check-gateway.js'
import { listCheckEvidence } from './check-store.js'
import { recordDelegationPolicy, revokeDelegationPolicy } from './decision-store.js'
import { createManagedTicketTask, getManagedTicket } from './ticket-runtime.js'
import { fixtureTicketPackage } from './ticket-test-utils.js'
import { diffDigest } from './ticket-workspace.js'

const run = promisify(execFile)
const NOW = '2026-11-11T00:00:00.000Z'
const LATER = '2026-11-11T00:01:00.000Z'
const PR_NUMBER = 7
const PR_URL = 'https://example.test/pull/7'
const ALT_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return result.stdout.trim()
}

class FakePush implements GitPushGateway {
  constructor(private readonly expectedSha: string) {}

  async inspect(_input: GitPushInspectInput): Promise<Result<GitPushInspectResult>> {
    return ok({ state: 'present', headSha: this.expectedSha })
  }

  async push(input: GitPushInput): Promise<Result<GitPushResult>> {
    return ok({ headSha: input.headSha, created: true })
  }
}

class FakePullRequests implements PullRequestGateway {
  async createPullRequest(): Promise<Result<PullRequestInfo>> {
    return ok({ number: PR_NUMBER, url: PR_URL, created: true })
  }
}

class FakeChecks implements RequiredCheckGateway {
  calls = 0
  patch: Partial<RequiredCheckSnapshot> = {}
  facts: readonly RequiredCheckFact[] = [
    {
      name: 'test',
      source: 'check_run',
      conclusion: 'success',
      externalId: 'run-1',
      detailsUrl: 'https://example.test/check/1',
    },
  ]

  async observeRequiredChecks(
    input: RequiredCheckObservationInput,
  ): Promise<Result<RequiredCheckSnapshot>> {
    this.calls++
    return ok({
      repoId: input.repoId,
      repo: 'acme/widget',
      remoteUrl: input.remoteUrl,
      prNumber: input.prNumber,
      prUrl: PR_URL,
      prState: 'open',
      headBranch: 'ai/ticket-gateway',
      baseBranch: 'main',
      headSha: '1111111111111111111111111111111111111111',
      observedAt: input.observedAt,
      checks: this.facts,
      ...this.patch,
    })
  }
}

interface Seeded {
  readonly taskId: string
  readonly root: string
  readonly head: string
  readonly policyId: string
}

function policyFor(projectId: string, requiredChecks: readonly string[]): DelegationPolicyVersion {
  return {
    schema_version: '1.0',
    id: randomUUID(),
    policy_id: 'ticket-delivery',
    version: 1,
    project_id: projectId,
    approved_by_owner: 'owner',
    approved_at: '2026-11-10T00:00:00.000Z',
    valid_from: '2026-11-10T00:00:00.000Z',
    rules: [
      {
        id: 'push-pr',
        decision_kinds: ['approval'],
        actions: ['push_and_pr'],
        resource_selectors: ['*'],
        environments: ['production'],
        reversibility: 'reversible',
        impact_limits: {
          environments: ['production'],
          reversibilities: ['reversible'],
          max_affected_resources: 8,
        },
        budget_limits: {},
        required_evidence: [],
        required_checks: [...requiredChecks],
        mode: 'delegated',
      },
    ],
    created_at: '2026-11-10T00:00:00.000Z',
  } as unknown as DelegationPolicyVersion
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

async function seedAction(
  options: { readonly requiredChecks?: readonly string[]; readonly checkTimeoutMs?: number } = {},
): Promise<Seeded & { readonly checks: FakeChecks; readonly targetId: string }> {
  const base = await mkdtemp(join(tmpdir(), 'keel-check-'))
  const remote = join(base, 'remote.git')
  const root = join(base, 'repo')
  await run('git', ['init', '--bare', remote])
  await run('git', ['init', '-b', 'main', root])
  await git(root, 'config', 'user.name', 'Keel Test')
  await git(root, 'config', 'user.email', 'keel@example.test')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'initial')
  await git(root, 'checkout', '-b', 'ai/ticket-gateway')
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
       VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${remote}`, root],
    ),
  )
  const packagePath = join(base, 'ticket-package.json')
  await writeFile(packagePath, JSON.stringify(fixtureTicketPackage({ ticketId: 'JT-02E' })))
  const created = await createManagedTicketTask(repoId, packagePath, root)
  if (!created.ok) throw new Error(created.error.detail)
  const baseline = await git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'feature.txt'), 'feature\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'feature')
  const head = await git(root, 'rev-parse', 'HEAD')
  const diff = await diffDigest(root, baseline, head)
  if (!diff.ok) throw new Error(diff.error.detail)
  const policy = policyFor(repoId, options.requiredChecks ?? ['test'])
  const recorded = await recordDelegationPolicy(policy)
  if (!recorded.ok) throw new Error(recorded.error.detail)
  await asRole('keel_control', (c) =>
    enqueueActionIntent(c, {
      task_id: created.value,
      project_id: repoId,
      repo_id: repoId,
      remote_url: `file://${remote}`,
      base_branch: 'main',
      head_branch: 'ai/ticket-gateway',
      head_sha: head,
      diff_digest: diff.value,
      environment: 'production',
      reversibility: 'reversible',
      affected_resources: [`file://${remote}`, 'branch:ai/ticket-gateway', 'base:main'],
      pr_title: 'JT-02E fixture',
      pr_body: 'fixture body',
      created_at: NOW,
    }),
  )
  const checks = new FakeChecks()
  checks.patch = { headSha: head }
  const gateway = await runActionGatewayOnce({
    push: new FakePush(head),
    pullRequests: new FakePullRequests(),
    now: () => NOW,
    ...(options.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: options.checkTimeoutMs }),
  })
  if (!gateway.ok || gateway.value === null || gateway.value.status !== 'SUCCEEDED')
    throw new Error('fixture action gateway 未成功')
  const evidence = await listCheckEvidence({ taskId: created.value })
  const targetId = evidence[0]?.target.id
  if (targetId === undefined) throw new Error('fixture 没有 check target')
  return {
    taskId: created.value,
    root,
    head,
    policyId: policy.id,
    checks,
    targetId,
  }
}

function requireCheckResult(
  result: Result<ManagedCheckGatewayResult | null>,
): ManagedCheckGatewayResult {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.detail}`)
  if (result.value === null) throw new Error('check gateway 没有认领 target')
  return result.value
}

describe('managed required check gateway', () => {
  it('准确 head 的全部 required check 显式 success 后才进入 PR_READY，并保存证据链', async () => {
    const seeded = await seedAction()
    const before = await getManagedTicket(seeded.taskId)
    expect(before.ok && before.value.status).toBe('PR_OPENED')

    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('READY')
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)

    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok && task.value.status).toBe('PR_READY')
    const evidence = await listCheckEvidence({ targetId: seeded.targetId })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.target).toMatchObject({
      status: 'READY',
      head_sha: seeded.head,
      pr_number: PR_NUMBER,
      required_checks: ['test'],
    })
    expect(evidence[0]?.observations).toEqual([
      expect.objectContaining({
        repo: 'acme/widget',
        pr_number: PR_NUMBER,
        head_sha: seeded.head,
        check_name: 'test',
        conclusion: 'success',
        observed_at: LATER,
      }),
    ])
  })

  it('required check 缺失时不完成，截止后进入 PR_CHECKS_FAILED', async () => {
    const seeded = await seedAction({ requiredChecks: ['test', 'integration'] })
    const first = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => NOW }),
    )
    expect(first.status).toBe('CHECKING')
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok && task.value.status).toBe('CHECKING')

    const timedOut = requireCheckResult(
      await runCheckGatewayOnce({
        checks: seeded.checks,
        now: () => '2026-11-11T00:31:00.000Z',
      }),
    )
    expect(timedOut.status).toBe('FAILED')
    expect(timedOut.error).toContain('CHECK_TIMEOUT')
    const failed = await getManagedTicket(seeded.taskId)
    expect(failed.ok && failed.value.status).toBe('PR_CHECKS_FAILED')
  })

  it('pending 或 failure 结论都不能放行', async () => {
    const pending = await seedAction()
    pending.checks.facts = [
      {
        name: 'test',
        source: 'check_run',
        conclusion: 'pending',
        externalId: 'run-2',
        detailsUrl: null,
      },
    ]
    expect(
      requireCheckResult(await runCheckGatewayOnce({ checks: pending.checks, now: () => LATER }))
        .status,
    ).toBe('CHECKING')

    const failure = await seedAction()
    failure.checks.facts = [
      {
        name: 'test',
        source: 'check_run',
        conclusion: 'failure',
        externalId: 'run-3',
        detailsUrl: null,
      },
    ]
    expect(
      requireCheckResult(await runCheckGatewayOnce({ checks: failure.checks, now: () => LATER }))
        .status,
    ).toBe('FAILED')
    const task = await getManagedTicket(failure.taskId)
    expect(task.ok && task.value.status).toBe('PR_CHECKS_FAILED')
  })

  it('SHA-A 的绿色 check 不能满足 SHA-B 目标', async () => {
    const seeded = await seedAction()
    seeded.checks.patch = { headSha: ALT_SHA }
    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('不一致')
    const evidence = await listCheckEvidence({ targetId: seeded.targetId })
    expect(evidence[0]?.observations[0]?.head_sha).toBe(ALT_SHA)
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok && task.value.status).toBe('PR_CHECKS_FAILED')
  })

  it('旧批准撤销后不能凭已创建 PR 进入 PR_READY', async () => {
    const seeded = await seedAction()
    const revoked = await revokeDelegationPolicy(seeded.policyId, 'owner', 'fixture', LATER)
    expect(revoked.ok).toBe(true)
    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('FAILED')
    expect(seeded.checks.calls).toBe(0)
  })

  it('模型或阶段自报 completed 不替代 GitHub check 事实', async () => {
    const seeded = await seedAction()
    await asOwner((c) =>
      c.query(
        `UPDATE managed_ticket_task
         SET handoff=COALESCE(handoff,'{}'::jsonb) || $2::jsonb
         WHERE id=$1`,
        [
          seeded.taskId,
          JSON.stringify({
            completion_target: 'pr_ready',
            self_reported: { status: 'completed', checks: [{ passed: true }] },
          }),
        ],
      ),
    )
    seeded.checks.facts = []
    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('CHECKING')
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok && task.value.status).toBe('CHECKING')
  })

  it('旧 PR 编号与绑定目标不一致时不完成', async () => {
    const seeded = await seedAction()
    seeded.checks.patch = { prNumber: 99 }
    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('FAILED')
    expect(result.error).toContain('PR 编号')
  })

  it('worktree 在 PR 后发生变化时拒绝把 check 绑定到旧提交', async () => {
    const seeded = await seedAction()
    await writeFile(join(seeded.root, 'later.txt'), 'later\n')
    await git(seeded.root, 'add', '-A')
    await git(seeded.root, 'commit', '-m', 'later')
    const result = requireCheckResult(
      await runCheckGatewayOnce({ checks: seeded.checks, now: () => LATER }),
    )
    expect(result.status).toBe('FAILED')
    expect(seeded.checks.calls).toBe(0)
  })
})
