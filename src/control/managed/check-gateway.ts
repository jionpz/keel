import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { ManagedCheckGatewayResult } from '../../contracts/managed.js'
import type {
  RequiredCheckGateway,
  RequiredCheckSnapshot,
} from '../../contracts/required-checks.js'
import { asRole } from '../../fact/db.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { getManagedActionTask, getRepoBinding } from './action-store.js'
import {
  claimCheckTarget,
  deferCheck,
  finalizeCheckFailed,
  finalizeCheckReady,
  type ManagedCheckClaim,
  type ManagedCheckObservationDraft,
  type ManagedCheckTargetRecord,
} from './check-store.js'
import { diffDigest, inspectTicketWorktree } from './ticket-workspace.js'

export interface ManagedCheckGatewayDeps {
  readonly checks: RequiredCheckGateway
  readonly now?: () => string
  readonly pollIntervalMs?: number
}

export interface RequiredCheckEvaluation {
  readonly status: 'READY' | 'PENDING' | 'FAILED'
  readonly detail: string | null
}

function clock(deps: ManagedCheckGatewayDeps): string {
  return deps.now?.() ?? new Date().toISOString()
}

function pollInterval(deps: ManagedCheckGatewayDeps): number {
  const value = deps.pollIntervalMs ?? 10_000
  if (!Number.isSafeInteger(value) || value <= 0)
    throw makeError('SCHEMA_VIOLATION', 'pollIntervalMs 必须是正整数')
  return value
}

export function evaluateRequiredChecks(
  requiredChecks: readonly string[],
  observations: readonly Pick<ManagedCheckObservationDraft, 'checkName' | 'conclusion'>[],
): RequiredCheckEvaluation {
  if (requiredChecks.length === 0) return { status: 'READY', detail: null }
  const failures: string[] = []
  const pending: string[] = []
  const missing: string[] = []
  for (const name of requiredChecks) {
    const matching = observations.filter((observation) => observation.checkName === name)
    if (matching.length === 0) {
      missing.push(name)
      continue
    }
    const nonSuccess = matching.filter((observation) => observation.conclusion !== 'success')
    if (
      nonSuccess.some(
        (observation) =>
          observation.conclusion !== 'pending' && observation.conclusion !== 'missing',
      )
    ) {
      failures.push(`${name}=${nonSuccess.map((observation) => observation.conclusion).join(',')}`)
    } else if (
      nonSuccess.some(
        (observation) =>
          observation.conclusion === 'pending' || observation.conclusion === 'missing',
      )
    ) {
      pending.push(name)
    }
  }
  if (failures.length > 0)
    return { status: 'FAILED', detail: `required check 未成功：${failures.join('; ')}` }
  if (missing.length > 0)
    return { status: 'PENDING', detail: `required check 尚未上报：${missing.join(',')}` }
  if (pending.length > 0)
    return { status: 'PENDING', detail: `required check 仍在运行：${pending.join(',')}` }
  return { status: 'READY', detail: null }
}

async function authorizationAvailable(
  target: ManagedCheckTargetRecord,
  now: string,
): Promise<boolean> {
  return asRole('keel_control', async (c) => {
    const row = await c.query<{ available: boolean }>(
      `SELECT managed_action_policy_available($1,$2,$3,$4::timestamptz) AS available`,
      [target.authorization_id, target.project_id, target.authorization_version, now],
    )
    return row.rows[0]?.available === true
  })
}

async function revalidateBinding(
  target: ManagedCheckTargetRecord,
  now: string,
): Promise<Result<null>> {
  const task = await getManagedActionTask(target.task_id)
  if (task === null) return err(makeError('NOT_FOUND', '找不到 ticket task'))
  if (task.status !== 'CHECKING' && task.status !== 'PR_OPENED')
    return err(makeError('CONFLICT', `ticket task 当前是 ${task.status}，不在 check 阶段`))
  const repo = await getRepoBinding(target.repo_id)
  if (repo === null) return err(makeError('NOT_FOUND', '找不到 repo 绑定'))
  if (repo.remote_url !== target.remote_url)
    return err(makeError('CONFLICT', 'repo remote 已变化，check 证据失效'))
  if (repo.default_branch !== target.base_branch)
    return err(makeError('CONFLICT', 'repo base branch 已变化，check 证据失效'))
  if (!(await authorizationAvailable(target, now)))
    return err(makeError('PERMISSION_DENIED', '授权策略已撤销、替代或过期'))
  const worktree = await inspectTicketWorktree(task.worktree_path)
  if (!worktree.ok) return worktree
  if (!worktree.value.clean)
    return err(makeError('WORKSPACE_ERROR', 'ticket worktree 不干净，不能确认 check 对应提交'))
  if (worktree.value.head !== target.head_sha)
    return err(
      makeError(
        'CONFLICT',
        `worktree HEAD ${worktree.value.head} 与目标 ${target.head_sha} 不一致`,
      ),
    )
  if (worktree.value.branch !== target.head_branch)
    return err(
      makeError(
        'CONFLICT',
        `worktree 分支 ${worktree.value.branch} 与目标 ${target.head_branch} 不一致`,
      ),
    )
  const diff = await diffDigest(task.worktree_path, task.baseline_commit, worktree.value.head)
  if (!diff.ok) return diff
  if (diff.value !== target.diff_digest)
    return err(makeError('CONFLICT', 'baseline..HEAD diff 摘要已变化'))
  return ok(null)
}

function result(
  claim: ManagedCheckClaim,
  status: ManagedCheckGatewayResult['status'],
  extra: Partial<ManagedCheckGatewayResult> = {},
): ManagedCheckGatewayResult {
  return {
    targetId: claim.target.id,
    taskId: claim.target.task_id,
    status,
    prNumber: claim.target.pr_number,
    headSha: claim.target.head_sha,
    ...extra,
  }
}

function observationDrafts(
  snapshot: RequiredCheckSnapshot,
  requiredChecks: readonly string[],
): ManagedCheckObservationDraft[] {
  const drafts: ManagedCheckObservationDraft[] = []
  for (const name of requiredChecks) {
    const facts = snapshot.checks.filter((fact) => fact.name === name)
    if (facts.length === 0) {
      drafts.push({
        repo: snapshot.repo,
        repoUrl: snapshot.remoteUrl,
        prNumber: snapshot.prNumber,
        prUrl: snapshot.prUrl,
        prState: snapshot.prState,
        headBranch: snapshot.headBranch,
        baseBranch: snapshot.baseBranch,
        headSha: snapshot.headSha,
        checkName: name,
        source: 'none',
        conclusion: 'missing',
        externalId: null,
        detailsUrl: null,
        observedAt: snapshot.observedAt,
      })
      continue
    }
    for (const fact of facts) {
      drafts.push({
        repo: snapshot.repo,
        repoUrl: snapshot.remoteUrl,
        prNumber: snapshot.prNumber,
        prUrl: snapshot.prUrl,
        prState: snapshot.prState,
        headBranch: snapshot.headBranch,
        baseBranch: snapshot.baseBranch,
        headSha: snapshot.headSha,
        checkName: fact.name,
        source: fact.source,
        conclusion: fact.conclusion,
        externalId: fact.externalId,
        detailsUrl: fact.detailsUrl,
        observedAt: snapshot.observedAt,
      })
    }
  }
  return drafts
}

function snapshotMismatch(
  target: ManagedCheckTargetRecord,
  snapshot: RequiredCheckSnapshot,
): string | null {
  if (snapshot.prNumber !== target.pr_number)
    return `PR 编号 ${snapshot.prNumber} 与目标 ${target.pr_number} 不一致`
  if (snapshot.prState !== 'open') return `PR 当前是 ${snapshot.prState}，不是 open`
  if (snapshot.headSha !== target.head_sha)
    return `PR head ${snapshot.headSha} 与目标 SHA ${target.head_sha} 不一致`
  if (snapshot.headBranch !== target.head_branch)
    return `PR head branch ${snapshot.headBranch} 与 ${target.head_branch} 不一致`
  if (snapshot.baseBranch !== target.base_branch)
    return `PR base branch ${snapshot.baseBranch} 与 ${target.base_branch} 不一致`
  if (snapshot.remoteUrl !== target.remote_url)
    return 'PR 证据的 repo remote 与 action intent 不一致'
  return null
}

function checkHandoff(
  claim: ManagedCheckClaim,
  snapshot: RequiredCheckSnapshot,
  drafts: readonly ManagedCheckObservationDraft[],
  outcome: 'READY' | 'FAILED' | 'PENDING',
  evidenceDigest: string,
  error: string | null,
): unknown {
  return {
    completion_target: 'pr_ready',
    check_gate: {
      target_id: claim.target.id,
      action_intent_id: claim.target.action_intent_id,
      permit_id: claim.target.permit_id,
      status: outcome,
      repo: snapshot.repo,
      remote_url: snapshot.remoteUrl,
      pr_number: snapshot.prNumber,
      pr_url: snapshot.prUrl,
      pr_state: snapshot.prState,
      head_branch: snapshot.headBranch,
      base_branch: snapshot.baseBranch,
      head_sha: snapshot.headSha,
      required_checks: [...claim.target.required_checks],
      observed_at: snapshot.observedAt,
      evidence_digest: evidenceDigest,
      checks: drafts.map((draft) => ({
        name: draft.checkName,
        source: draft.source,
        conclusion: draft.conclusion,
        observed_at: draft.observedAt,
      })),
      error,
    },
  }
}

function evidenceDigest(
  target: ManagedCheckTargetRecord,
  snapshot: RequiredCheckSnapshot,
  drafts: readonly ManagedCheckObservationDraft[],
): string {
  return sha256CanonicalJson({
    target_id: target.id,
    action_intent_id: target.action_intent_id,
    permit_id: target.permit_id,
    project_id: target.project_id,
    repo_id: target.repo_id,
    repo: snapshot.repo,
    remote_url: snapshot.remoteUrl,
    pr_number: snapshot.prNumber,
    pr_url: snapshot.prUrl,
    pr_state: snapshot.prState,
    head_branch: snapshot.headBranch,
    base_branch: snapshot.baseBranch,
    head_sha: snapshot.headSha,
    required_checks: [...target.required_checks].sort(),
    observed_at: snapshot.observedAt,
    checks: drafts
      .map((draft) => ({
        name: draft.checkName,
        source: draft.source,
        conclusion: draft.conclusion,
        observed_at: draft.observedAt,
      }))
      .sort((left, right) =>
        `${left.name}:${left.source}`.localeCompare(`${right.name}:${right.source}`),
      ),
  })
}

async function failClaim(
  claim: ManagedCheckClaim,
  error: string,
  observations: readonly ManagedCheckObservationDraft[],
  now: string,
): Promise<Result<ManagedCheckGatewayResult>> {
  const handoff = {
    completion_target: 'pr_ready',
    check_gate: {
      target_id: claim.target.id,
      action_intent_id: claim.target.action_intent_id,
      permit_id: claim.target.permit_id,
      status: 'FAILED',
      repo: claim.target.remote_url,
      remote_url: claim.target.remote_url,
      pr_number: claim.target.pr_number,
      pr_url: claim.target.pr_url,
      head_sha: claim.target.head_sha,
      required_checks: [...claim.target.required_checks],
      observed_at: observations[0]?.observedAt ?? null,
      checks: observations.map((observation) => ({
        name: observation.checkName,
        source: observation.source,
        conclusion: observation.conclusion,
        observed_at: observation.observedAt,
      })),
      error,
    },
  }
  const failed = await finalizeCheckFailed(claim, observations, error, handoff, now)
  if (!failed.ok) return failed
  return ok(result(claim, 'FAILED', { error }))
}

export async function runCheckGatewayOnce(
  deps: ManagedCheckGatewayDeps,
): Promise<Result<ManagedCheckGatewayResult | null>> {
  const now = clock(deps)
  const claim = await claimCheckTarget(now)
  if (claim === null) return ok(null)

  if (Date.parse(now) >= Date.parse(claim.target.deadline_at))
    return failClaim(
      claim,
      'CHECK_TIMEOUT: 在截止时间前未取得全部 required check 成功证据',
      [],
      now,
    )

  const before = await revalidateBinding(claim.target, now)
  if (!before.ok) return failClaim(claim, before.error.detail, [], now)

  const snapshot = await deps.checks.observeRequiredChecks({
    repoId: claim.target.repo_id,
    remoteUrl: claim.target.remote_url,
    prNumber: claim.target.pr_number,
    requiredChecks: claim.target.required_checks,
    observedAt: now,
  })
  if (!snapshot.ok) {
    if (snapshot.error.retryable && Date.parse(now) < Date.parse(claim.target.deadline_at)) {
      const next = new Date(Date.parse(now) + pollInterval(deps)).toISOString()
      const deferred = await deferCheck(claim, [], next, snapshot.error.detail, now)
      if (!deferred.ok) return deferred
      return ok(result(claim, 'CHECKING', { error: snapshot.error.detail }))
    }
    return failClaim(claim, snapshot.error.detail, [], now)
  }

  const drafts = observationDrafts(snapshot.value, claim.target.required_checks)
  const mismatch = snapshotMismatch(claim.target, snapshot.value)
  if (mismatch !== null) {
    const handoff = checkHandoff(
      claim,
      snapshot.value,
      drafts,
      'FAILED',
      evidenceDigest(claim.target, snapshot.value, drafts),
      mismatch,
    )
    const failed = await finalizeCheckFailed(claim, drafts, mismatch, handoff, now)
    if (!failed.ok) return failed
    return ok(result(claim, 'FAILED', { error: mismatch }))
  }

  const afterBinding = await revalidateBinding(claim.target, now)
  if (!afterBinding.ok) return failClaim(claim, afterBinding.error.detail, drafts, now)

  const evaluation = evaluateRequiredChecks(claim.target.required_checks, drafts)
  const digest = evidenceDigest(claim.target, snapshot.value, drafts)
  if (evaluation.status === 'FAILED') {
    const detail = evaluation.detail ?? 'required check 失败'
    const handoff = checkHandoff(claim, snapshot.value, drafts, 'FAILED', digest, detail)
    const failed = await finalizeCheckFailed(claim, drafts, detail, handoff, now)
    if (!failed.ok) return failed
    return ok(result(claim, 'FAILED', { error: detail }))
  }
  if (evaluation.status === 'PENDING') {
    if (Date.parse(now) >= Date.parse(claim.target.deadline_at))
      return failClaim(
        claim,
        `CHECK_TIMEOUT: ${evaluation.detail ?? 'required check 未完成'}`,
        drafts,
        now,
      )
    const next = new Date(Date.parse(now) + pollInterval(deps)).toISOString()
    const deferred = await deferCheck(claim, drafts, next, evaluation.detail, now)
    if (!deferred.ok) return deferred
    return ok(
      result(claim, 'CHECKING', evaluation.detail === null ? {} : { error: evaluation.detail }),
    )
  }

  const handoff = checkHandoff(claim, snapshot.value, drafts, 'READY', digest, null)
  const ready = await finalizeCheckReady(claim, drafts, digest, handoff, now)
  if (!ready.ok) return ready
  return ok(result(claim, 'READY', { evidenceDigest: digest }))
}
