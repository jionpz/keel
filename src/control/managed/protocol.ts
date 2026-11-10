/** Schema 来自 docs/schemas/managed，不扩展旧 ArtifactKind。 */
import { createHash } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  JstackInvestigationPackage,
  ManagedInvestigationResult,
  TianwenSuggestion,
} from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'

const ajv = new Ajv2020({ allErrors: true })
const validators = {
  package: ajv.compile<JstackInvestigationPackage>(MANAGED_SCHEMAS.workflow_package),
  investigation: ajv.compile<ManagedInvestigationResult>(MANAGED_SCHEMAS.investigation_result),
  tianwen: ajv.compile<TianwenSuggestion>(MANAGED_SCHEMAS.tianwen_suggestion),
}

export function validatePackage(value: unknown): Result<JstackInvestigationPackage> {
  const validate = validators.package
  return validate(value)
    ? ok(value)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors)))
}

export function validateInvestigation(value: unknown): Result<ManagedInvestigationResult> {
  const validate = validators.investigation
  return validate(value)
    ? ok(value)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors)))
}

export function validateTianwen(value: unknown): Result<TianwenSuggestion> {
  const validate = validators.tianwen
  return validate(value)
    ? ok(value)
    : err(makeError('SCHEMA_VIOLATION', ajv.errorsText(validate.errors)))
}

/** 键排序使相同包不因 JSON 排列不同而换身份。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function packageDigest(value: JstackInvestigationPackage): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
