import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  ProjectVerificationBinding,
  ProjectVerificationRunner,
} from '../contracts/project-verification.js'
import type { ContextSection } from '../contracts/types.js'
import { isForbiddenExecutorEnvKey } from '../execution/isolation/executor-env.js'
import { runProjectChecks } from '../execution/project-verification.js'
import { asRole } from '../fact/db.js'
import { gitAuthSecrets, redactSecrets } from '../fact/github-auth.js'
import type { RepoVerificationContract } from '../generated/managed.js'
import { sha256Text } from '../shared/canonical-json.js'
import { applicableProjectRules, parseRepoVerification } from '../shared/project-verification.js'
import { committedAgentRules, createTicketRepository } from './managed/ticket-workspace.js'

export async function readRepoVerification(
  repoId: string,
): Promise<Result<RepoVerificationContract | null>> {
  const row = (
    await asRole('keel_control', (client) =>
      client.query<{ verification_contract: unknown }>(
        'SELECT verification_contract FROM repo WHERE id=$1',
        [repoId],
      ),
    )
  ).rows[0]
  if (row === undefined) return err(makeError('NOT_FOUND', '找不到 repo'))
  return row.verification_contract === null
    ? ok(null)
    : parseRepoVerification(row.verification_contract)
}

export async function bindProjectVerification(
  workspace: string,
  baseline: string,
  contract: RepoVerificationContract | null,
): Promise<Result<ProjectVerificationBinding>> {
  const rules = await committedAgentRules(workspace, baseline)
  if (!rules.ok) return rules
  return ok({
    baseline,
    contract,
    rules: rules.value.map((rule) => ({ ...rule, digest: sha256Text(rule.content) })),
  })
}

export function projectRuleSections(
  binding: ProjectVerificationBinding,
  scope: readonly string[],
): readonly ContextSection[] {
  return applicableProjectRules(binding.rules, scope).map((rule, index) => ({
    id: `project_rule_${index}`,
    content: JSON.stringify({
      path: rule.path,
      digest: rule.digest,
      content: rule.content,
    }),
    source_ref: `git:${binding.baseline}:${rule.path}`,
    source_kind: 'artifact',
    priority: 'required',
    tokens: Math.ceil(rule.content.length / 4),
  }))
}

export async function verifyProjectCommit(
  input: Parameters<ProjectVerificationRunner>[0] & { readonly commit: string },
  runner: ProjectVerificationRunner = runProjectChecks,
): ReturnType<ProjectVerificationRunner> {
  if (input.checks.length === 0) return ok([])
  const root = await mkdtemp('/tmp/keel-project-check-source-')
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || value.trim() === '') continue
    if (isForbiddenExecutorEnvKey(key) || key === 'KEEL_DATABASE_URL' || key === 'DATABASE_URL')
      secrets.add(value.trim())
    if (['KEEL_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN'].includes(key)) {
      for (const secret of gitAuthSecrets(value.trim())) secrets.add(secret)
    }
  }
  const redactions = [...secrets].sort((left, right) => right.length - left.length)
  try {
    const workspace = join(root, 'source')
    await createTicketRepository(
      input.workspace,
      workspace,
      'ai/project-verification',
      input.commit,
    )
    const checked = await runner({ ...input, workspace })
    if (!checked.ok)
      return err(makeError(checked.error.kind, redactSecrets(checked.error.detail, redactions)))
    return ok(
      checked.value.map((check) => ({
        id: check.id,
        argv: check.argv,
        exit_code: check.exit_code,
        output_excerpt: redactSecrets(check.output_excerpt, redactions),
      })),
    )
  } catch (error) {
    return err(
      makeError(
        'WORKSPACE_ERROR',
        redactSecrets(
          `无法验证提交 ${input.commit}：${error instanceof Error ? error.message : String(error)}`,
          redactions,
        ),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
