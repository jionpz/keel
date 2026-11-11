import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { PullRequestGateway, PullRequestInfo } from '../../contracts/git-provider.js'
import type {
  GitPushGateway,
  GitPushInput,
  GitPushInspectInput,
  GitPushInspectResult,
  GitPushResult,
} from '../../contracts/git-push.js'
import type { ManagedActionGatewayResult } from '../../contracts/managed.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import { GitCliPushGateway } from '../../fact/git-push.js'
import type { DelegationPolicyVersion, ManagedExecutionPermit } from '../../generated/managed.js'
import {
  type ManagedActionGatewayDeps,
  reconcileAction,
  runActionGatewayOnce,
} from './action-gateway.js'
import {
  enqueueActionIntent,
  getActionIntent,
  getActionOutbox,
  settleActionSuccess,
} from './action-store.js'
import { recordDelegationPolicy, revokeDelegationPolicy } from './decision-store.js'
import { createManagedTicketTask, getManagedTicket } from './ticket-runtime.js'
import { fixtureTicketPackage } from './ticket-test-utils.js'
import { diffDigest } from './ticket-workspace.js'

const run = promisify(execFile)
const NOW = '2026-11-11T00:00:00.000Z'
const LATER = '2026-11-11T00:01:00.000Z'

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

class FakePullRequests implements PullRequestGateway {
  calls = 0
  readonly byBranch = new Map<string, PullRequestInfo>()

  async createPullRequest(input: {
    headBranch: string
    baseBranch: string
  }): Promise<Result<PullRequestInfo>> {
    this.calls++
    const existing = this.byBranch.get(input.headBranch)
    if (existing !== undefined) return ok({ ...existing, created: false })
    const created = {
      number: this.byBranch.size + 1,
      url: `https://example.test/pull/${this.byBranch.size + 1}`,
      created: true,
    }
    this.byBranch.set(input.headBranch, created)
    return ok(created)
  }
}

class FlakyPush implements GitPushGateway {
  constructor(private readonly inner: GitPushGateway) {}

  async inspect(input: GitPushInspectInput): Promise<Result<GitPushInspectResult>> {
    return this.inner.inspect(input)
  }

  async push(input: GitPushInput): Promise<Result<GitPushResult>> {
    const pushed = await this.inner.push(input)
    if (!pushed.ok) return pushed
    return err(makeError('HARNESS_UNAVAILABLE', 'simulated gateway crash after push'))
  }
}

interface Seeded {
  readonly taskId: string
  readonly outboxId: string
  readonly root: string
  readonly remote: string
  readonly head: string
  readonly policyId: string
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

async function seedAction(options: { readonly stale?: boolean } = {}): Promise<Seeded> {
  const base = await mkdtemp(join(tmpdir(), 'keel-action-'))
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
  await writeFile(packagePath, JSON.stringify(fixtureTicketPackage({ ticketId: 'JT-02D' })))
  const created = await createManagedTicketTask(repoId, packagePath, root)
  if (!created.ok) throw new Error(created.error.detail)
  const baseline = await git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'feature.txt'), 'feature\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'feature')
  const head = await git(root, 'rev-parse', 'HEAD')
  const diff = await diffDigest(root, baseline, head)
  if (!diff.ok) throw new Error(diff.error.detail)
  const policy = policyFor(repoId)
  const recorded = await recordDelegationPolicy(policy)
  if (!recorded.ok) throw new Error(recorded.error.detail)
  const enqueued = await asRole('keel_control', (c) =>
    enqueueActionIntent(c, {
      task_id: created.value,
      project_id: repoId,
      repo_id: repoId,
      remote_url: `file://${remote}`,
      base_branch: 'main',
      head_branch: 'ai/ticket-gateway',
      head_sha: options.stale ? baseline : head,
      diff_digest: diff.value,
      environment: 'production',
      reversibility: 'reversible',
      affected_resources: [`file://${remote}`, 'branch:ai/ticket-gateway', 'base:main'],
      pr_title: 'JT-02D fixture',
      pr_body: 'fixture body',
      created_at: NOW,
    }),
  )
  if (options.stale) {
    const next = join(root, 'next.txt')
    await writeFile(next, 'next\n')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-m', 'next')
  }
  return {
    taskId: created.value,
    outboxId: enqueued.outboxId,
    root,
    remote: `file://${remote}`,
    head,
    policyId: policy.id,
  }
}

function policyFor(projectId: string): DelegationPolicyVersion {
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
        required_checks: [],
        mode: 'delegated',
      },
    ],
    created_at: '2026-11-10T00:00:00.000Z',
  } as unknown as DelegationPolicyVersion
}

function deps(
  push: GitPushGateway,
  pullRequests: PullRequestGateway,
  now = NOW,
): ManagedActionGatewayDeps {
  return { push, pullRequests, now: () => now }
}

function requireResult(
  result: Result<ManagedActionGatewayResult | null>,
): ManagedActionGatewayResult {
  if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.detail}`)
  if (result.value === null) throw new Error('gateway 没有认领 action')
  return result.value
}

describe('managed action gateway', () => {
  it('重验 SHA/diff/授权后推送并幂等创建 PR', async () => {
    const seeded = await seedAction()
    const pullRequests = new FakePullRequests()
    const push = new GitCliPushGateway(null)
    const first = requireResult(await runActionGatewayOnce(deps(push, pullRequests)))
    expect(first.status).toBe('SUCCEEDED')
    expect(first.prNumber).toBe(1)
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok).toBe(true)
    if (task.ok) {
      expect(task.value.status).toBe('PR_OPENED')
      expect(task.value.handoff).toMatchObject({ pull_request: { number: 1 } })
    }
    const outbox = await getActionOutbox(seeded.outboxId)
    const permit = (
      await asOwner((c) =>
        c.query('SELECT * FROM managed_execution_permit WHERE action_intent_id=$1', [
          outbox?.action_intent_id,
        ]),
      )
    ).rows[0]
    expect(permit).toMatchObject({
      status: 'CONSUMED',
      authorization_version: 1,
      expected_sha: seeded.head,
      environment: 'production',
    })
    expect(String(permit?.target_digest)).toMatch(/^[a-f0-9]{64}$/)

    const intent = await getActionIntent(String(permit?.action_intent_id))
    expect(intent).not.toBeNull()
    expect(outbox).not.toBeNull()
    if (intent !== null && outbox !== null) {
      const stale = await settleActionSuccess(
        { outbox, intent },
        permit as unknown as ManagedExecutionPermit,
        { number: 99, url: 'https://example.test/pull/99', created: false },
        LATER,
      )
      expect(stale.ok).toBe(false)
    }

    const second = await runActionGatewayOnce(deps(push, pullRequests, LATER))
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value).toBeNull()
    expect(pullRequests.calls).toBe(1)
  })

  it('授权撤销后阻止动作，不推送', async () => {
    const seeded = await seedAction()
    const revoked = await revokeDelegationPolicy(seeded.policyId, 'owner', 'fixture revoke', LATER)
    expect(revoked.ok).toBe(true)
    const pullRequests = new FakePullRequests()
    const push = new GitCliPushGateway(null)
    const result = requireResult(await runActionGatewayOnce(deps(push, pullRequests, LATER)))
    expect(result.status).toBe('BLOCKED')
    expect(pullRequests.calls).toBe(0)
    const remote = await push.inspect({
      worktreePath: seeded.root,
      remoteUrl: seeded.remote,
      headBranch: 'ai/ticket-gateway',
    })
    expect(remote.ok).toBe(true)
    if (remote.ok) expect(remote.value.state).toBe('absent')
  })

  it('worktree HEAD 变化后阻止旧 intent', async () => {
    await seedAction({ stale: true })
    const pullRequests = new FakePullRequests()
    const result = requireResult(
      await runActionGatewayOnce(deps(new GitCliPushGateway(null), pullRequests, LATER)),
    )
    expect(result.status).toBe('BLOCKED')
    expect(pullRequests.calls).toBe(0)
  })

  it('外部结果未知时进入 UNCERTAIN，回查远端后完成而不重复推送', async () => {
    const seeded = await seedAction()
    const real = new GitCliPushGateway(null)
    const flaky = new FlakyPush(real)
    const pullRequests = new FakePullRequests()
    const first = requireResult(await runActionGatewayOnce(deps(flaky, pullRequests)))
    expect(first.status).toBe('UNCERTAIN')
    const uncertain = await getActionOutbox(seeded.outboxId)
    expect(uncertain?.status).toBe('UNCERTAIN')
    const reconciled = await reconcileAction(seeded.outboxId, deps(real, pullRequests, LATER))
    expect(reconciled.ok).toBe(true)
    if (!reconciled.ok) throw new Error(reconciled.error.detail)
    expect(reconciled.value.status).toBe('SUCCEEDED')
    expect(reconciled.value.prNumber).toBe(1)
    expect(pullRequests.calls).toBe(1)
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok).toBe(true)
    if (task.ok) expect(task.value.status).toBe('PR_OPENED')
  })
})
