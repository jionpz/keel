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
import type { DecisionPoint, PolicyEngine } from '../../contracts/policy-engine.js'
import type { Proposal, ProposalVerdict, SchemaViolation } from '../../contracts/types.js'
import { SCHEMAS } from '../../generated/schemas.js'
import { loadPolicyFacts } from '../driver/facts.js'
import {
  type DeclaredPolicyFacts,
  parseDeclaredPolicyFacts,
  policyFactsConflicts,
} from './feedback-constraints.js'

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
  /** 第 2 步要查当前最新版；第 4 步要查 Policy */
  readonly client: PoolClient
  /** 第 4 步：capability_request 等需要授权的 Proposal 求值 Policy。缺省 = 无裁决 → 拒收 */
  readonly policy?: PolicyEngine
  /** 第 4 步：求值时间由外部注入 —— 可重放性要求不读时钟 */
  readonly now?: string
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
  //
  // 需要授权的 Proposal（v0.1 是 capability_request —— Session emit
  // A-CapabilityRequest 请求一个能力）必须过 Policy 求值。
  // 缺裁决 / 求值失败 → 拒收——不默认放行。
  //
  // 转移侧（driver 的 T-009）也有能力检查,但那是**转移发生前**的守卫;
  // 这里拦截的是**提案本身** —— 未获授权的提案根本不该落库。
  const policyViolations = await checkPolicy(proposal, deps)
  if (policyViolations.length > 0) {
    return { accepted: false, artifact_ref: null, violations: policyViolations }
  }

  // ── 第 4b 步：RFC 不得越出反馈显式声明的范围 ──
  //
  // 提示词要求「反馈给出的约束原样采用」,但提示词只是请求 ——
  // 这里把它变成一次可回灌的拒绝(见 feedback-constraints.ts 的信任边界说明)。
  const scopeViolations = await checkDeclaredScope(proposal, deps.client)
  if (scopeViolations.length > 0) {
    return { accepted: false, artifact_ref: null, violations: scopeViolations }
  }

  return { accepted: true, artifact_ref: null, violations: [] }
}

/**
 * 第 4b 步：RFC 的 policy_facts 与反馈显式声明的约束一致。
 *
 * 只对 rfc 生效;反馈没写显式键值时是空操作 —— 不替模型做裁决。
 */
async function checkDeclaredScope(
  proposal: Proposal,
  client: PoolClient,
): Promise<SchemaViolation[]> {
  if (proposal.kind !== 'rfc') return []

  const declared = await loadDeclaredPolicyFacts(client, proposal.task_id)
  return policyFactsConflicts(declared, proposal.body)
}

/**
 * 读这个 Task 的反馈,解析出其中显式声明的约束。
 *
 * 编排器构造 rfc_draft 提示词时也调它 —— **提示词与 4b 核对必须同源**,
 * 否则会出现「告诉模型填 A、却按 B 核对」的自相矛盾。
 *
 * 查询与 ContextBuilder 的 feedback section 同源:模型看到的就是这几条。
 */
export async function loadDeclaredPolicyFacts(
  client: PoolClient,
  taskId: string,
): Promise<DeclaredPolicyFacts> {
  const r = await client.query<{ body: string }>(
    `SELECT f.body FROM feedback f
     JOIN task_feedback tf ON tf.feedback_id = f.id
     WHERE tf.task_id = $1 ORDER BY f.received_at LIMIT 3`,
    [taskId],
  )
  if (r.rows.length === 0) return {}

  return parseDeclaredPolicyFacts(r.rows.map((x) => x.body).join('\n'))
}

/**
 * 需要授权才可落库的 Proposal 做 Policy 求值。
 *
 * 按 kind 映射判定点：v0.1 只有 capability_request。
 * 缺裁决（policy/now 未注入或 evaluate 失败）同样拒收 ——
 * 失败的信息写进 violation 回灌,不默认放行。
 */
async function checkPolicy(proposal: Proposal, deps: ValidateDeps): Promise<SchemaViolation[]> {
  const point = POLICY_POINTS[proposal.kind]
  if (point === undefined) return [] // 该 kind 不需要授权

  if (deps.policy === undefined || deps.now === undefined) {
    return [
      {
        path: 'policy',
        rule: 'policy-unavailable',
        message: '未注入 Policy 引擎 —— 需要授权的 Proposal 一律拒收',
      },
    ]
  }

  const body = proposal.body as { capability?: unknown }
  const facts = await loadPolicyFacts(deps.client, proposal.task_id, point, {
    ...(body.capability === undefined ? {} : { capability: String(body.capability) }),
  })
  const decision = deps.policy.evaluate(point, facts, deps.now)
  if (!decision.ok) {
    return [
      {
        path: 'policy',
        rule: 'policy-unavailable',
        message: `Policy 求值失败：${decision.error.detail}`,
      },
    ]
  }

  const action = decision.value.decision
  if (action !== 'auto_develop') {
    return [
      {
        path: 'policy',
        rule: 'policy-denied',
        message: `capability_request 未获授权（裁决 ${action}）`,
      },
    ]
  }
  return []
}

/** Proposal kind → Policy 判定点。未列出的 kind 不需要授权 */
const POLICY_POINTS: Readonly<Record<string, DecisionPoint>> = {
  capability_request: 'capability_request',
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
