import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { PullRequestGateway } from '../../contracts/git-provider.js'
import type { GitPushGateway } from '../../contracts/git-push.js'
import type {
  ManagedActionGatewayResult,
  ManagedActionOutboxClaim,
  ManagedActionOutboxRecord,
} from '../../contracts/managed.js'
import { asRole } from '../../fact/db.js'
import type { ManagedExecutionPermit } from '../../generated/managed.js'
import { type ActionAuthorization, authorizeAction } from './action-authorization.js'
import {
  blockAction,
  claimActionOutbox,
  executionPermitAvailable,
  expireExecutingActions,
  getActionIntent,
  getActionOutbox,
  getManagedActionTask,
  getRepoBinding,
  issuePermit,
  listUncertainActions,
  markActionExecuting,
  markReconciledFailure,
  markReconciledRetry,
  markReconciledSuccess,
  settleActionFailure,
  settleActionSuccess,
} from './action-store.js'
import { listDelegationPoliciesInTx } from './decision-store.js'
import { diffDigest, inspectTicketWorktree } from './ticket-workspace.js'

export interface ManagedActionGatewayDeps {
  readonly push: GitPushGateway
  readonly pullRequests: PullRequestGateway
  readonly now?: () => string
  readonly checkTimeoutMs?: number
}

function clock(deps: ManagedActionGatewayDeps): string {
  return deps.now?.() ?? new Date().toISOString()
}

const DEFAULT_CHECK_TIMEOUT_MS = 30 * 60_000

function checkDeadline(now: string, deps: ManagedActionGatewayDeps): string {
  const timeout = deps.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw makeError('SCHEMA_VIOLATION', 'checkTimeoutMs 必须是正整数')
  return new Date(Date.parse(now) + timeout).toISOString()
}

function result(
  claim: ManagedActionOutboxClaim,
  status: ManagedActionOutboxRecord['status'],
  extra: Partial<ManagedActionGatewayResult> = {},
): ManagedActionGatewayResult {
  return {
    outboxId: claim.outbox.id,
    taskId: claim.intent.task_id,
    status,
    ...extra,
  }
}

async function revalidate(
  claim: ManagedActionOutboxClaim,
  now: string,
  permit?: ManagedExecutionPermit,
): Promise<
  Result<{ readonly baselineCommit: string; readonly head: string; readonly worktreePath: string }>
> {
  const task = await getManagedActionTask(claim.intent.task_id)
  if (task === null) return err(makeError('NOT_FOUND', '找不到 ticket task'))
  if (task.status !== 'WAITING_GATEWAY')
    return err(makeError('CONFLICT', `ticket task 当前是 ${task.status}，不等待 gateway`))
  const repo = await getRepoBinding(claim.intent.repo_id)
  if (repo === null) return err(makeError('NOT_FOUND', '找不到 repo 绑定'))
  if (repo.remote_url !== claim.intent.remote_url)
    return err(makeError('CONFLICT', 'repo remote 已变化，拒绝使用旧 action intent'))
  if (repo.default_branch !== claim.intent.base_branch)
    return err(makeError('CONFLICT', 'repo base branch 已变化，拒绝使用旧 action intent'))
  const worktree = await inspectTicketWorktree(task.worktree_path)
  if (!worktree.ok) return worktree
  if (!worktree.value.clean)
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 不干净，拒绝 gateway 动作'))
  if (worktree.value.head !== claim.intent.head_sha)
    return err(
      makeError(
        'CONFLICT',
        `worktree HEAD ${worktree.value.head} 与 intent ${claim.intent.head_sha} 不一致`,
      ),
    )
  if (worktree.value.branch !== claim.intent.head_branch)
    return err(
      makeError(
        'CONFLICT',
        `worktree 分支 ${worktree.value.branch} 与 intent ${claim.intent.head_branch} 不一致`,
      ),
    )
  const diff = await diffDigest(task.worktree_path, task.baseline_commit, worktree.value.head)
  if (!diff.ok) return diff
  if (diff.value !== claim.intent.diff_digest)
    return err(makeError('CONFLICT', 'baseline..HEAD diff 摘要与 intent 不一致'))
  if (permit !== undefined && !(await executionPermitAvailable(permit.id, now)))
    return err(makeError('CONFLICT', 'ExecutionPermit 的授权、决定或任务控制代次已失效'))
  return ok({
    baselineCommit: task.baseline_commit,
    head: worktree.value.head,
    worktreePath: task.worktree_path,
  })
}

async function authorize(
  claim: ManagedActionOutboxClaim,
  now: string,
): Promise<Result<Extract<ActionAuthorization, { ok: true }>>> {
  return asRole('keel_control', async (c) => {
    const policies = await listDelegationPoliciesInTx(c, claim.intent.project_id)
    const decision = authorizeAction(
      {
        project_id: claim.intent.project_id,
        action: claim.intent.action,
        environment: claim.intent.environment,
        reversibility: claim.intent.reversibility,
        affected_resources: claim.intent.affected_resources,
        attempts: claim.outbox.attempts,
        now,
      },
      policies,
    )
    if (!decision.ok) return err(makeError('PERMISSION_DENIED', decision.reason))
    return ok(decision)
  })
}

function definiteFailure(kind: string): boolean {
  return ['AUTH_FAILED', 'PERMISSION_DENIED', 'CONFLICT', 'SCHEMA_VIOLATION', 'NOT_FOUND'].includes(
    kind,
  )
}

async function executeClaim(
  claim: ManagedActionOutboxClaim,
  deps: ManagedActionGatewayDeps,
  now: string,
): Promise<Result<ManagedActionGatewayResult>> {
  const valid = await revalidate(claim, now)
  if (!valid.ok) {
    const blocked = await blockAction(claim, valid.error.detail, now)
    if (!blocked.ok) return blocked
    return ok(result(claim, blocked.value.status, { error: valid.error.detail }))
  }

  const authorization = await authorize(claim, now)
  if (!authorization.ok) {
    const blocked = await blockAction(claim, authorization.error.detail, now)
    if (!blocked.ok) return blocked
    return ok(result(claim, blocked.value.status, { error: authorization.error.detail }))
  }

  let permit: ManagedExecutionPermit
  try {
    permit = await issuePermit(claim, authorization.value, now)
  } catch (error) {
    return err(
      makeError('CONFLICT', error instanceof Error ? error.message : '无法签发 ExecutionPermit'),
    )
  }
  const executing = await markActionExecuting(claim, permit, now)
  if (!executing.ok) {
    const blocked = await blockAction(claim, executing.error.detail, now)
    if (!blocked.ok) return blocked
    return ok(result(claim, blocked.value.status, { error: executing.error.detail }))
  }

  const afterPermit = await revalidate(claim, now, permit)
  if (!afterPermit.ok) {
    const settled = await settleActionFailure(
      claim,
      permit,
      'FAILED',
      `permit 后事实变化：${afterPermit.error.detail}`,
      now,
    )
    if (!settled.ok) return settled
    return ok(result(claim, settled.value.status, { error: afterPermit.error.detail }))
  }

  const push = await deps.push.push({
    worktreePath: afterPermit.value.worktreePath,
    remoteUrl: claim.intent.remote_url,
    headBranch: claim.intent.head_branch,
    headSha: claim.intent.head_sha,
  })
  if (!push.ok) {
    const status = definiteFailure(push.error.kind) ? 'FAILED' : 'UNCERTAIN'
    const settled = await settleActionFailure(claim, permit, status, push.error.detail, now)
    if (!settled.ok) return settled
    return ok(result(claim, settled.value.status, { error: push.error.detail }))
  }
  if (push.value.headSha !== claim.intent.head_sha) {
    const detail = `push 返回 ${push.value.headSha}，与 intent ${claim.intent.head_sha} 不一致`
    const settled = await settleActionFailure(claim, permit, 'FAILED', detail, now)
    if (!settled.ok) return settled
    return ok(result(claim, settled.value.status, { error: detail }))
  }

  const beforePr = await revalidate(claim, now, permit)
  if (!beforePr.ok) {
    const detail = `push 后控制或授权变化：${beforePr.error.detail}`
    const settled = await settleActionFailure(claim, permit, 'UNCERTAIN', detail, now)
    if (!settled.ok) return settled
    return ok(result(claim, settled.value.status, { error: detail }))
  }

  const pr = await deps.pullRequests.createPullRequest({
    repoId: claim.intent.repo_id,
    remoteUrl: claim.intent.remote_url,
    baseBranch: claim.intent.base_branch,
    headBranch: claim.intent.head_branch,
    title: claim.intent.pr_title,
    body: claim.intent.pr_body,
  })
  if (!pr.ok) {
    const status = definiteFailure(pr.error.kind) ? 'FAILED' : 'UNCERTAIN'
    const settled = await settleActionFailure(claim, permit, status, pr.error.detail, now)
    if (!settled.ok) return settled
    return ok(result(claim, settled.value.status, { error: pr.error.detail }))
  }

  const settled = await settleActionSuccess(claim, permit, pr.value, now, checkDeadline(now, deps))
  if (!settled.ok) return settled
  return ok(
    result(claim, settled.value.status, {
      prNumber: pr.value.number,
      prUrl: pr.value.url,
    }),
  )
}

export async function runActionGatewayOnce(
  deps: ManagedActionGatewayDeps,
): Promise<Result<ManagedActionGatewayResult | null>> {
  const now = clock(deps)
  await expireExecutingActions(now)
  const claim = await claimActionOutbox(now)
  if (claim === null) return ok(null)
  return executeClaim(claim, deps, now)
}

async function reconcileClaim(
  claim: ManagedActionOutboxClaim,
  deps: ManagedActionGatewayDeps,
  now: string,
): Promise<Result<ManagedActionGatewayResult>> {
  const task = await getManagedActionTask(claim.intent.task_id)
  if (task === null) return err(makeError('NOT_FOUND', '找不到 ticket task'))
  const inspect = await deps.push.inspect({
    worktreePath: task.worktree_path,
    remoteUrl: claim.intent.remote_url,
    headBranch: claim.intent.head_branch,
  })
  if (!inspect.ok) {
    return ok(result(claim, 'UNCERTAIN', { error: inspect.error.detail }))
  }
  if (inspect.value.state === 'absent') {
    const retried = await markReconciledRetry(
      claim,
      '远端分支不存在；已确认没有外部副作用，安全重排',
      now,
    )
    if (!retried.ok) return retried
    return ok(result(claim, retried.value.status))
  }
  if (inspect.value.headSha !== claim.intent.head_sha) {
    const failed = await markReconciledFailure(
      claim,
      `远端分支指向 ${inspect.value.headSha ?? '未知 SHA'}，不是 intent SHA`,
      now,
    )
    if (!failed.ok) return failed
    return ok(
      result(
        claim,
        failed.value.status,
        failed.value.last_error === null ? {} : { error: failed.value.last_error },
      ),
    )
  }
  const pr = await deps.pullRequests.createPullRequest({
    repoId: claim.intent.repo_id,
    remoteUrl: claim.intent.remote_url,
    baseBranch: claim.intent.base_branch,
    headBranch: claim.intent.head_branch,
    title: claim.intent.pr_title,
    body: claim.intent.pr_body,
  })
  if (!pr.ok) return ok(result(claim, 'UNCERTAIN', { error: pr.error.detail }))
  const settled = await markReconciledSuccess(claim, pr.value, now, checkDeadline(now, deps))
  if (!settled.ok) return settled
  return ok(
    result(claim, settled.value.status, {
      prNumber: pr.value.number,
      prUrl: pr.value.url,
    }),
  )
}

export async function reconcileUncertainActions(
  deps: ManagedActionGatewayDeps,
): Promise<Result<readonly ManagedActionGatewayResult[]>> {
  const now = clock(deps)
  const uncertain = await listUncertainActions()
  const results: ManagedActionGatewayResult[] = []
  for (const claim of uncertain) {
    const reconciled = await reconcileClaim(claim, deps, now)
    if (!reconciled.ok) return reconciled
    results.push(reconciled.value)
  }
  return ok(results)
}

export async function reconcileAction(
  outboxId: string,
  deps: ManagedActionGatewayDeps,
): Promise<Result<ManagedActionGatewayResult>> {
  const outbox = await getActionOutbox(outboxId)
  if (outbox === null) return err(makeError('NOT_FOUND', '找不到 action outbox'))
  if (outbox.status !== 'UNCERTAIN')
    return err(makeError('CONFLICT', `action outbox 当前是 ${outbox.status}，无需回查`))
  const intent = await getActionIntent(outbox.action_intent_id)
  if (intent === null) return err(makeError('NOT_FOUND', '找不到 action intent'))
  return reconcileClaim({ outbox, intent }, deps, clock(deps))
}
