/** JT-01 managed 影子模式的薄 CLI 接线。 */

import { execFileSync } from 'node:child_process'
import {
  type ManagedActionGatewayDeps,
  reconcileAction,
  reconcileUncertainActions,
  runActionGatewayOnce,
} from '../control/managed/action-gateway.js'
import { listActions, retryAction } from '../control/managed/action-store.js'
import {
  type ManagedCheckGatewayDeps,
  runCheckGatewayOnce,
} from '../control/managed/check-gateway.js'
import { listCheckEvidence } from '../control/managed/check-store.js'
import { answerManagedTicketDecision } from '../control/managed/decision-store.js'
import {
  createManagedInvestigation,
  listManagedQuestions,
  tickManaged,
} from '../control/managed/runtime.js'
import { answerManagedQuestion, getManagedTask } from '../control/managed/store.js'
import {
  createManagedTicketTask,
  getManagedTicket,
  tickManagedTicket,
} from '../control/managed/ticket-runtime.js'
import { listManagedTicketStages } from '../control/managed/ticket-store.js'
import { requireClaudeReady } from '../execution/adapters/claude-code.js'
import { requirePiBinary } from '../execution/adapters/pi.js'
import { managedInference } from '../execution/managed-inference.js'
import { ticketWorkerFromAdapter } from '../execution/ticket-stage-runner.js'
import { GitCliPushGateway } from '../fact/git-push.js'
import { GitHubProvider } from '../fact/github-provider.js'
import { createStopToken, interruptibleSleep } from '../ingress/poller.js'
import { createHarnessAdapter, resolveHarness, resolveOptionalModel } from './run-task.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FlagValue = string | true

/** 严格读取当前子命令的选项；拒绝位置参数、未知项、重复项和缺值。 */
function parseFlags(
  argv: readonly string[],
  allowed: readonly string[],
  booleanFlags: readonly string[] = [],
): Map<string, FlagValue> {
  const flags = new Map<string, FlagValue>()
  const known = new Set(allowed)
  const booleans = new Set(booleanFlags)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('--')) throw new Error(`不接受位置参数：${arg}`)
    const name = arg.slice(2)
    if (!known.has(name)) throw new Error(`未知选项：${arg}`)
    if (flags.has(name)) throw new Error(`选项重复：${arg}`)
    if (booleans.has(name)) {
      flags.set(name, true)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少值`)
    if (value.trim() === '') throw new Error(`${arg} 不能为空`)
    flags.set(name, value)
    i++
  }
  return flags
}

function required(flags: Map<string, FlagValue>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少 --${name} 或值为空`)
  return value.trim()
}

function optional(flags: Map<string, FlagValue>, name: string): string | undefined {
  const value = flags.get(name)
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`--${name} 需要非空值`)
  return value.trim()
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new Error(`${label} 必须是 UUID：${value}`)
  return value
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} 必须是正整数：${value}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${label} 必须是安全范围内的正整数：${value}`)
  return parsed
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function reportFailure(error: unknown): void {
  console.error(`managed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

/** 处理 managed 子命令；连接池由统一 CLI dispatch 生命周期关闭。 */
export async function managedMain(argv: readonly string[]): Promise<void> {
  try {
    const [command, ...rest] = argv
    if (command === '--help' || command === '-h' || command === undefined) {
      console.log(`JT-02 jstack managed 只读调查
investigate --repo UUID --question TEXT --package FILE
status TASK_UUID
questions [--task TASK_UUID]
answer QUESTION_UUID --text TEXT（必须精确匹配请求选项）
worker [--once] [--interval MS] [--task TASK_UUID] [--harness omp|claude|pi] [--model ID]
ticket-create --repo UUID --package FILE --worktree PATH [--baseline SHA]
ticket-status TASK_UUID
ticket-stages TASK_UUID
ticket-tick [--task TASK_UUID] [--harness omp|claude|pi] [--model ID]
ticket-worker [--once] [--interval MS] [--task TASK_UUID] [--harness omp|claude|pi] [--model ID]
ticket-answer REQUEST_UUID --revision N --option OPTION_ID
action-list [--task TASK_UUID]
action-gateway [--once] [--interval MS] [--reconcile] [--check-timeout-ms MS]
action-reconcile [--id OUTBOX_UUID] [--once] [--interval MS]
action-retry OUTBOX_UUID
action-check-gateway [--once] [--interval MS]
action-checks [--task TASK_UUID] [--id TARGET_UUID]
调查模式的天问只在 E3 明确决定或 E1 可逆默认范围内自动答复。
ticket 模式按固定包完成 execute→verify→review→land；阶段执行器不 push，
受控 action gateway 创建 PR，check gateway 在准确 SHA 的必需检查通过后推进 pr_ready。`)
      return
    }
    switch (command) {
      case 'investigate': {
        const flags = parseFlags(rest, ['repo', 'question', 'package'])
        const repoId = uuid(required(flags, 'repo'), '--repo')
        const question = required(flags, 'question')
        const packagePath = required(flags, 'package')
        const result = await createManagedInvestigation(repoId, question, packagePath)
        if (!result.ok) throw new Error(result.error.detail)
        console.log(result.value)
        return
      }
      case 'status': {
        if (rest.length !== 1) throw new Error('用法：managed status <task UUID>')
        const task = await getManagedTask(uuid(rest[0] ?? '', 'task ID'))
        if (task === null) throw new Error('找不到 managed task')
        printJson(task)
        return
      }
      case 'questions': {
        const flags = parseFlags(rest, ['task'])
        const taskId = optional(flags, 'task')
        printJson(
          await listManagedQuestions(taskId === undefined ? undefined : uuid(taskId, '--task')),
        )
        return
      }
      case 'answer': {
        if (rest[0]?.startsWith('--'))
          throw new Error('用法：managed answer <question UUID> --text <text>')
        const questionId = uuid(rest[0] ?? '', 'question ID')
        const flags = parseFlags(rest.slice(1), ['text'])
        const result = await answerManagedQuestion(questionId, required(flags, 'text'))
        if (!result.ok) throw new Error(result.error.detail)
        console.log(result.value)
        return
      }
      case 'worker':
        await runWorker(rest)
        return
      case 'ticket-create': {
        const flags = parseFlags(rest, ['repo', 'package', 'worktree', 'baseline'])
        const repoId = uuid(required(flags, 'repo'), '--repo')
        const packagePath = required(flags, 'package')
        const worktreePath = required(flags, 'worktree')
        const baseline = optional(flags, 'baseline')
        const result = await createManagedTicketTask(repoId, packagePath, worktreePath, {
          ...(baseline === undefined ? {} : { baselineCommit: baseline }),
        })
        if (!result.ok) throw new Error(result.error.detail)
        console.log(result.value)
        return
      }
      case 'ticket-status': {
        if (rest.length !== 1) throw new Error('用法：managed ticket-status <task UUID>')
        const task = await getManagedTicket(uuid(rest[0] ?? '', 'task ID'))
        if (!task.ok) throw new Error(task.error.detail)
        printJson(task.value)
        return
      }
      case 'ticket-stages': {
        if (rest.length !== 1) throw new Error('用法：managed ticket-stages <task UUID>')
        printJson(await listManagedTicketStages(uuid(rest[0] ?? '', 'task ID')))
        return
      }
      case 'ticket-tick':
        await runTicketTick(rest)
        return
      case 'ticket-worker':
        await runTicketWorker(rest)
        return
      case 'ticket-answer': {
        if (rest[0]?.startsWith('--'))
          throw new Error('用法：managed ticket-answer <request UUID> --revision N --option OPTION')
        const requestId = uuid(rest[0] ?? '', 'request ID')
        const flags = parseFlags(rest.slice(1), ['revision', 'option'])
        const revision = positiveInteger(required(flags, 'revision'), '--revision')
        const optionId = required(flags, 'option')
        const result = await answerManagedTicketDecision(
          requestId,
          revision,
          optionId,
          new Date().toISOString(),
        )
        if (!result.ok) throw new Error(result.error.detail)
        printJson(result.value)
        return
      }
      case 'action-list': {
        const flags = parseFlags(rest, ['task'])
        const taskId = optional(flags, 'task')
        printJson(await listActions(taskId === undefined ? undefined : uuid(taskId, '--task')))
        return
      }
      case 'action-checks': {
        const flags = parseFlags(rest, ['task', 'id'])
        const taskRaw = optional(flags, 'task')
        const targetRaw = optional(flags, 'id')
        printJson(
          await listCheckEvidence({
            ...(taskRaw === undefined ? {} : { taskId: uuid(taskRaw, '--task') }),
            ...(targetRaw === undefined ? {} : { targetId: uuid(targetRaw, '--id') }),
          }),
        )
        return
      }
      case 'action-gateway':
        await runActionGateway(rest)
        return
      case 'action-check-gateway':
        await runActionCheckGateway(rest)
        return
      case 'action-reconcile':
        await runActionReconcile(rest)
        return
      case 'action-retry': {
        if (rest.length !== 1) throw new Error('用法：managed action-retry <outbox UUID>')
        const result = await retryAction(uuid(rest[0] ?? '', 'outbox ID'), new Date().toISOString())
        if (!result.ok) throw new Error(result.error.detail)
        printJson(result.value)
        return
      }
      default:
        throw new Error(
          '用法：managed investigate|status|questions|answer|worker|ticket-create|ticket-status|ticket-stages|ticket-tick|ticket-worker|ticket-answer|action-list|action-gateway|action-reconcile|action-retry|action-check-gateway|action-checks',
        )
    }
  } catch (error) {
    reportFailure(error)
  }
}

async function runWorker(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv, ['once', 'interval', 'task', 'harness', 'model'], ['once'])
  const once = flags.has('once')
  const intervalRaw = optional(flags, 'interval')
  const intervalMs = intervalRaw === undefined ? 1000 : positiveInteger(intervalRaw, '--interval')
  const taskRaw = optional(flags, 'task')
  const taskId = taskRaw === undefined ? undefined : uuid(taskRaw, '--task')
  const harnessRaw = optional(flags, 'harness')
  const modelRaw = optional(flags, 'model')

  const harness = resolveHarness(harnessRaw, process.env.KEEL_HARNESS)
  if (!harness.ok) throw new Error(harness.error.detail)
  const model = resolveOptionalModel(modelRaw, process.env.KEEL_MODEL)
  if (!model.ok) throw new Error(model.error.detail)

  // 启动预检在 tick/认领之前完成；探测输出丢弃，凭据不读取或打印。
  if (harness.value === 'claude') {
    const ready = requireClaudeReady()
    if (!ready.ok) throw new Error(ready.error.detail)
  } else if (harness.value === 'pi') {
    const ready = requirePiBinary()
    if (!ready.ok) throw new Error(ready.error.detail)
  } else {
    try {
      execFileSync('omp', ['--version'], { stdio: 'ignore' })
    } catch {
      throw new Error('找不到可用的 omp CLI；worker 未认领任务')
    }
  }

  const adapter = createHarnessAdapter(harness.value, model.value)
  const infer = managedInference(adapter)
  if (once) {
    const result = await tickManaged(infer, taskId)
    if (!result.ok) throw new Error(result.error.detail)
    printJson(result.value)
    return
  }

  const stop = createStopToken()
  const onSignal = (): void => stop.request()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    while (!stop.requested) {
      const result = await tickManaged(infer, taskId)
      if (!result.ok) throw new Error(result.error.detail)
      if (result.value !== null) printJson(result.value)
      else await interruptibleSleep(intervalMs, stop)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function createTicketWorker(
  flags: Map<string, FlagValue>,
): Promise<ReturnType<typeof ticketWorkerFromAdapter>> {
  const harnessRaw = optional(flags, 'harness')
  const modelRaw = optional(flags, 'model')
  const harness = resolveHarness(harnessRaw, process.env.KEEL_HARNESS)
  if (!harness.ok) throw new Error(harness.error.detail)
  const model = resolveOptionalModel(modelRaw, process.env.KEEL_MODEL)
  if (!model.ok) throw new Error(model.error.detail)
  if (harness.value === 'claude') {
    const ready = requireClaudeReady()
    if (!ready.ok) throw new Error(ready.error.detail)
  } else if (harness.value === 'pi') {
    const ready = requirePiBinary()
    if (!ready.ok) throw new Error(ready.error.detail)
  } else {
    try {
      execFileSync('omp', ['--version'], { stdio: 'ignore' })
    } catch {
      throw new Error('找不到可用的 omp CLI；ticket worker 未认领任务')
    }
  }
  return ticketWorkerFromAdapter(createHarnessAdapter(harness.value, model.value))
}

async function runTicketTick(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv, ['task', 'harness', 'model'])
  const taskRaw = optional(flags, 'task')
  const taskId = taskRaw === undefined ? undefined : uuid(taskRaw, '--task')
  const worker = await createTicketWorker(flags)
  const result = await tickManagedTicket(worker, taskId)
  if (!result.ok) throw new Error(result.error.detail)
  printJson(result.value)
}

async function runTicketWorker(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv, ['once', 'interval', 'task', 'harness', 'model'], ['once'])
  const once = flags.has('once')
  const intervalRaw = optional(flags, 'interval')
  const intervalMs = intervalRaw === undefined ? 1000 : positiveInteger(intervalRaw, '--interval')
  const taskRaw = optional(flags, 'task')
  const taskId = taskRaw === undefined ? undefined : uuid(taskRaw, '--task')
  const worker = await createTicketWorker(flags)
  if (once) {
    const result = await tickManagedTicket(worker, taskId)
    if (!result.ok) throw new Error(result.error.detail)
    printJson(result.value)
    return
  }
  const stop = createStopToken()
  const onSignal = (): void => stop.request()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    while (!stop.requested) {
      const result = await tickManagedTicket(worker, taskId)
      if (!result.ok) throw new Error(result.error.detail)
      if (result.value !== null) printJson(result.value)
      else await interruptibleSleep(intervalMs, stop)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function actionGatewayDeps(checkTimeoutMs?: number): ManagedActionGatewayDeps {
  return {
    push: new GitCliPushGateway(),
    pullRequests: new GitHubProvider(),
    ...(checkTimeoutMs === undefined ? {} : { checkTimeoutMs }),
  }
}

async function runActionGateway(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(
    argv,
    ['once', 'interval', 'reconcile', 'check-timeout-ms'],
    ['once', 'reconcile'],
  )
  const once = flags.has('once')
  const reconcile = flags.has('reconcile')
  const intervalRaw = optional(flags, 'interval')
  const intervalMs = intervalRaw === undefined ? 2000 : positiveInteger(intervalRaw, '--interval')
  const timeoutRaw = optional(flags, 'check-timeout-ms')
  const checkTimeoutMs =
    timeoutRaw === undefined ? undefined : positiveInteger(timeoutRaw, '--check-timeout-ms')
  const deps = actionGatewayDeps(checkTimeoutMs)

  const step = async (): Promise<boolean> => {
    if (reconcile) {
      const reconciled = await reconcileUncertainActions(deps)
      if (!reconciled.ok) throw new Error(reconciled.error.detail)
      if (reconciled.value.length > 0) printJson(reconciled.value)
    }
    const result = await runActionGatewayOnce(deps)
    if (!result.ok) throw new Error(result.error.detail)
    if (result.value !== null) printJson(result.value)
    return result.value !== null
  }

  if (once) {
    await step()
    return
  }
  const stop = createStopToken()
  const onSignal = (): void => stop.request()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    while (!stop.requested) {
      const worked = await step()
      if (!worked) await interruptibleSleep(intervalMs, stop)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

function checkGatewayDeps(intervalMs: number): ManagedCheckGatewayDeps {
  return {
    checks: new GitHubProvider(),
    pollIntervalMs: intervalMs,
  }
}

async function runActionCheckGateway(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv, ['once', 'interval'], ['once'])
  const once = flags.has('once')
  const intervalRaw = optional(flags, 'interval')
  const intervalMs = intervalRaw === undefined ? 10_000 : positiveInteger(intervalRaw, '--interval')
  const deps = checkGatewayDeps(intervalMs)
  const step = async (): Promise<boolean> => {
    const result = await runCheckGatewayOnce(deps)
    if (!result.ok) throw new Error(result.error.detail)
    if (result.value !== null) printJson(result.value)
    return result.value !== null
  }
  if (once) {
    await step()
    return
  }
  const stop = createStopToken()
  const onSignal = (): void => stop.request()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    while (!stop.requested) {
      const worked = await step()
      if (!worked) await interruptibleSleep(intervalMs, stop)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function runActionReconcile(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv, ['id', 'once', 'interval'], ['once'])
  const outboxRaw = optional(flags, 'id')
  const outboxId = outboxRaw === undefined ? undefined : uuid(outboxRaw, '--id')
  const once = flags.has('once') || outboxId !== undefined
  const intervalRaw = optional(flags, 'interval')
  const intervalMs = intervalRaw === undefined ? 5000 : positiveInteger(intervalRaw, '--interval')
  const deps = actionGatewayDeps()

  const step = async (): Promise<boolean> => {
    if (outboxId !== undefined) {
      const result = await reconcileAction(outboxId, deps)
      if (!result.ok) throw new Error(result.error.detail)
      printJson(result.value)
      return true
    }
    const result = await reconcileUncertainActions(deps)
    if (!result.ok) throw new Error(result.error.detail)
    if (result.value.length > 0) printJson(result.value)
    return result.value.length > 0
  }

  if (once) {
    await step()
    return
  }
  const stop = createStopToken()
  const onSignal = (): void => stop.request()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    while (!stop.requested) {
      const worked = await step()
      if (!worked) await interruptibleSleep(intervalMs, stop)
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
