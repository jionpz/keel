import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildExecutorEnv } from '../src/execution/isolation/executor-env.js'

/** 每次检查自带 PostgreSQL、存储和临时目录；不连接宿主开发库或测试库。 */
async function main(): Promise<void> {
  const base = process.env.TMPDIR?.startsWith('/tmp/') ? process.env.TMPDIR : '/tmp'
  const root = await mkdtemp(join(base, 'kv-'))
  const home = join(root, 'home')
  const tmpdir = join(root, 'tmp')
  const socket = join(root, 'pg')
  const data = join(root, 'data')
  await Promise.all([home, tmpdir, socket].map((path) => mkdir(path, { mode: 0o700 })))
  const env = buildExecutorEnv(process.env, { home, tmpdir })
  env.KEEL_DATABASE_URL = `postgres://keel@localhost/keel_verify?host=${encodeURIComponent(socket)}`
  env.DATABASE_URL = env.KEEL_DATABASE_URL
  env.KEEL_BLOB_DIR = join(home, '.keel', 'blob')
  let active: ChildProcess | undefined
  const onInterrupt = () => active?.kill('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)
  const run = (command: string, args: readonly string[], stdio: 'inherit' | 'ignore' = 'inherit') =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { env, stdio })
      active = child
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        active = undefined
        if (signal !== null) reject(new Error(`${command} 被 ${signal} 中断`))
        else resolve(code ?? 1)
      })
    })
  const required = async (command: string, args: readonly string[]) => {
    if ((await run(command, args, 'ignore')) !== 0) throw new Error(`${command} 失败`)
  }
  let started = false
  let passed = false
  try {
    await required('initdb', ['-D', data, '-A', 'trust', '-U', 'keel', '--no-locale', '-E', 'UTF8'])
    await required('pg_ctl', [
      '-D',
      data,
      '-l',
      join(root, 'postgres.log'),
      '-o',
      `-k '${socket.replaceAll("'", "'\\''")}' -h '' -c fsync=off`,
      '-w',
      'start',
    ])
    started = true
    await required('createdb', ['-h', socket, '-U', 'keel', 'keel_verify'])
    const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== '--')
    if (args.length === 0) args.push('pnpm', 'run', 'check')
    const command = args.shift()
    if (command === undefined) throw new Error('缺少验证命令')
    const code = await run(command, args)
    passed = code === 0
    process.exitCode = code
  } catch (error) {
    process.exitCode = 1
    console.error(error instanceof Error ? error.message : String(error))
    const log = await readFile(join(root, 'postgres.log'), 'utf8').catch(() => '')
    if (log !== '') console.error(log)
  } finally {
    if (started) await required('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onInterrupt)
    if (passed) await rm(root, { recursive: true, force: true })
    else console.error(`隔离验证失败，现场保留在 ${root}`)
  }
}

await main()
