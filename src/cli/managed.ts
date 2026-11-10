/** JT-01 managed 影子模式的薄 CLI 接线。 */

import { execFileSync } from 'node:child_process'
import {
  createManagedInvestigation,
  listManagedQuestions,
  tickManaged,
} from '../control/managed/runtime.js'
import { answerManagedQuestion, getManagedTask } from '../control/managed/store.js'
import { requireClaudeReady } from '../execution/adapters/claude-code.js'
import { managedInference } from '../execution/managed-inference.js'
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
      console.log(`JT-01 jstack managed 只读调查（影子模式）
investigate --repo UUID --question TEXT --package FILE
status TASK_UUID
questions [--task TASK_UUID]
answer QUESTION_UUID --text TEXT
worker [--once] [--interval MS] [--task TASK_UUID] [--harness omp|claude] [--model ID]
所有问题先经天问建议再等人工；尚未开放自动授权或代码修改。`)
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
      default:
        throw new Error('用法：managed investigate|status|questions|answer|worker')
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
