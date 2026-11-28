import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  ProjectCheck,
  ProjectVerificationBinding,
} from '../../contracts/project-verification.js'
import type { RequiredCheckGateway } from '../../contracts/required-checks.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { asRole } from '../../fact/db.js'
import { branchFor, type GitWorkspace, type PreparedProject } from '../../fact/git-workspace.js'
import { readTaskPullRequestRef } from '../../fact/task-pull-request.js'
import { ensureTraceId } from '../../fact/trace.js'
import { sha256CanonicalJson, sha256Text } from '../../shared/canonical-json.js'
import {
  applicableProjectChecks,
  coversLocalProjectChecks,
  parseProjectVerificationBinding,
  projectVerificationDigest,
} from '../../shared/project-verification.js'
import { evaluateRequiredChecks } from '../managed/check-gateway.js'
import { changedFiles } from '../managed/ticket-workspace.js'
import {
  bindProjectVerification,
  readRepoVerification,
  verifyProjectCommit,
} from '../project-verification.js'

interface Worktree {
  readonly repoId: string
  readonly git: GitWorkspace
  readonly project: PreparedProject
}

async function readBinding(taskId: string): Promise<Result<ProjectVerificationBinding | null>> {
  const row = await asRole('keel_control', (client) =>
    client.query<{ project_verification: unknown }>(
      'SELECT project_verification FROM task WHERE id=$1',
      [taskId],
    ),
  )
  return parseProjectVerificationBinding(row.rows[0]?.project_verification)
}

export async function legacyProjectBinding(input: {
  readonly taskId: string
  readonly worktree: Worktree
  readonly path: string
  readonly allowBind: boolean
  readonly now: string
}): Promise<Result<ProjectVerificationBinding | null>> {
  const current = await readBinding(input.taskId)
  if (!current.ok || current.value !== null) return current
  const registration = await readRepoVerification(input.worktree.repoId)
  if (!registration.ok) return registration
  if (!input.allowBind)
    return registration.value === null
      ? ok(null)
      : err(makeError('STALE_EVIDENCE', 'legacy task 尚未绑定项目验证契约，需从 develop 重新开始'))
  const binding = await bindProjectVerification(
    input.path,
    input.worktree.project.baseSha,
    registration.value,
  )
  if (!binding.ok) return binding
  const updated = await asRole('keel_control', async (client) => {
    const stored = await client.query(
      'UPDATE task SET project_verification=$2::jsonb WHERE id=$1 AND project_verification IS NULL',
      [input.taskId, JSON.stringify(binding.value)],
    )
    if (stored.rowCount !== 1) return false
    const traceId = await ensureTraceId(client, input.taskId, input.now)
    await client.query(
      `INSERT INTO event (task_id,type,payload,trace_id,occurred_at)
       VALUES ($1,'ProjectVerificationBound',$2::jsonb,$3,$4)`,
      [
        input.taskId,
        JSON.stringify({
          contract_digest: projectVerificationDigest(binding.value),
          baseline: binding.value.baseline,
          source: registration.value === null ? 'unconfigured' : 'repo.verification_contract',
        }),
        traceId,
        input.now,
      ],
    )
    return true
  })
  return updated ? binding : readBinding(input.taskId)
}

interface LegacyVerificationTarget {
  readonly taskId: string
  readonly worktree: Worktree
  readonly binding: ProjectVerificationBinding
}

export async function legacyVerificationTarget(input: LegacyVerificationTarget): Promise<
  Result<{
    readonly workspace: string
    readonly commit: string
    readonly checks: readonly ProjectCheck[]
  }>
> {
  const worktree = await input.worktree.git.ensureWorktree(input.worktree.project, input.taskId)
  if (!worktree.ok) return worktree
  const head = await input.worktree.git.headSha(input.worktree.project, input.taskId)
  if (!head.ok) return head
  const dirty = await input.worktree.git.isDirty(input.taskId)
  if (!dirty.ok) return dirty
  if (dirty.value) return err(makeError('STALE_EVIDENCE', '项目验证只接受干净工作树中的提交'))
  const files = await changedFiles(worktree.value.path, input.binding.baseline, head.value)
  if (!files.ok) return files
  const checks = applicableProjectChecks(input.binding, files.value)
  if (!checks.ok) return checks
  return ok({ workspace: worktree.value.path, commit: head.value, checks: checks.value })
}

export async function runLegacyProjectQa(
  input: LegacyVerificationTarget & {
    readonly runId: string
    readonly now: () => string
    readonly timeoutMs: number
  },
): Promise<Result<null>> {
  const target = await legacyVerificationTarget(input)
  if (!target.ok) return target
  const checked = await verifyProjectCommit({
    ...target.value,
    checks: target.value.checks.filter((check) => check.kind === 'local'),
    timeoutMs: input.timeoutMs,
  })
  if (!checked.ok) return checked
  if (!coversLocalProjectChecks(target.value.checks, checked.value))
    return err(makeError('STAGE_GATE_FAILED', '隔离执行器结果未覆盖全部 legacy QA 本地检查'))
  const after = await legacyVerificationTarget(input)
  if (!after.ok || after.value.commit !== target.value.commit)
    return err(makeError('STALE_EVIDENCE', 'legacy QA 期间工作树绑定已变化'))
  const failed = checked.value.filter((check) => check.exit_code !== 0).map((check) => check.id)
  return asRole('keel_control', async (client) => {
    const now = input.now()
    const fenced = await client.query(
      `UPDATE run SET status='SUCCEEDED',ended_at=$2,harness_id='keel-project-verification',
         harness_tier='L0',tokens_in=0,tokens_out=0,cost_usd=NULL,cost_basis='unavailable'
       WHERE id=$1 AND status='RUNNING'`,
      [input.runId, now],
    )
    if (fenced.rowCount !== 1) return err(makeError('RUN_CANCELLED', 'legacy QA 已被撤回'))
    const proof = {
      contract_digest: projectVerificationDigest(input.binding),
      head_sha: target.value.commit,
      required_check_ids: target.value.checks.map((check) => check.id),
      output_trust: 'untrusted',
      local: checked.value.map((check) => ({
        ...check,
        output_digest: sha256Text(check.output_excerpt),
      })),
    }
    const traceId = await ensureTraceId(client, input.taskId, now)
    const event = await client.query<{ seq: string }>(
      `INSERT INTO event (task_id,run_id,type,payload,trace_id,occurred_at)
       VALUES ($1,$2,'ProjectVerificationExecuted',$3::jsonb,$4,$5) RETURNING seq`,
      [
        input.taskId,
        input.runId,
        JSON.stringify({ ...proof, evidence_digest: sha256CanonicalJson(proof) }),
        traceId,
        now,
      ],
    )
    await commitArtifactOn(client, {
      id: randomUUID(),
      taskId: input.taskId,
      producedByRun: input.runId,
      kind: 'stage_outcome',
      key: 'qa',
      body: {
        schema_version: '1.0',
        run_id: input.runId,
        stage: 'qa',
        verdict: failed.length === 0 ? 'pass' : 'fail',
        reason: failed.length === 0 ? '隔离执行器已核验全部本地必要检查。' : '本地必要检查失败。',
        details: { failed_criteria: failed },
      },
      committedAtSeq: Number(event.rows[0]?.seq),
      supersedes: null,
    })
    return ok(null)
  })
}

export async function verifyLegacyQaCoverage(
  input: LegacyVerificationTarget,
): ReturnType<typeof legacyVerificationTarget> {
  const target = await legacyVerificationTarget(input)
  if (!target.ok) return target
  const persisted = await asRole('keel_control', (client) =>
    client.query(
      `SELECT 1 FROM event e JOIN run r ON r.id=e.run_id
         JOIN artifact a ON a.produced_by_run=r.id AND a.kind='stage_outcome' AND a.key='qa'
       WHERE r.id=(SELECT id FROM run WHERE task_id=$1 AND stage='qa' ORDER BY attempt DESC LIMIT 1)
         AND r.status='SUCCEEDED' AND a.body->>'verdict'='pass'
         AND e.type='ProjectVerificationExecuted' AND e.payload->>'head_sha'=$2
         AND e.payload->>'contract_digest'=$3 AND e.payload->'required_check_ids'=$4::jsonb`,
      [
        input.taskId,
        target.value.commit,
        projectVerificationDigest(input.binding),
        JSON.stringify(target.value.checks.map((check) => check.id)),
      ],
    ),
  )
  return persisted.rowCount === 1
    ? target
    : err(makeError('STALE_EVIDENCE', 'legacy QA 缺少当前提交与必要检查覆盖证据'))
}

export async function observeLegacyProjectChecks(input: {
  readonly taskId: string
  readonly worktree: Worktree
  readonly gateway: RequiredCheckGateway | undefined
  readonly remoteUrl: string | undefined
  readonly now: string
  readonly observedHead: string | null
}): Promise<Result<boolean>> {
  const loaded = await readBinding(input.taskId)
  if (!loaded.ok) return loaded
  const binding = loaded.value
  if (binding === null) {
    const registration = await readRepoVerification(input.worktree.repoId)
    if (!registration.ok) return registration
    return registration.value === null
      ? ok(true)
      : err(makeError('STALE_EVIDENCE', 'legacy PR 缺少绑定的项目验证契约'))
  }
  if (binding.contract === null) return ok(true)
  const target = await verifyLegacyQaCoverage({ ...input, binding })
  if (!target.ok) return target
  if (input.observedHead !== target.value.commit)
    return err(makeError('STALE_EVIDENCE', 'legacy PR head 与已验证提交不一致'))
  const required = target.value.checks.flatMap((check) =>
    check.kind === 'remote' ? [check.name] : [],
  )
  const pr = await readTaskPullRequestRef(input.taskId)
  if (required.length === 0) return ok(true)
  if (input.gateway === undefined || input.remoteUrl === undefined || pr === null)
    return err(
      makeError('CAPABILITY_UNSUPPORTED', 'legacy 远端必要检查需要已绑定 PR 与真实检查网关'),
    )
  const observed = await input.gateway.observeRequiredChecks({
    repoId: input.worktree.repoId,
    remoteUrl: input.remoteUrl,
    prNumber: pr.number,
    requiredChecks: required,
    observedAt: input.now,
  })
  if (!observed.ok) return observed
  const snapshot = observed.value
  if (
    snapshot.repoId !== input.worktree.repoId ||
    snapshot.remoteUrl !== input.remoteUrl ||
    snapshot.prNumber !== pr.number ||
    snapshot.headBranch !== branchFor(input.taskId) ||
    snapshot.baseBranch !== input.worktree.project.baseBranch ||
    snapshot.headSha !== target.value.commit
  )
    return err(makeError('STALE_EVIDENCE', 'legacy 远端检查与绑定的仓库、PR 或已验证提交不一致'))
  const verdict = evaluateRequiredChecks(
    required,
    snapshot.checks.map((check) => ({
      checkName: check.name,
      conclusion: check.conclusion,
    })),
  )
  await asRole('keel_control', async (client) => {
    const traceId = await ensureTraceId(client, input.taskId, input.now)
    await client.query(
      `INSERT INTO event (task_id,type,payload,trace_id,occurred_at)
       VALUES ($1,'ProjectRequiredChecksObserved',$2::jsonb,$3,$4)`,
      [
        input.taskId,
        JSON.stringify({
          contract_digest: projectVerificationDigest(binding),
          required,
          snapshot,
          verdict,
        }),
        traceId,
        input.now,
      ],
    )
  })
  if (verdict.status === 'FAILED')
    return err(makeError('STAGE_GATE_FAILED', verdict.detail ?? '远端必要检查失败'))
  return ok(verdict.status === 'READY')
}
