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
import { type ActionAuthorization, authorizeAction } from './action-authorization.js'
import {
  type ManagedActionGatewayDeps,
  reconcileAction,
  runActionGatewayOnce,
} from './action-gateway.js'
import {
  claimActionOutbox,
  enqueueActionIntent,
  getActionIntent,
  getActionOutbox,
  issuePermit,
  markActionExecuting,
  settleActionSuccess,
} from './action-store.js'
import {
  answerManagedTicketDecision,
  listDelegationPolicies,
  openDecisionRequestForTicket,
  overrideManagedTicketDecision,
  recordDelegationPolicy,
  revokeDelegationPolicy,
} from './decision-store.js'
import { pauseManagedTicket } from './ticket-control.js'
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
  readonly repoId: string
  readonly taskId: string
  readonly outboxId: string
  readonly root: string
  readonly remote: string
  readonly head: string
  readonly policyId: string
  readonly decisionRequestId?: string
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterAll(closePool)

async function seedAction(
  options: { readonly stale?: boolean; readonly bindDecision?: boolean } = {},
): Promise<Seeded> {
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
  let decision:
    | {
        request_id: string
        request_revision: number
        resolution_id: string
        digest: string
      }
    | undefined
  if (options.bindDecision === true) {
    const ticket = await getManagedTicket(created.value)
    if (!ticket.ok) throw new Error(ticket.error.detail)
    const request = await openDecisionRequestForTicket(
      {
        task_id: created.value,
        repo_id: repoId,
        stage: 'execute',
        attempt: 1,
        decision_key: 'ticket.action.push',
        kind: 'approval',
        question: '允许 push_and_pr 吗？',
        options: ['停止并等待人工处理（推荐）', '批准本次继续（仅一次）'],
        action_category: 'push_and_pr',
        impact: {
          environment: 'production',
          reversibility: 'reversible',
          affected_resources: [`file://${remote}`, 'branch:ai/ticket-gateway', 'base:main'],
        },
        workflow_digest: ticket.value.package_digest,
        initial_status: 'WAITING_HUMAN',
      },
      NOW,
    )
    if (!request.ok) throw new Error(request.error.detail)
    await asOwner((c) =>
      c.query(
        `UPDATE managed_ticket_task
         SET status='WAITING_HUMAN',pending_decision_id=$2,pending_decision_revision=$3
         WHERE id=$1`,
        [created.value, request.value.id, request.value.revision],
      ),
    )
    const answer = await answerManagedTicketDecision(
      request.value.id,
      request.value.revision,
      'option-2',
      NOW,
    )
    if (!answer.ok) throw new Error(answer.error.detail)
    decision = {
      request_id: answer.value.resolution.request_id,
      request_revision: answer.value.resolution.request_revision,
      resolution_id: answer.value.resolution.id,
      digest: answer.value.resolution.context_digest,
    }
  }
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
      ...(decision === undefined ? {} : { decision }),
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
    repoId,
    taskId: created.value,
    outboxId: enqueued.outboxId,
    root,
    remote: `file://${remote}`,
    head,
    policyId: policy.id,
    ...(decision === undefined ? {} : { decisionRequestId: decision.request_id }),
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

function actionRequestFor(seeded: Seeded) {
  return {
    project_id: seeded.repoId,
    action: 'push_and_pr' as const,
    environment: 'production' as const,
    reversibility: 'reversible' as const,
    affected_resources: [seeded.remote, 'branch:ai/ticket-gateway', 'base:main'],
    now: NOW,
  }
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

  it('签发许可后撤销授权，迟到 gateway 不能开始动作', async () => {
    const seeded = await seedAction()
    const claim = await claimActionOutbox(NOW)
    expect(claim).not.toBeNull()
    if (claim === null) throw new Error('missing action claim')
    const policies = await listDelegationPolicies(seeded.repoId)
    const authorization = authorizeAction(actionRequestFor(seeded), policies)
    expect(authorization.ok).toBe(true)
    if (!authorization.ok) throw new Error(authorization.reason)
    const permit = await issuePermit(
      claim,
      authorization as Extract<ActionAuthorization, { ok: true }>,
      NOW,
    )
    const revoked = await revokeDelegationPolicy(
      seeded.policyId,
      'owner',
      'fixture revoke after permit',
      LATER,
    )
    expect(revoked.ok).toBe(true)
    const mark = await markActionExecuting(claim, permit, LATER)
    expect(mark.ok).toBe(false)
    const outbox = await getActionOutbox(seeded.outboxId)
    expect(outbox?.status).toBe('BLOCKED')
  })

  it('人工暂停立即阻断尚未执行的 outbox，留下控制代次与审计边界', async () => {
    const seeded = await seedAction()
    const paused = await pauseManagedTicket(seeded.taskId, 'owner pause', LATER)
    expect(paused.ok).toBe(true)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.value.blockedOutboxIds).toEqual([seeded.outboxId])
    expect(paused.value.executingOutboxIds).toEqual([])
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok).toBe(true)
    if (task.ok) {
      expect(task.value.status).toBe('PAUSED')
      expect(task.value.control_generation).toBe(1)
    }
    const outbox = await getActionOutbox(seeded.outboxId)
    expect(outbox?.status).toBe('BLOCKED')
    const pullRequests = new FakePullRequests()
    const result = await runActionGatewayOnce(
      deps(new GitCliPushGateway(null), pullRequests, LATER),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeNull()
    expect(pullRequests.calls).toBe(0)
  })

  it('已签发许可后人工暂停，迟到 gateway 不能开始动作', async () => {
    const seeded = await seedAction()
    const claim = await claimActionOutbox(NOW)
    if (claim === null) throw new Error('missing action claim')
    const policies = await listDelegationPolicies(seeded.repoId)
    const authorization = authorizeAction(actionRequestFor(seeded), policies)
    if (!authorization.ok) throw new Error(authorization.reason)
    const permit = await issuePermit(
      claim,
      authorization as Extract<ActionAuthorization, { ok: true }>,
      NOW,
    )
    const paused = await pauseManagedTicket(seeded.taskId, 'owner pause after permit', LATER)
    expect(paused.ok).toBe(true)
    const mark = await markActionExecuting(claim, permit, LATER)
    expect(mark.ok).toBe(false)
    const outbox = await getActionOutbox(seeded.outboxId)
    expect(outbox?.status).toBe('BLOCKED')
  })

  it('已 EXECUTING 后人工暂停，成功结算保持 PAUSED 并记录外部动作完成边界', async () => {
    const seeded = await seedAction()
    const claim = await claimActionOutbox(NOW)
    if (claim === null) throw new Error('missing action claim')
    const policies = await listDelegationPolicies(seeded.repoId)
    const authorization = authorizeAction(actionRequestFor(seeded), policies)
    if (!authorization.ok) throw new Error(authorization.reason)
    const permit = await issuePermit(
      claim,
      authorization as Extract<ActionAuthorization, { ok: true }>,
      NOW,
    )
    const executing = await markActionExecuting(claim, permit, NOW)
    expect(executing.ok).toBe(true)
    const paused = await pauseManagedTicket(seeded.taskId, 'owner pause during execute', LATER)
    expect(paused.ok).toBe(true)
    if (!paused.ok) throw new Error(paused.error.detail)
    expect(paused.value.executingOutboxIds).toEqual([seeded.outboxId])

    const settled = await settleActionSuccess(
      claim,
      permit,
      { number: 7, url: 'https://example.test/pull/7', created: true },
      LATER,
    )
    expect(settled.ok).toBe(true)
    const task = await getManagedTicket(seeded.taskId)
    expect(task.ok).toBe(true)
    if (task.ok) {
      expect(task.value.status).toBe('PAUSED')
      expect(task.value.last_error).toBe('PAUSED: owner pause during execute')
      expect(task.value.handoff).toMatchObject({
        pull_request: { number: 7 },
        external_action_completed: true,
      })
    }
  })

  it('决定被人工覆盖后，已签发许可不能开始动作', async () => {
    const seeded = await seedAction({ bindDecision: true })
    const claim = await claimActionOutbox(NOW)
    if (claim === null) throw new Error('missing action claim')
    const policies = await listDelegationPolicies(seeded.repoId)
    const authorization = authorizeAction(actionRequestFor(seeded), policies)
    if (!authorization.ok) throw new Error(authorization.reason)
    const permit = await issuePermit(
      claim,
      authorization as Extract<ActionAuthorization, { ok: true }>,
      NOW,
    )
    expect(permit.decision).toMatchObject({
      request_id: seeded.decisionRequestId,
      request_revision: 1,
    })
    if (seeded.decisionRequestId === undefined) throw new Error('missing decision request')
    const overridden = await overrideManagedTicketDecision(
      seeded.decisionRequestId,
      1,
      'option-1',
      'owner override',
      LATER,
    )
    expect(overridden.ok).toBe(true)
    const mark = await markActionExecuting(claim, permit, LATER)
    expect(mark.ok).toBe(false)
    const outbox = await getActionOutbox(seeded.outboxId)
    expect(outbox?.status).toBe('BLOCKED')
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
