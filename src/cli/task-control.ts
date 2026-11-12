import { controlTask } from '../control/task-control.js'
import type { ControlAction } from '../control/transition/control-mode.js'
import { parseArgs } from './argv.js'

export async function taskControlMain(
  action: ControlAction,
  argv: readonly string[],
): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  const taskId = positionals[0]
  if (
    taskId === undefined ||
    positionals.length !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId) ||
    Object.keys(flags).some((name) => name !== 'note') ||
    (flags.note !== undefined && typeof flags.note !== 'string')
  ) {
    console.error(`用法：keel ${action} <task UUID> [--note <人工交接说明>]`)
    process.exitCode = 2
    return
  }
  const result = await controlTask(taskId, action, new Date().toISOString(), {
    ...(typeof flags.note === 'string' ? { note: flags.note } : {}),
  })
  if (!result.ok) {
    console.error(result.error.detail)
    process.exitCode = 1
  } else {
    console.log(`${result.value.from} → ${result.value.to}`)
  }
}
