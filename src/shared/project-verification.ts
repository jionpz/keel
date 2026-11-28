import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  ProjectCheck,
  ProjectCheckResult,
  ProjectRule,
  ProjectVerificationBinding,
} from '../contracts/project-verification.js'
import { MANAGED_SCHEMAS, type RepoVerificationContract } from '../generated/managed.js'
import { canonicalJson, sha256CanonicalJson, sha256Text } from './canonical-json.js'

const ajv = new Ajv2020({ allErrors: true })
const validateContract = ajv.compile<RepoVerificationContract>(
  MANAGED_SCHEMAS.repo_verification_contract,
)

function validPath(path: string): boolean {
  return (
    path === '.' ||
    (!path.includes('\\') &&
      [...path].every((character) => character.charCodeAt(0) >= 32) &&
      path.split('/').every((part) => !['', '.', '..', '.git'].includes(part)))
  )
}

export function parseRepoVerification(value: unknown): Result<RepoVerificationContract> {
  if (!validateContract(value))
    return err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validateContract.errors)))
  if (value.checks.length > 16)
    return err(makeError('SCHEMA_VIOLATION', '项目验证最多允许 16 条检查'))
  const ids = new Set<string>()
  const remoteNames = new Set<string>()
  for (const check of value.checks) {
    if (ids.has(check.id))
      return err(makeError('SCHEMA_VIOLATION', `项目验证检查 ID 冲突：${check.id}`))
    ids.add(check.id)
    if (
      check.paths !== undefined &&
      (check.paths.length > 32 || check.paths.some((path) => !validPath(path)))
    )
      return err(makeError('SCHEMA_VIOLATION', `项目验证路径无效：${check.id}`))
    if (
      check.kind === 'local' &&
      (check.argv.length > 32 ||
        JSON.stringify(check.argv).length > 4000 ||
        !/^[A-Za-z0-9_./-]+$/.test(check.argv[0]))
    )
      return err(makeError('SCHEMA_VIOLATION', `项目验证缺少有效的可执行文件：${check.id}`))
    if (check.kind === 'remote') {
      if (check.name.trim() !== check.name || remoteNames.has(check.name))
        return err(makeError('SCHEMA_VIOLATION', `远端检查名称无效或冲突：${check.name}`))
      remoteNames.add(check.name)
    }
  }
  return ok(value)
}

function pathContains(scope: string, path: string): boolean {
  return scope === '.' || scope === path || path.startsWith(`${scope}/`)
}

export function applicableProjectRules(
  rules: readonly ProjectRule[],
  scope: readonly string[],
): readonly ProjectRule[] {
  return rules.filter((rule) => {
    const directory = rule.path === 'AGENTS.md' ? '.' : rule.path.slice(0, -'/AGENTS.md'.length)
    return scope.some((path) => pathContains(path, directory) || pathContains(directory, path))
  })
}

export function applicableProjectChecks(
  binding: ProjectVerificationBinding,
  files: readonly string[],
): Result<readonly ProjectCheck[]> {
  if (binding.contract === null) return ok([])
  const covers = (check: ProjectCheck, path: string) =>
    check.paths === undefined || check.paths.some((scope) => pathContains(scope, path))
  const missing = files.filter(
    (file) => !binding.contract?.checks.some((check) => covers(check, file)),
  )
  if (missing.length > 0)
    return err(
      makeError('STAGE_GATE_FAILED', `项目验证没有覆盖改动路径：${missing.slice(0, 8).join(', ')}`),
    )
  const checks = binding.contract.checks.filter(
    (check) =>
      check.paths === undefined ||
      check.paths.includes('.') ||
      files.some((file) => covers(check, file)),
  )
  if (checks.length === 0)
    return err(makeError('STAGE_GATE_FAILED', '项目验证契约没有覆盖本次改动的必要检查'))
  return ok(checks)
}

export function projectVerificationDigest(binding: ProjectVerificationBinding): string {
  return sha256CanonicalJson({
    baseline: binding.baseline,
    source: binding.contract === null ? null : 'repo.verification_contract',
    contract: binding.contract,
    rules: binding.rules.map(({ path, digest }) => ({ path, digest })),
  })
}

export function parseProjectVerificationBinding(
  value: unknown,
): Result<ProjectVerificationBinding | null> {
  if (value === null || value === undefined) return ok(null)
  if (
    typeof value !== 'object' ||
    !('baseline' in value) ||
    typeof value.baseline !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.baseline) ||
    !('contract' in value) ||
    !('rules' in value) ||
    !Array.isArray(value.rules)
  ) {
    return err(makeError('PROTOCOL_ERROR', '已绑定项目验证契约无法解析'))
  }
  const contract = value.contract === null ? ok(null) : parseRepoVerification(value.contract)
  if (!contract.ok) return contract
  const rules: ProjectRule[] = []
  for (const item of value.rules as unknown[]) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('path' in item) ||
      typeof item.path !== 'string' ||
      !('content' in item) ||
      typeof item.content !== 'string' ||
      !('digest' in item) ||
      item.digest !== sha256Text(item.content)
    )
      return err(makeError('PROTOCOL_ERROR', '已绑定项目规则来源或摘要无效'))
    rules.push({ path: item.path, content: item.content, digest: item.digest })
  }
  return ok({ baseline: value.baseline, contract: contract.value, rules })
}

export function coversLocalProjectChecks(
  checks: readonly ProjectCheck[],
  results: unknown,
): results is readonly ProjectCheckResult[] {
  const local = checks.filter((check) => check.kind === 'local')
  return (
    Array.isArray(results) &&
    local.length === results.length &&
    local.every((check, index) => {
      const result: unknown = results[index]
      return (
        typeof result === 'object' &&
        result !== null &&
        'id' in result &&
        result.id === check.id &&
        'argv' in result &&
        canonicalJson(result.argv) === canonicalJson(check.argv) &&
        'exit_code' in result &&
        typeof result.exit_code === 'number' &&
        Number.isInteger(result.exit_code) &&
        result.exit_code >= 0 &&
        result.exit_code <= 255 &&
        'output_excerpt' in result &&
        typeof result.output_excerpt === 'string' &&
        result.output_excerpt.length > 0 &&
        result.output_excerpt.length <= 16000
      )
    })
  )
}
