/** Schema 来自 docs/schemas/managed，不扩展旧 ArtifactKind。 */
import { Ajv2020 } from 'ajv/dist/2020.js'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  JstackInvestigationPackage,
  ManagedInvestigationResult,
  TianwenSuggestion,
} from '../../generated/managed.js'
import { MANAGED_SCHEMAS } from '../../generated/managed.js'
import { canonicalJson, sha256CanonicalJson } from '../../shared/canonical-json.js'

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

export function packageDigest(value: JstackInvestigationPackage): string {
  return sha256CanonicalJson(value)
}

export { canonicalJson }
