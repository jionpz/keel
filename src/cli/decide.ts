/**
 * keel decide / keel answer —— 人工闸门的两个入口。
 *
 * 状态机里 T-014 / T-015 / T-016（人工裁决）与 T-007（补充澄清）一直定义着，
 * 但在此之前**没有任何代码发出这四个事件**：任务停在 S-HUMAN_REVIEW 就永久卡住，
 * S-NEED_CLARIFICATION 只能等 TTL 到期收成 S-ABANDONED。
 *
 * 本模块只做三件事：
 *   1. 预检（status + control_mode）—— 用 `keel_control` 读一次，不满足就**零写入**退出；
 *   2. 需要工作区的决定（approve）先准备项目，让 T-014 的 CreateBranch 真的建分支；
 *   3. 把结果翻译成「发生了什么 + 下一步」，而不是把裸事件名丢给用户。
 *
 * 不在这里做的事：控制台的写路径（控制台只转调本模块，不复制状态机逻辑）、
 * control_mode 的恢复入口（见 design §10）。
 */

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import {
  type AdvanceOptions,
  type AdvanceOutcome,
  WorkflowDriver,
} from '../control/driver/driver.js'
import type { WorkspaceBinding } from '../control/driver/effects.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import type { TransitionEvent } from '../control/transition/types.js'
import { asRole } from '../fact/db.js'
import type { ControlMode, TaskStatus } from '../shared/ids.js'
import { parseArgs } from './argv.js'
import { loadTaskWorkspace } from './task-workspace.js'

export const DECISIONS = ['approve', 'reject', 'rework'] as const
export type Decision = (typeof DECISIONS)[number]

const DECISION_EVENTS: Readonly<Record<Decision, TransitionEvent>> = {
  approve: { type: 'HumanApproved' },
  reject: { type: 'HumanRejected' },
  rework: { type: 'HumanRequestedRework' },
}

const HUMAN_REVIEW: TaskStatus = 'S-HUMAN_REVIEW'
const NEED_CLARIFICATION: TaskStatus = 'S-NEED_CLARIFICATION'

const TERMINAL: readonly TaskStatus[] = ['S-DONE', 'S-REJECTED', 'S-ABANDONED', 'S-FAILED']

/** 只用到 advance —— 抽成接口是为了让测试注入，而不是为了多一层抽象 */
export interface Advancer {
  advance(
    taskId: string,
    event: TransitionEvent,
    now: string,
    opts?: AdvanceOptions,
  ): Promise<Result<AdvanceOutcome>>
}

export interface DecideDeps {
  /** 时间由外部注入，控制平面不读时钟 */
  readonly now?: string
  /** 测试注入：省略则按需构造真实 driver（approve 会先准备工作区） */
  readonly driver?: Advancer
  /** 裁决理由，落一条 HumanDecision 事件 */
  readonly note?: string
}

export interface AnswerDeps {
  readonly now?: string
  readonly driver?: Advancer
}

export interface DecideOutcome {
  readonly taskId: string
  readonly decision: Decision
  readonly transitionId: string | null
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly effects: AdvanceOutcome['effects']
}

export interface AnswerOutcome {
  readonly taskId: string
  readonly feedbackId: string
  readonly transitionId: string | null
  readonly from: TaskStatus
  readonly to: TaskStatus
  readonly effects: AdvanceOutcome['effects']
}

interface TaskSnapshot {
  readonly status: TaskStatus
  readonly control_mode: ControlMode
}

async function readTask(taskId: string): Promise<TaskSnapshot | undefined> {
  const r = await asRole('keel_control', (c) =>
    c.query<TaskSnapshot>('SELECT status, control_mode FROM task WHERE id = $1', [taskId]),
  )
  return r.rows[0]
}

function plainDriver(): WorkflowDriver {
  return new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
}

/**
 * 预检：状态与控制模式都要对得上，否则这条事件本来就不会转移成功。
 *
 * 在这里挡住而不是让 `advance` 去挡：`advance` 对不匹配的事件会**如实**写一条
 * `NoTransition` 事件。那是编排该有的记账，但对一次误触的命令来说，
 * 用户只会看到「什么都没做，库里却多了一条」。预检把这类误触变成零写入。
 *
 * 预检到 advance 之间仍可能被并发改写 —— 那种竞争由 `advance` 的
 * `advanced:false` + `CONFLICT` 表达，不在这里假装刚发生过。
 */
function precondition(
  snapshot: TaskSnapshot,
  expected: TaskStatus,
  expectedCodes: string,
): Result<TaskSnapshot> {
  if (snapshot.status !== expected) {
    const terminal = TERMINAL.includes(snapshot.status)
    const tail = terminal ? '该状态是终态，不可再变更（I8）。' : '本次未写入任何数据。'
    return err(
      makeError(
        'CONFLICT',
        `任务当前是 ${snapshot.status}，只有 ${expected} 接受这条命令。${tail}`,
      ),
    )
  }
  if (snapshot.control_mode !== 'auto') {
    const why =
      snapshot.control_mode === 'paused'
        ? '预算熔断已把 control_mode 置为 paused'
        : '人工接管中（control_mode=human），控制平面按设计不派发新动作'
    return err(
      makeError(
        'CONFLICT',
        `${why}，转移不会生效。本次未写入任何数据。恢复入口（${expectedCodes}）尚未提供。`,
      ),
    )
  }
  return ok(snapshot)
}

/** approve 需要真实工作区，否则 T-014 的 CreateBranch 只会记一条意图、分支并不存在 */
async function workspaceDriver(taskId: string): Promise<Result<WorkflowDriver>> {
  const loaded = await loadTaskWorkspace(taskId)
  if (!loaded.ok) return loaded
  const binding: WorkspaceBinding = loaded.value
  return ok(new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding))
}

export async function decideTask(
  taskId: string,
  decision: Decision,
  deps: DecideDeps = {},
): Promise<Result<DecideOutcome>> {
  const now = deps.now ?? new Date().toISOString()
  const snapshot = await readTask(taskId)
  if (snapshot === undefined) return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))

  const checked = precondition(snapshot, HUMAN_REVIEW, 'C-003/C-005/C-006')
  if (!checked.ok) return checked

  let driver: Advancer
  if (deps.driver !== undefined) {
    driver = deps.driver
  } else if (decision === 'approve') {
    const built = await workspaceDriver(taskId)
    if (!built.ok) return built
    driver = built.value
  } else {
    driver = plainDriver()
  }

  const advanced = await driver.advance(
    taskId,
    DECISION_EVENTS[decision],
    now,
    deps.note === undefined ? {} : { note: deps.note },
  )
  if (!advanced.ok) return advanced
  if (!advanced.value.advanced) {
    return err(
      makeError(
        'CONFLICT',
        `转移未发生：${advanced.value.reason ?? '状态在预检之后被并发改变'}。请重新执行 pnpm keel status ${taskId}。`,
      ),
    )
  }

  return ok({
    taskId,
    decision,
    transitionId: advanced.value.transition_id,
    from: advanced.value.from,
    to: advanced.value.to,
    effects: advanced.value.effects,
  })
}

/**
 * 写一条 `source='manual'` 的 feedback。
 *
 * 走 `keel_ingress` 而不是 `keel_control`：feedback 的写权限只授予了前者
 * （写权限矩阵 + `invariants.test.ts` 的反例测试锚着这一点）。
 * 因此它必然先于 control 事务落库 —— 失败时留下的是一条未被引用的
 * append-only 记录，调用方必须把 id 报出来（见 answerTask）。
 */
async function writeManualFeedback(taskId: string, body: string): Promise<string> {
  const id = randomUUID()
  await asRole('keel_ingress', (c) =>
    c.query(`INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,$3)`, [
      id,
      `clarification:${taskId}:${id}`,
      body,
    ]),
  )
  return id
}

export async function answerTask(
  taskId: string,
  text: string,
  deps: AnswerDeps = {},
): Promise<Result<AnswerOutcome>> {
  const body = text.trim()
  if (body === '') {
    return err(makeError('CAPABILITY_UNSUPPORTED', '澄清答复不能为空白'))
  }

  const now = deps.now ?? new Date().toISOString()
  const snapshot = await readTask(taskId)
  if (snapshot === undefined) return err(makeError('NOT_FOUND', `找不到 task ${taskId}`))

  const checked = precondition(snapshot, NEED_CLARIFICATION, 'C-003/C-005/C-006')
  if (!checked.ok) return checked

  const feedbackId = await writeManualFeedback(taskId, body)
  const driver = deps.driver ?? plainDriver()
  const advanced = await driver.advance(taskId, { type: 'ClarificationReceived', feedbackId }, now)
  if (!advanced.ok || !advanced.value.advanced) {
    // 不静默：feedback 已经落库，它就是这条 append-only 记录的 id
    const detail = advanced.ok
      ? `转移未发生：${advanced.value.reason ?? '未知原因'}`
      : advanced.error.detail
    return err(
      makeError(
        'CONFLICT',
        `${detail}。已写入 feedback ${feedbackId}，但它未关联到任务（可忽略，不影响任何读模型）。`,
      ),
    )
  }

  return ok({
    taskId,
    feedbackId,
    transitionId: advanced.value.transition_id,
    from: advanced.value.from,
    to: advanced.value.to,
    effects: advanced.value.effects,
  })
}

// ─────────────────────────────── CLI ───────────────────────────────

function effectsLines(effects: AdvanceOutcome['effects']): string[] {
  return effects.map((e) => `  ${e.kind.padEnd(18)} ${e.outcome.padEnd(8)} ${e.detail}`)
}

function describeStatus(taskId: string, snapshot: TaskSnapshot): string {
  const terminal = TERMINAL.includes(snapshot.status)
  const lines = [
    `  当前状态：${snapshot.status}${terminal ? '（终态，不可再变更 I8）' : ''}`,
    `  control_mode：${snapshot.control_mode}`,
  ]
  if (snapshot.status === HUMAN_REVIEW) {
    lines.push(`  可用：pnpm keel decide ${taskId} approve|reject|rework [--note <text>]`)
  } else if (snapshot.status === NEED_CLARIFICATION) {
    lines.push(`  可用：pnpm keel answer ${taskId} --text "..."`)
  } else {
    lines.push(`  查看：pnpm keel status ${taskId}`)
  }
  return lines.join('\n')
}

function usageDecide(): string {
  return `用法: pnpm keel decide <taskId> <approve|reject|rework> [--note <text>]

人工裁决 S-HUMAN_REVIEW 状态的任务：
  approve   T-014 建工作分支并派发 develop  → S-DEVELOPING
  reject    T-015 直接驳回                  → S-REJECTED（终态）
  rework    T-016 回炉重新出方案            → S-BRAINSTORM

选项:
  --note <text>   裁决理由，落一条 HumanDecision 事件（不进 prompt、不参与判定）`
}

export async function decideMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(usageDecide())
    return
  }

  const taskId = positionals[0]
  const rawDecision = positionals[1]
  if (taskId === undefined || rawDecision === undefined) {
    console.error(usageDecide())
    process.exitCode = 2
    return
  }
  const decision = DECISIONS.find((d) => d === rawDecision)
  if (decision === undefined) {
    console.error(`decide: 未知的裁决「${rawDecision}」，可用：${DECISIONS.join(' / ')}`)
    process.exitCode = 2
    return
  }
  const note = typeof flags.note === 'string' ? flags.note : undefined
  if (flags.note !== undefined && note === undefined) {
    console.error('decide: --note 需要一个非空理由（只写标志等同于空白）')
    process.exitCode = 2
    return
  }

  const result = await decideTask(taskId, decision, note === undefined ? {} : { note })
  if (!result.ok) {
    console.error(`decide: ${result.error.detail}`)
    const snapshot = await readTask(taskId)
    if (snapshot !== undefined) console.error(describeStatus(taskId, snapshot))
    process.exitCode = 1
    return
  }

  const v = result.value
  console.log(`${v.decision} 已提交：${v.transitionId} ${v.from} → ${v.to}`)
  for (const line of effectsLines(v.effects)) console.log(line)
  if (v.to === 'S-REJECTED') {
    console.log('任务已驳回收尾，无需后续命令。')
  } else {
    console.log(`下一步：pnpm keel run-task ${taskId}`)
  }
}

function usageAnswer(): string {
  return `用法: pnpm keel answer <taskId> --text <text>

回答 S-NEED_CLARIFICATION 状态的澄清：
  - 写入 feedback(source=manual) 并关联到任务
  - 取消澄清 timer，派发新一轮 pm                   → S-PM_ANALYZING

选项:
  --text <text>   澄清答复正文（必填；空白拒绝）`
}

export async function answerMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true) {
    console.log(usageAnswer())
    return
  }

  const taskId = positionals[0]
  if (taskId === undefined) {
    console.error(usageAnswer())
    process.exitCode = 2
    return
  }
  const text = typeof flags.text === 'string' ? flags.text : undefined
  if (text === undefined) {
    console.error('answer: 缺少 --text（澄清答复正文）')
    console.error(usageAnswer())
    process.exitCode = 2
    return
  }

  const result = await answerTask(taskId, text)
  if (!result.ok) {
    console.error(`answer: ${result.error.detail}`)
    const snapshot = await readTask(taskId)
    if (snapshot !== undefined) console.error(describeStatus(taskId, snapshot))
    process.exitCode = 1
    return
  }

  const v = result.value
  console.log(`澄清已回灌：${v.transitionId} ${v.from} → ${v.to}（feedback ${v.feedbackId}）`)
  for (const line of effectsLines(v.effects)) console.log(line)
  console.log(`下一步：pnpm keel run-task ${taskId}`)
}
