/**
 * 反馈里**显式声明**的范围约束 —— 与 RFC 的 policy_facts 做一致性核对。
 *
 * 为什么需要机械核对(2026-08-27,父任务 AC5):
 *   验收 Issue 正文写死了 `risk=low / complexity=low / estimated_files=1 /
 *   security_sensitive=false`,rfc_draft 仍连续两次自报 high/high ——
 *   命中 Policy P1 停在 S-HUMAN_REVIEW。提示词已改成「原样采用」,
 *   但**只靠提示词就是靠模型自觉**;本模块把它变成一次可回灌的拒绝。
 *
 * 这不是放宽 Policy:被拒的提案要重写,RFC 仍要过 P1–P4。核对的语义是
 * **RFC 越界**而非风险豁免 —— 反馈声明的范围是这次改动被允许的上限,
 * RFC 自报超出上限说明它写的不是这条反馈要的东西。模型若坚持超出范围,
 * 三次回灌耗尽后 Run 失败,由 T-030/T-031 升人工 —— 该人看的还是人看。
 *
 * ⚠️ 信任边界:feedback.body 是不可信输入(prompt injection 入口)。
 * 让它约束 policy_facts 的前提是 D2 的 label 闸门 —— 只有有 triage 权限的人
 * 能给 Issue 打 `keel` label,反馈才会进入系统。核对只在反馈**显式写出**
 * 键值时生效,自由文本里的「风险不大」一律不解析。
 */

import type { SchemaViolation } from '../../contracts/types.js'

export type Level = 'low' | 'medium' | 'high'

/** 反馈中显式声明的约束。未声明的字段缺省 —— 缺省即「由模型自评估」 */
export interface DeclaredPolicyFacts {
  readonly risk?: Level
  readonly complexity?: Level
  readonly estimated_files_changed?: number
  readonly security_related?: boolean
}

/**
 * 只认「键 = 值」形式的显式声明。
 *
 * 分隔符收 `=` / `:` / `：` 三种(中文 Issue 常用全角冒号);
 * 键名收若干实际出现过的别名 —— 反馈是人写的,不是表单。
 */
const RISK = /(?:^|[^\w])risk\s*[=:：]\s*(low|medium|high)\b/i
const COMPLEXITY = /(?:^|[^\w])complexity\s*[=:：]\s*(low|medium|high)\b/i
const FILES = /(?:^|[^\w])(?:estimated_files(?:_changed)?|files_changed)\s*[=:：]\s*(\d+)\b/i
const SECURITY =
  /(?:^|[^\w])(?:security_related|security_sensitive|security)\s*[=:：]\s*(true|false)\b/i

/** 从反馈原文里解析显式声明的约束。同一键多次出现取第一次 */
export function parseDeclaredPolicyFacts(text: string): DeclaredPolicyFacts {
  const risk = RISK.exec(text)?.[1]?.toLowerCase() as Level | undefined
  const complexity = COMPLEXITY.exec(text)?.[1]?.toLowerCase() as Level | undefined
  const files = FILES.exec(text)?.[1]
  const security = SECURITY.exec(text)?.[1]?.toLowerCase()

  return {
    ...(risk === undefined ? {} : { risk }),
    ...(complexity === undefined ? {} : { complexity }),
    ...(files === undefined ? {} : { estimated_files_changed: Number(files) }),
    ...(security === undefined ? {} : { security_related: security === 'true' }),
  }
}

/**
 * 把显式声明渲染成 rfc_draft 提示词里的一段**具体指令**。
 *
 * 为什么光有核对(4b)不够(2026-08-28):提示词只泛泛说「原样采用反馈给出的约束」,
 * 要模型自己从正文里认出哪些是约束、叫什么键名;而 4b 核对的是具体字面值。
 * 两边不对齐时,模型第一轮几乎必然被拒 —— 一次预料之中的拒绝要烧掉一整轮
 * R-007,而整个 session 的墙钟是所有轮次**共用**的(pipeline.ts 的 watchdog),
 * 于是 4b 反而把「答得快但答错」变成了「超时」。
 *
 * 这里把 4b 将要核对的值原样写进提示词:**要它填什么,就先告诉它填什么**。
 * 值来自同一个 parse 函数,因此提示词与核对永远同源,不会各说各话。
 *
 * ⚠️ 注入面:渲染的是 parse 出的枚举/数字/布尔,不是反馈原文 ——
 * 原文另由 ContextBuilder 的 feedback section 给出,这里不放大它。
 */
export function declaredFactsDirective(declared: DeclaredPolicyFacts): string | null {
  const entries = Object.entries(declared)
  if (entries.length === 0) return null

  return [
    '本次反馈**已显式声明**下列约束,policy_facts 必须逐字填成这些值 ——',
    '系统会机械核对,不符即退回重写(白烧一轮):',
    ...entries.map(([field, value]) => `- "${field}": ${JSON.stringify(value)}`),
    '这同时是本次改动的**范围上限**:proposed_change 必须落在其内,' +
      '超出的内容写进 non_goals,而不是抬高这几个取值。',
  ].join('\n')
}

/**
 * 核对 RFC 的 policy_facts 是否与反馈的显式声明一致。
 *
 * 只比较**声明过**的字段;返回的 violation 直接进 R-007 回灌,
 * 所以消息里必须给出「反馈写了什么 / RFC 写了什么 / 怎么改」
 * (见 .trellis/spec/backend/error-handling.md §检查脚本的失败输出)。
 */
export function policyFactsConflicts(
  declared: DeclaredPolicyFacts,
  rfcBody: unknown,
): SchemaViolation[] {
  const facts = (rfcBody as { policy_facts?: Record<string, unknown> } | null)?.policy_facts
  if (facts === undefined) return []

  const out: SchemaViolation[] = []
  for (const [field, want] of Object.entries(declared)) {
    const got = facts[field]
    if (got === want) continue
    out.push({
      path: `policy_facts.${field}`,
      rule: 'declared-scope',
      message:
        `用户反馈已显式声明 ${field}=${JSON.stringify(want)},RFC 却写成 ` +
        `${JSON.stringify(got)}。反馈给出的约束优先于自评估,也是本次改动的范围上限:` +
        `把 policy_facts.${field} 改回 ${JSON.stringify(want)},` +
        `并把超出该范围的内容移到 non_goals。`,
    })
  }
  return out
}
