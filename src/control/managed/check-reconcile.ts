import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  PullRequestState,
  PullRequestStateGateway,
} from '../../contracts/pull-request-state.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { getManagedActionTask, getRepoBinding } from './action-store.js'
import {
  listCheckEvidence,
  type ManagedCheckEvidenceView,
  type ManagedCheckTargetRecord,
} from './check-store.js'

export type BoundPullRequest = PullRequestState & {
  readonly disposition: 'OPEN' | 'MERGED' | 'CLOSED_UNMERGED'
}

export async function observeBoundPullRequest(
  target: ManagedCheckTargetRecord,
  gateway: PullRequestStateGateway,
): Promise<Result<BoundPullRequest>> {
  const repo = await getRepoBinding(target.repo_id)
  if (repo?.remote_url !== target.remote_url || repo.default_branch !== target.base_branch)
    return err(makeError('STALE_EVIDENCE', 'repo remote 或默认分支已偏离绑定 PR'))
  const observed = await gateway.getPullRequest({
    repoId: target.repo_id,
    remoteUrl: target.remote_url,
    number: target.pr_number,
  })
  if (!observed.ok) return observed
  const pr = observed.value
  if (
    pr.number !== target.pr_number ||
    pr.url !== target.pr_url ||
    pr.headBranch !== target.head_branch ||
    pr.baseBranch !== target.base_branch ||
    pr.headSha !== target.head_sha
  )
    return err(
      makeError(
        'STALE_EVIDENCE',
        `绑定 PR #${target.pr_number} 的编号、URL、分支或 head 已变化或无法核实`,
      ),
    )
  if (pr.merged && pr.state !== 'closed')
    return err(makeError('PROTOCOL_ERROR', '已合并 PR 的状态必须为 closed'))
  return ok({
    ...pr,
    disposition: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED_UNMERGED' : 'OPEN',
  })
}

export async function reconcileManagedPullRequest(
  targetId: string,
  gateway: PullRequestStateGateway,
): Promise<
  Result<{
    target: ManagedCheckTargetRecord
    pullRequest: BoundPullRequest
    missingCheckEvidence: boolean
    reason: 'PR_MERGED_EVIDENCE_MISSING' | 'PR_CLOSED_UNMERGED' | null
  }>
> {
  const [evidence] = await listCheckEvidence({ targetId })
  if (evidence === undefined) return err(makeError('NOT_FOUND', '找不到已绑定的 check target'))
  const remote = await observeBoundPullRequest(evidence.target, gateway)
  if (!remote.ok) return remote
  const task = await getManagedActionTask(evidence.target.task_id)
  const gate =
    typeof task?.handoff === 'object' && task.handoff !== null && 'check_gate' in task.handoff
      ? task.handoff.check_gate
      : null
  const missingCheckEvidence = !checkGateMatchesEvidence(
    evidence,
    gate,
    evidence.target.head_sha,
    evidence.target.diff_digest,
  )
  return ok({
    target: evidence.target,
    pullRequest: remote.value,
    missingCheckEvidence,
    reason:
      remote.value.disposition === 'CLOSED_UNMERGED'
        ? 'PR_CLOSED_UNMERGED'
        : remote.value.disposition === 'MERGED' && missingCheckEvidence
          ? 'PR_MERGED_EVIDENCE_MISSING'
          : null,
  })
}

export function checkGateMatchesEvidence(
  view: ManagedCheckEvidenceView,
  gate: unknown,
  head: string,
  diff: string,
): boolean {
  if (typeof gate !== 'object' || gate === null || Array.isArray(gate)) return false
  const record = gate as Record<string, unknown>
  const { target } = view
  if (
    target.status !== 'READY' ||
    target.head_sha !== head ||
    target.diff_digest !== diff ||
    target.evidence_digest === null ||
    record.status !== 'READY' ||
    record.evidence_digest !== target.evidence_digest ||
    record.target_id !== target.id ||
    record.action_intent_id !== target.action_intent_id ||
    record.permit_id !== target.permit_id ||
    record.pr_state !== 'open' ||
    typeof record.repo !== 'string' ||
    typeof record.observed_at !== 'string' ||
    !Array.isArray(record.checks) ||
    !Array.isArray(record.required_checks) ||
    sha256CanonicalJson(record.required_checks) !== sha256CanonicalJson(target.required_checks) ||
    record.remote_url !== target.remote_url ||
    record.pr_number !== target.pr_number ||
    record.pr_url !== target.pr_url ||
    record.head_branch !== target.head_branch ||
    record.base_branch !== target.base_branch ||
    record.head_sha !== target.head_sha
  )
    return false

  const observations = view.observations.filter((item) => item.attempt === target.attempts)
  if (
    target.required_checks.some((name) => !observations.some((item) => item.check_name === name)) ||
    observations.some(
      (item) =>
        item.repo !== record.repo ||
        item.repo_url !== target.remote_url ||
        item.pr_number !== target.pr_number ||
        item.pr_url !== target.pr_url ||
        item.pr_state !== 'open' ||
        item.head_branch !== target.head_branch ||
        item.base_branch !== target.base_branch ||
        item.head_sha !== head ||
        item.observed_at !== record.observed_at ||
        !target.required_checks.includes(item.check_name) ||
        item.source === 'none' ||
        item.conclusion !== 'success',
    )
  )
    return false

  const base = {
    target_id: target.id,
    action_intent_id: target.action_intent_id,
    permit_id: target.permit_id,
    project_id: target.project_id,
    repo_id: target.repo_id,
    repo: record.repo,
    remote_url: target.remote_url,
    pr_number: target.pr_number,
    pr_url: target.pr_url,
    pr_state: 'open',
    head_branch: target.head_branch,
    base_branch: target.base_branch,
    head_sha: head,
    required_checks: [...target.required_checks].sort(),
    observed_at: record.observed_at,
  }
  const ordered = (checks: readonly { name: string; source: string }[]) =>
    [...checks].sort((left, right) =>
      `${left.name}:${left.source}`.localeCompare(`${right.name}:${right.source}`),
    )
  const gateChecks = record.checks
  if (
    !gateChecks.every(
      (check) =>
        typeof check === 'object' &&
        check !== null &&
        typeof check.name === 'string' &&
        typeof check.source === 'string',
    )
  )
    return false
  return [true, false].some((includeExternalId) => {
    const checks = ordered(
      observations.map((item) => ({
        name: item.check_name,
        source: item.source,
        conclusion: item.conclusion,
        observed_at: item.observed_at,
        ...(includeExternalId ? { external_id: item.external_id } : {}),
      })),
    )
    return (
      sha256CanonicalJson(checks) === sha256CanonicalJson(ordered(gateChecks)) &&
      sha256CanonicalJson({ ...base, checks }) === target.evidence_digest
    )
  })
}
