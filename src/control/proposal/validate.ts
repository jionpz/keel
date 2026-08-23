/**
 * Proposal 五步校验流水线 —— 属 Control Plane。
 *
 * 定义处：docs/05-contracts/session-manager.md §1.2
 *
 * 这是「State 是事实」从原则变成机制的地方：
 * Session 的产出必须过这道关才能成为 Artifact。
 * **emit 不等于写入。**
 */

import type { ValidateFunction } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import * as ajvFormats from 'ajv-formats'
import type { PoolClient } from 'pg'
import type { Proposal, ProposalVerdict, SchemaViolation } from '../../contracts/types.js'
import { SCHEMAS } from '../../generated/schemas.js'

/**
 * 平面越界的禁用键名。
 *
 * **黑名单而非白名单**：schema 已经用 additionalProperties: false 卡死了形状（第 1 步），
 * 这一步防的是**将来某个 schema 放宽后**溜进来的越权字段 ——
 * 它是纵深防御的第二层，不是第一层。
 *
 * 核心语义：**Session 可以陈述事实，但不能指挥流程。**
 * 它可以在 A-State 里写「方案 A 被选中」，
 * 但不能写「把 task.status 改成 DEVELOPING」——
 * 状态推进永远是 Control Plane 依据转移表做的判断。
 */
const FORBIDDEN_KEYS: readonly string[] = [
  'task_status',
  'next_state',
  'next_status',
  'transition',
  'advance_to',
  'force_status',
  'control_mode',
]

// 必须用 Ajv2020：docs/schemas/*.json 声明的是 draft 2020-12，
// 而 ajv 的默认导出是 draft-07 —— 用错会在编译 schema 时直接报
// "no schema with key or ref https://json-schema.org/draft/2020-12/schema"
const ajv = new Ajv2020({ allErrors: true, strict: false })
// ajv-formats 是 CJS 包，在 nodenext ESM 下默认导出被包了两层。
// 实测其命名空间为 { __esModule, default, 'module.exports' }，
// 且 default 与 default.default 都是函数 —— 取第一个可调用的。
type AddFormats = (a: Ajv2020) => unknown
const nsAny = ajvFormats as unknown as { default?: AddFormats & { default?: AddFormats } }
const addFormats: AddFormats =
  nsAny.default?.default ?? nsAny.default ?? (ajvFormats as unknown as AddFormats)
addFormats(ajv)

const validators = new Map<string, ValidateFunction>()
for (const [kind, schema] of Object.entries(SCHEMAS)) {
  validators.set(kind, ajv.compile(schema))
}

export interface ValidateDeps {
  /** 第 2 步要查当前最新版；第 4 步可能要查 Policy */
  readonly client: PoolClient
}

/**
 * 依次执行五步校验。**任一步失败即整体拒绝。**
 *
 * 返回的 verdict 在拒绝时带 violations —— 它们会被 R-007 回灌给 Session。
 */
export async function validateProposal(
  proposal: Proposal,
  deps: ValidateDeps,
): Promise<ProposalVerdict> {
  // ── 第 1 步：Schema ──
  const schemaViolations = checkSchema(proposal)
  if (schemaViolations.length > 0) {
    return { accepted: false, artifact_ref: null, violations: schemaViolations }
  }

  // ── 第 2 步：引用完整性 ──
  const refViolations = await checkSupersedes(proposal, deps.client)
  if (refViolations.length > 0) {
    return { accepted: false, artifact_ref: null, violations: refViolations }
  }

  // ── 第 3 步：平面越界 ──
  const boundaryViolations = checkPlaneBoundary(proposal)
  if (boundaryViolations.length > 0) {
    return { accepted: false, artifact_ref: null, violations: boundaryViolations }
  }

  // ── 第 4 步：Policy ──
  // v0.1 只有 capability_request 需要授权，且其裁决在 driver 的 T-009 上做。
  // 这里留位置，不做空实现假装校验过了。

  return { accepted: true, artifact_ref: null, violations: [] }
}

/** 第 1 步：按 kind 用 ajv 校验 body */
export function checkSchema(proposal: Proposal): SchemaViolation[] {
  const validate = validators.get(proposal.kind)
  if (validate === undefined) {
    return [
      {
        path: 'kind',
        rule: 'known-kind',
        message: `未知的产物 kind "${proposal.kind}"，可选：${[...validators.keys()].join(' / ')}`,
      },
    ]
  }

  if (validate(proposal.body)) return []

  return (validate.errors ?? []).map((e) => ({
    path: e.instancePath === '' ? '(根)' : e.instancePath,
    rule: e.keyword,
    // 回灌给模型的文本必须具体到「哪个字段违反了什么」——
    // 只说「格式错误」等于让它猜
    message: `${e.instancePath === '' ? '根对象' : e.instancePath} ${e.message ?? '不合法'}${
      e.params !== undefined ? `（${JSON.stringify(e.params)}）` : ''
    }`,
  }))
}

/** 第 2 步：supersedes 必须指向当前最新版 */
async function checkSupersedes(proposal: Proposal, client: PoolClient): Promise<SchemaViolation[]> {
  if (proposal.supersedes === null) return []

  const r = await client.query<{ id: string }>(
    `SELECT id FROM artifact
     WHERE task_id = $1 AND kind = $2 AND key = $3 AND superseded_by IS NULL
     ORDER BY version DESC LIMIT 1`,
    [proposal.task_id, proposal.kind, proposal.key],
  )
  const current = r.rows[0]?.id ?? null

  if (current !== proposal.supersedes) {
    return [
      {
        path: 'supersedes',
        rule: 'must-be-current',
        message: `supersedes 指向 ${proposal.supersedes}，但当前最新版是 ${current ?? '(无)'}`,
      },
    ]
  }
  return []
}

/**
 * 第 3 步：平面越界检查。
 *
 * 递归查找 body 中是否出现指挥流程的键名。
 */
export function checkPlaneBoundary(proposal: Proposal): SchemaViolation[] {
  const found: SchemaViolation[] = []

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        walk(v, `${path}[${i}]`)
      })
      return
    }
    if (typeof node !== 'object' || node === null) return

    for (const [k, v] of Object.entries(node)) {
      const here = path === '' ? k : `${path}.${k}`
      if (FORBIDDEN_KEYS.includes(k)) {
        found.push({
          path: here,
          rule: 'plane-boundary',
          message:
            `提案中不得出现 "${k}" —— Session 可以陈述事实，但不能指挥流程。` +
            `状态推进由 Control Plane 依据转移表决定。`,
        })
      }
      walk(v, here)
    }
  }

  walk(proposal.body, '')
  return found
}

/** 把 violations 拼成回灌给模型的文本 */
export function violationsToFeedback(violations: readonly SchemaViolation[]): string[] {
  return violations.map((v) => `${v.path}：${v.message}`)
}
