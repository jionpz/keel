import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { err, makeError, ok, type Result } from '../contracts/errors.js'
import type {
  ProjectCheckResult,
  ProjectVerificationRunner,
} from '../contracts/project-verification.js'
import { buildExecutorEnv } from './isolation/executor-env.js'
import { prepareManagedOsSandbox } from './isolation/os-sandbox.js'
import { supervisedSandboxCommand } from './isolation/process-supervisor.js'

export const runProjectChecks: ProjectVerificationRunner = async (input) => {
  const results: ProjectCheckResult[] = []
  const timeout = AbortSignal.timeout(input.timeoutMs)
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout])
  for (const check of input.checks) {
    if (signal.aborted) return err(makeError('RUN_TIMEOUT', '项目验证命令未全部执行'))
    const root = await mkdtemp('/tmp/keel-project-check-env-')
    const home = join(root, 'home')
    const tmpdir = join(root, 'tmp')
    let cleanupSafe = true
    try {
      await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(tmpdir, { mode: 0o700 })])
      const sandbox = await prepareManagedOsSandbox({
        workspace: input.workspace,
        root,
        home,
        tmpdir,
        readOnlyWorkspace: true,
        restrictFileAccess: true,
        networkPorts: [],
      })
      if (!sandbox.ok) return sandbox
      const [program, ...args] = check.argv
      const command = supervisedSandboxCommand(sandbox.value, program, args)
      const result = await new Promise<Result<ProjectCheckResult>>((resolve) => {
        const child = spawn(command.command, command.args, {
          cwd: input.workspace,
          env: buildExecutorEnv(process.env, { home, tmpdir }),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        const streams = [child.stdout, child.stderr].map((stream) => {
          let output: string | null = ''
          stream.setEncoding('utf8').on('data', (text: string) => {
            if (output !== null) output = output.length + text.length > 7999 ? null : output + text
          })
          return () => output?.replaceAll('\0', '') ?? '（输出超过摘录上限）'
        })
        const abort = () => child.stdin.end()
        child.stdin.on('error', () => undefined)
        child.once('close', (code, termination) => {
          signal.removeEventListener('abort', abort)
          if (code === 125 || termination !== null) cleanupSafe = false
          if (signal.aborted) {
            resolve(err(makeError('RUN_TIMEOUT', `项目验证未完成：${check.id}`)))
          } else if (!cleanupSafe || code === null) {
            resolve(err(makeError('CAPABILITY_UNSUPPORTED', `项目验证的隔离回收失败：${check.id}`)))
          } else {
            resolve(
              ok({
                id: check.id,
                argv: check.argv,
                exit_code: code,
                output_excerpt:
                  streams
                    .map((read) => read())
                    .filter(Boolean)
                    .join('\n') || '（无输出）',
              }),
            )
          }
        })
        child.once('error', () => {
          signal.removeEventListener('abort', abort)
          resolve(err(makeError('CAPABILITY_UNSUPPORTED', `无法启动项目验证沙箱：${check.id}`)))
        })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      if (!result.ok) return result
      results.push(result.value)
    } finally {
      if (cleanupSafe) await rm(root, { recursive: true, force: true })
    }
  }
  return ok(results)
}
