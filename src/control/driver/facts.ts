/**
 * 事实加载器 —— 从 Fact Plane 组装转移守卫与 Policy 求值所需的 facts。
 *
 * 硬约束：**只读 Fact Plane**。
 * facts 若混入实时查询外部系统的结果，Policy 与转移就都失去可重放性
 * （docs/05-contracts/policy-engine.md §2、docs/04-state-machine.md §5.3）。
 *
 * 另一条纪律：**读不到必需的 fact 时抛错，不用默认值**。
 * 静默默认会让守卫判错 —— 而判错的方向往往是"看起来一切正常地放行"。
 */

import type { PoolClient } from 'pg'
import type { DecisionPoint, FactSet, PolicyEngine } from '../../contracts/policy-engine.js'
import type { TransitionEvent, TransitionFacts } from '../transition/types.js'

/** 重试上限。v0.1 写死，日后从配置读 */
export const MAX_DEV_ATTEMPTS = 3
export const MAX_STAGE_ATTEMPTS = 3

/** 某阶段已用的尝试次数 */
async function attemptsOf(c: PoolClient, taskId: string, stage: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    'SELECT count(*) AS n FROM run WHERE task_id = $1 AND stage = $2',
    [taskId, stage],
  )
  return Number(r.rows[0]?.n ?? 0)
}

/** 取最新的 A-StageOutcome —— 守卫读的 verdict 来自这里，不是自由文本 */
async function latestStageOutcome(
  c: PoolClient,
  taskId: string,
): Promise<{ verdict: string; needs_design: boolean } | null> {
  const r = await c.query<{ body: Record<string, unknown> }>(
    `SELECT body FROM artifact
     WHERE task_id = $1 AND kind = 'stage_outcome'
     ORDER BY committed_at_seq DESC LIMIT 1`,
    [taskId],
  )
  const body = r.rows[0]?.body
  if (body === undefined) return null
  const details = (body.details ?? {}) as { needs_design?: unknown }
  return {
    verdict: String(body.verdict),
    needs_design: details.needs_design === true,
  }
}

/**
 * capability_request 判定点的求值。
 *
 * 在现场做(而非读落库 A-PolicyDecision)：T-009 的 guard 在 effects 之前执行,
 * 若读上一轮的落库裁决,首次 CapabilityRequested 会因无裁决被拒且永远不会产生
 * 裁决(effects 不执行) —— 死锁。这里由 driver 注入 policy/now 现场求值,
 * 「缺裁决即拒」由 evaluate 失败表达(#1-02)。
 */
async function capabilityAllowed(
  c: PoolClient,
  taskId: string,
  deps: { policy: PolicyEngine; now: string },
  event: TransitionEvent,
): Promise<boolean> {
  const capability = 'capability' in event ? event.capability : undefined
  const facts = await loadPolicyFacts(c, taskId, 'capability_request', {
    ...(capability === undefined ? {} : { capability }),
  })
  const decision = deps.policy.evaluate('capability_request', facts, deps.now)
  if (!decision.ok) return false
  return decision.value.decision === 'auto_develop'
}

/**
 * 组装转移守卫的 facts。
 *
 * `stage_attempts` 取自事件携带的 stage（RunFailed/RunTimeout 才有）；
 * 其余事件用 0 —— 通用重试规则只在阶段态 + Run 失败时才会命中。
 *
 * @param deps 仅 CapabilityRequested 事件需要 —— 现场求值 Policy。
 */
export async function loadTransitionFacts(
  c: PoolClient,
  taskId: string,
  event: TransitionEvent,
  deps: { policy: PolicyEngine; now: string },
): Promise<TransitionFacts> {
  const outcome = await latestStageOutcome(c, taskId)
  const devAttempts = await attemptsOf(c, taskId, 'develop')

  const eventStage = 'stage' in event ? event.stage : undefined
  const stageAttempts = eventStage === undefined ? 0 : await attemptsOf(c, taskId, eventStage)

  const isCapability = event.type === 'CapabilityRequested'

  return {
    verdict: outcome?.verdict ?? null,
    needs_design: outcome?.needs_design ?? false,
    dev_attempts: devAttempts,
    max_dev_attempts: MAX_DEV_ATTEMPTS,
    stage_attempts: stageAttempts,
    max_stage_attempts: MAX_STAGE_ATTEMPTS,
    capability_allowed: isCapability ? await capabilityAllowed(c, taskId, deps, event) : false,
  }
}

/**
 * 组装 Policy 求值的 facts。
 *
 * 按判定点只取该点可用的 fact —— 与 `FACTS_AT` 对应。
 * 取不到必需的静态 fact（如 rfc_ready 时没有 RFC）即抛错。
 */
export async function loadPolicyFacts(
  c: PoolClient,
  taskId: string,
  point: DecisionPoint,
  extra: FactSet = {},
): Promise<FactSet> {
  if (point === 'rfc_ready') {
    const rfc = await c.query<{ body: Record<string, unknown> }>(
      `SELECT body FROM artifact
       WHERE task_id = $1 AND kind = 'rfc' AND superseded_by IS NULL
       ORDER BY version DESC LIMIT 1`,
      [taskId],
    )
    const body = rfc.rows[0]?.body
    if (body === undefined) {
      throw new Error(`判定点 rfc_ready 需要 A-RFC，但 task ${taskId} 还没有`)
    }
    const pf = body.policy_facts as Record<string, unknown> | undefined
    if (pf === undefined) {
      throw new Error(`task ${taskId} 的 A-RFC 缺少 policy_facts`)
    }

    const critic = await c.query<{ body: Record<string, unknown> }>(
      `SELECT body FROM artifact
       WHERE task_id = $1 AND kind = 'critic_review'
       ORDER BY committed_at_seq DESC LIMIT 1`,
      [taskId],
    )
    const confidence = critic.rows[0]?.body?.confidence

    return {
      risk: String(pf.risk),
      complexity: String(pf.complexity),
      estimated_files_changed: Number(pf.estimated_files_changed),
      security_related: pf.security_related === true,
      // 没有 Critic 评审时给 1.0：视作「无异议」。
      // 这是刻意的宽松 —— 收紧它会让所有未经评审的 Task 都落到人工
      critic_confidence: typeof confidence === 'number' ? confidence : 1,
    }
  }

  if (point === 'capability_request') {
    return {
      dev_attempts: await attemptsOf(c, taskId, 'develop'),
      cost_spent_usd: await costSpent(c, taskId),
      // capability 由调用方注入：driver 从事件取,validate 从提案 body 取。
      // 它是「本次请求要什么能力」—— 不在 Fact Plane,不该由这里猜
      ...extra,
    }
  }

  // R6(issue #23):post_develop / qa_failed / pre_pr 未接线(EvaluatePolicy
  // 只挂 rfc_ready / capability_request) —— 加载分支不可达,已删除,
  // 不假装接线。设计意图保留在 docs/05-contracts/policy-engine.md §2.2。
  throw new Error(`判定点 ${point} 未接线,不应触发 loadPolicyFacts`)
}

async function costSpent(c: PoolClient, taskId: string): Promise<number> {
  const r = await c.query<{ s: string | null }>(
    'SELECT coalesce(sum(cost_usd), 0) AS s FROM run WHERE task_id = $1',
    [taskId],
  )
  return Number(r.rows[0]?.s ?? 0)
}
