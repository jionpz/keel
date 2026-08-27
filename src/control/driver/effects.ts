/**
 * 副作用执行器 —— 把 transition() 返回的**描述**变成真实动作。
 *
 * transition() 刻意只返回 SideEffect[] 的描述（ADR-0003 硬约束），
 * 这让它可重放；代价是必须有人来执行这些描述。就是这里。
 *
 * 两条纪律：
 *
 * 1. **每个副作用都必须幂等**。事件投递是 at-least-once，
 *    一次重放就会重复开 PR（docs/04-state-machine.md §5）。
 *
 * 2. **未落地的副作用记录为意图，不静默跳过**。
 *    静默跳过会让事件流声称「做过了」而实际没有 ——
 *    那比不做更糟，因为它污染了唯一的事实来源。
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { PullRequestGateway } from '../../contracts/git-provider.js'
import type { PolicyEngine } from '../../contracts/policy-engine.js'
import { commitArtifactOn } from '../../fact/artifact-store.js'
import { branchFor, type GitWorkspace } from '../../fact/git-workspace.js'
import type { Stage } from '../../shared/ids.js'
import { TIMER_DURATIONS } from '../../shared/timers.js'
import type { SideEffect, TransitionEvent } from '../transition/types.js'
import { loadPolicyFacts } from './facts.js'

export interface EffectContext {
  readonly taskId: string
  readonly event: TransitionEvent
  readonly transitionId: string
  /** 时间由外部注入 —— 控制平面不读时钟 */
  readonly now: string
  readonly policy: PolicyEngine
  /**
   * 工作区管理。**可选**：不传时 CreateBranch / CleanWorkspace 退回记录意图。
   *
   * 保持可选是为了让 driver 的单元测试不必准备 git 仓库 ——
   * 但真实编排必须传，否则事件流里会是 SideEffectIntent 而不是真做了。
   */
  readonly workspace?: {
    readonly git: GitWorkspace
    readonly repoId: string
    readonly baseBranch: string
  }
  /**
   * Git 托管方网关。**可选**：不传时 CreatePullRequest 退回记录意图。
   * 真实编排要关闭 v0.1 最后空缺时必须传。
   */
  readonly github?: PullRequestGateway
}

export interface AppliedEffect {
  readonly kind: SideEffect['kind']
  readonly outcome: 'applied' | 'skipped' | 'intent'
  readonly detail: string
}

/**
 * StartTimer(issue #24,方案 A):clarification TTL 持久化。
 *
 * due_at = 注入 now + TIMER_DURATIONS.kind。幂等:同 (task_id, kind)
 * 至多一个 pending(部分唯一索引),重复启动 DO NOTHING → skipped。
 */
async function startTimer(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect & { kind: 'StartTimer' },
): Promise<AppliedEffect> {
  const durationMs = TIMER_DURATIONS[effect.timer]
  const due = new Date(new Date(ctx.now).getTime() + durationMs).toISOString()
  const ins = await c.query(
    `INSERT INTO timer (id, task_id, run_id, kind, due_at, state)
     VALUES ($1,$2,NULL,$3,$4,'pending')
     ON CONFLICT (task_id, kind) WHERE state = 'pending' DO NOTHING`,
    [randomUUID(), ctx.taskId, effect.timer, due],
  )
  if (ins.rowCount === 0) {
    return { kind: 'StartTimer', outcome: 'skipped', detail: '该 timer 已 pending' }
  }
  return { kind: 'StartTimer', outcome: 'applied', detail: `due ${due}` }
}

/**
 * CancelTimer(T-007):回答澄清时取消 pending 澄清 timer。
 * 0 行更新(已 fired/无)→ skipped —— 已 fire 的由 T-008 吃掉,重放安全。
 */
async function cancelTimer(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect & { kind: 'CancelTimer' },
): Promise<AppliedEffect> {
  const r = await c.query(
    `UPDATE timer SET state='cancelled', updated_at=$3
     WHERE task_id=$1 AND kind=$2 AND state='pending'`,
    [ctx.taskId, effect.timer, ctx.now],
  )
  if (r.rowCount === 0) {
    return { kind: 'CancelTimer', outcome: 'skipped', detail: '无 pending 澄清 timer' }
  }
  return { kind: 'CancelTimer', outcome: 'applied', detail: '已取消澄清 timer' }
}

/**
 * ConsumeTimer(T-008):收割到期澄清 timer,置 fired。
 *
 * **必须在 advance 同一事务内执行**(方案 A:claim 只锁不标;fired 属于
 * T-008 的原子性) —— 失败回滚则仍 pending,崩溃可重投。
 * 0 行(未到期/已 fired)→ skipped:重放或误投不重复收割。
 */
async function consumeTimer(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect & { kind: 'ConsumeTimer' },
): Promise<AppliedEffect> {
  const r = await c.query(
    `UPDATE timer SET state='fired', fired_at=$3, updated_at=$3
     WHERE task_id=$1 AND kind=$2 AND state='pending' AND due_at <= $3`,
    [ctx.taskId, effect.timer, ctx.now],
  )
  if (r.rowCount === 0) {
    return { kind: 'ConsumeTimer', outcome: 'skipped', detail: '无到期 pending 澄清 timer' }
  }
  return { kind: 'ConsumeTimer', outcome: 'applied', detail: '澄清 timer 已 fire' }
}

/** 写一条事件。所有副作用记录都走事件流 —— 不另建表 */
async function emit(
  c: PoolClient,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
): Promise<number> {
  const r = await c.query<{ seq: string }>(
    `INSERT INTO event (task_id, type, payload, occurred_at)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING seq`,
    [taskId, type, JSON.stringify(payload), occurredAt],
  )
  return Number(r.rows[0]?.seq)
}

/**
 * 通知类副作用的幂等判重。
 *
 * 依据是**事件流本身**，不新建一张 side_effect_log 表 ——
 * 副作用的施加记录本来就该在事件流里，
 * 否则「这个 Task 到底发生了什么」的答案会散在两个地方。
 */
async function alreadyApplied(
  c: PoolClient,
  taskId: string,
  kind: string,
  dedupeKey: string,
): Promise<boolean> {
  const r = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM event
     WHERE task_id = $1 AND type = 'SideEffectApplied'
       AND payload->>'kind' = $2 AND payload->>'dedupe_key' = $3`,
    [taskId, kind, dedupeKey],
  )
  return Number(r.rows[0]?.n ?? 0) > 0
}

/** 解析 CreateRun 的 stage：'SAME' 取自事件携带的 stage */
function resolveStage(effect: SideEffect & { kind: 'CreateRun' }, event: TransitionEvent): Stage {
  if (effect.stage !== 'SAME') return effect.stage
  if ('stage' in event) return event.stage
  throw new Error(`CreateRun 要求 stage='SAME'，但事件 ${event.type} 不携带 stage`)
}

async function createRun(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect & { kind: 'CreateRun' },
): Promise<AppliedEffect> {
  const stage = resolveStage(effect, ctx.event)

  const prev = await c.query<{ n: string }>(
    'SELECT count(*) AS n FROM run WHERE task_id = $1 AND stage = $2',
    [ctx.taskId, stage],
  )
  const attempt = effect.attempt === 'first' ? 1 : Number(prev.rows[0]?.n ?? 0) + 1

  // 幂等键与 docs/04-state-machine.md §5.1 一致：(task_id, stage, attempt)
  const key = `${ctx.taskId}/${stage}/${attempt}`

  const ins = await c.query(
    `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'PENDING',$6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [randomUUID(), ctx.taskId, stage, roleFor(stage), attempt, key],
  )

  if (ins.rowCount === 0) {
    await emit(
      c,
      ctx.taskId,
      'SideEffectSkipped',
      { kind: 'CreateRun', idempotency_key: key },
      ctx.now,
    )
    return { kind: 'CreateRun', outcome: 'skipped', detail: `${key} 已存在` }
  }

  await emit(c, ctx.taskId, 'RunCreated', { stage, attempt, idempotency_key: key }, ctx.now)
  return { kind: 'CreateRun', outcome: 'applied', detail: key }
}

function roleFor(stage: Stage): string {
  const map: Record<Stage, string> = {
    pm: 'PM',
    brainstorm: 'PM',
    critic: 'Critic',
    rfc_draft: 'PM',
    develop: 'Developer',
    qa: 'QA',
    review: 'Reviewer',
  }
  return map[stage]
}

async function evaluatePolicy(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect & { kind: 'EvaluatePolicy' },
): Promise<AppliedEffect> {
  const point = effect.point as Parameters<PolicyEngine['evaluate']>[0]
  // capability_request 判定点的 capability fact 来自触发事件（如 CapabilityRequested）
  const capability = 'capability' in ctx.event ? ctx.event.capability : undefined
  const facts = await loadPolicyFacts(c, ctx.taskId, point, {
    ...(capability === undefined ? {} : { capability }),
  })
  const decision = ctx.policy.evaluate(point, facts, ctx.now)
  if (!decision.ok) {
    throw new Error(`Policy 求值失败：${decision.error.detail}`)
  }

  const seq = await emit(
    c,
    ctx.taskId,
    'PolicyEvaluated',
    {
      point,
      decision: decision.value.decision,
      default_applied: decision.value.default_applied,
    },
    ctx.now,
  )

  await commitArtifactOn(c, {
    id: randomUUID(),
    taskId: ctx.taskId,
    kind: 'policy_decision',
    key: point,
    body: decision.value,
    producedByRun: null,
    committedAtSeq: seq,
    supersedes: null,
  })

  return {
    kind: 'EvaluatePolicy',
    outcome: 'applied',
    detail: `${point} → ${decision.value.decision}`,
  }
}

async function freezeRfc(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  const r = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM event
     WHERE task_id = $1 AND type = 'SideEffectApplied' AND payload->>'kind' = 'FreezeRfc'`,
    [ctx.taskId],
  )
  if (Number(r.rows[0]?.n ?? 0) > 0) {
    return { kind: 'FreezeRfc', outcome: 'skipped', detail: 'RFC 已冻结' }
  }
  await emit(c, ctx.taskId, 'SideEffectApplied', { kind: 'FreezeRfc', dedupe_key: 'rfc' }, ctx.now)
  return { kind: 'FreezeRfc', outcome: 'applied', detail: 'RFC 已冻结' }
}

async function notifyOnce(
  c: PoolClient,
  ctx: EffectContext,
  kind: SideEffect['kind'],
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<AppliedEffect> {
  if (await alreadyApplied(c, ctx.taskId, kind, dedupeKey)) {
    await emit(c, ctx.taskId, 'SideEffectSkipped', { kind, dedupe_key: dedupeKey }, ctx.now)
    return { kind, outcome: 'skipped', detail: dedupeKey }
  }
  await emit(
    c,
    ctx.taskId,
    'SideEffectApplied',
    { kind, dedupe_key: dedupeKey, ...payload },
    ctx.now,
  )
  return { kind, outcome: 'applied', detail: dedupeKey }
}

/**
 * v0.1 尚未落地的副作用：记录意图。
 *
 * **不静默跳过** —— 那会让事件流声称做过了而实际没有。
 * 子任务 7 接入真实 git 时，把对应分支换成真实实现，事件流语义不变。
 */
async function recordIntent(
  c: PoolClient,
  ctx: EffectContext,
  effect: SideEffect,
): Promise<AppliedEffect> {
  await emit(
    c,
    ctx.taskId,
    'SideEffectIntent',
    {
      kind: effect.kind,
      transition: ctx.transitionId,
      params: effect,
    },
    ctx.now,
  )
  return { kind: effect.kind, outcome: 'intent', detail: '已记录意图，尚未落地' }
}

/**
 * 建分支 —— 幂等：worktree 已存在则复用。
 *
 * 分支名由 task_id 决定（非随机），这是重放安全的前提。
 */
async function createBranch(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  if (ctx.workspace === undefined) {
    await emit(
      c,
      ctx.taskId,
      'SideEffectIntent',
      {
        kind: 'CreateBranch',
        transition: ctx.transitionId,
        note: '未注入 workspace，仅记录意图',
      },
      ctx.now,
    )
    return { kind: 'CreateBranch', outcome: 'intent', detail: '未注入 workspace' }
  }
  const { git, repoId, baseBranch } = ctx.workspace
  const wt = await git.ensureWorktree(repoId, ctx.taskId, baseBranch)
  if (!wt.ok) throw new Error(`建 worktree 失败：${wt.error.detail}`)

  await emit(
    c,
    ctx.taskId,
    'SideEffectApplied',
    {
      kind: 'CreateBranch',
      dedupe_key: wt.value.branch,
      branch: wt.value.branch,
      worktree: wt.value.path,
    },
    ctx.now,
  )
  return { kind: 'CreateBranch', outcome: 'applied', detail: wt.value.branch }
}

/** 清理工作区。分支保留在裸仓库里 —— 移除的是工作树，不是历史 */
async function cleanWorkspace(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  if (ctx.workspace === undefined) return recordIntent(c, ctx, { kind: 'CleanWorkspace' })
  await ctx.workspace.git.remove(ctx.workspace.repoId, ctx.taskId)
  await emit(
    c,
    ctx.taskId,
    'SideEffectApplied',
    {
      kind: 'CleanWorkspace',
      dedupe_key: ctx.taskId,
    },
    ctx.now,
  )
  return { kind: 'CleanWorkspace', outcome: 'applied', detail: '已移除 worktree' }
}

/**
 * 保留现场（T-041，S-FAILED）。
 *
 * **刻意什么都不做** —— 但要如实记下路径，否则没人知道现场在哪。
 * 不可恢复失败的判定标准很窄，一旦触发就说明有需要人看的东西。
 */
async function preserveWorkspace(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  const path = ctx.workspace?.git.preservePath(ctx.taskId) ?? '(未注入 workspace)'
  await emit(
    c,
    ctx.taskId,
    'SideEffectApplied',
    {
      kind: 'PreserveWorkspace',
      dedupe_key: ctx.taskId,
      preserved_at: path,
    },
    ctx.now,
  )
  return { kind: 'PreserveWorkspace', outcome: 'applied', detail: `保留现场：${path}` }
}

/**
 * 创建 PR —— 幂等：先 push 分支，再交给 PullRequestGateway。
 *
 * 未注入 github / workspace 时退回记录意图，不假装成功。
 */
async function createPullRequest(c: PoolClient, ctx: EffectContext): Promise<AppliedEffect> {
  if (ctx.github === undefined || ctx.workspace === undefined) {
    await emit(
      c,
      ctx.taskId,
      'SideEffectIntent',
      {
        kind: 'CreatePullRequest',
        transition: ctx.transitionId,
        note: '未注入 github provider / workspace，仅记录意图',
      },
      ctx.now,
    )
    return { kind: 'CreatePullRequest', outcome: 'intent', detail: '未注入 github provider' }
  }

  const { git, repoId, baseBranch } = ctx.workspace
  const repo = await c.query<{ remote_url: string; default_branch: string; title: string }>(
    `SELECT r.remote_url, r.default_branch, t.title
     FROM repo r JOIN task t ON t.repo_id = r.id
     WHERE r.id = $1 AND t.id = $2`,
    [repoId, ctx.taskId],
  )
  const row = repo.rows[0]
  if (row === undefined) throw new Error(`找不到 repo/task：${repoId}/${ctx.taskId}`)

  const headBranch = branchFor(ctx.taskId)
  const push = await git.push(repoId, ctx.taskId, row.remote_url)
  if (!push.ok) throw new Error(`push 失败：${push.error.detail}`)

  const pr = await ctx.github.createPullRequest({
    repoId,
    remoteUrl: row.remote_url,
    baseBranch: baseBranch || row.default_branch,
    headBranch,
    title: row.title,
    body: `Keel Task ${ctx.taskId}\n\nAutomated PR.`,
  })
  if (!pr.ok) throw new Error(`创建 PR 失败：${pr.error.detail}`)

  const dedupeKey = headBranch
  if (pr.value.created) {
    await emit(
      c,
      ctx.taskId,
      'SideEffectApplied',
      {
        kind: 'CreatePullRequest',
        dedupe_key: dedupeKey,
        pr_number: pr.value.number,
        pr_url: pr.value.url,
        head_branch: headBranch,
      },
      ctx.now,
    )
    return { kind: 'CreatePullRequest', outcome: 'applied', detail: `PR #${pr.value.number}` }
  }

  await emit(
    c,
    ctx.taskId,
    'SideEffectSkipped',
    {
      kind: 'CreatePullRequest',
      dedupe_key: dedupeKey,
      pr_number: pr.value.number,
      pr_url: pr.value.url,
      head_branch: headBranch,
    },
    ctx.now,
  )
  return { kind: 'CreatePullRequest', outcome: 'skipped', detail: `复用 PR #${pr.value.number}` }
}

export async function applyEffects(
  c: PoolClient,
  ctx: EffectContext,
  effects: readonly SideEffect[],
): Promise<AppliedEffect[]> {
  const applied: AppliedEffect[] = []

  for (const e of effects) {
    switch (e.kind) {
      case 'CreateRun':
        applied.push(await createRun(c, ctx, e))
        break
      case 'EvaluatePolicy':
        applied.push(await evaluatePolicy(c, ctx, e))
        break
      case 'FreezeRfc':
        applied.push(await freezeRfc(c, ctx))
        break
      case 'NotifyHuman':
        applied.push(
          await notifyOnce(c, ctx, e.kind, `${ctx.transitionId}/${e.reason}`, { reason: e.reason }),
        )
        break
      case 'AskUser':
        applied.push(await notifyOnce(c, ctx, e.kind, ctx.transitionId, {}))
        break
      case 'CreateBranch':
        applied.push(await createBranch(c, ctx))
        break
      case 'CleanWorkspace':
        applied.push(await cleanWorkspace(c, ctx))
        break
      case 'PreserveWorkspace':
        applied.push(await preserveWorkspace(c, ctx))
        break
      case 'CreatePullRequest':
        applied.push(await createPullRequest(c, ctx))
        break
      case 'StartTimer':
        applied.push(await startTimer(c, ctx, e))
        break
      case 'CancelTimer':
        applied.push(await cancelTimer(c, ctx, e))
        break
      case 'ConsumeTimer':
        applied.push(await consumeTimer(c, ctx, e))
        break
      // CreateTask 只出现在 T-001，而 T-001 不经 applyEffects（见 driver.intake）。
      // 走到这里说明有人把它加进了别的转移 —— 编程错误，不是可预期失败。
      case 'CreateTask':
        throw new Error('CreateTask 只能经 driver.intake 执行')
      // 以下 v0.1 只记录意图：真实 git / 会话取消属后续子任务。
      // LinkFeedback 留在这里是因为 T-007（澄清回灌）也发它，那条路径本轮不改；
      // T-001 的 LinkFeedback 由 intake 直接落 SideEffectApplied。
      case 'LinkFeedback':
      case 'CancelRun':
      case 'RecordReason':
      case 'MaybeAutoMerge':
        applied.push(await recordIntent(c, ctx, e))
        break
    }
  }

  return applied
}
