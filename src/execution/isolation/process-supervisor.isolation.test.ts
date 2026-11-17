import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManagedOsSandbox, sandboxCommand } from './os-sandbox.js'
import { supervisedSandboxCommand } from './process-supervisor.js'

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  // 即使被测回收失败也收住夹具，不能让失败测试留下后台写进程。
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  for (const row of rows.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row)
    if (match === null || !roots.some((root) => match[2]?.includes(`${root}/repo/writer.pid`)))
      continue
    try {
      process.kill(Number(match[1]), 'SIGKILL')
    } catch {
      /* 已退出。 */
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function until<T>(fn: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000
  while (true) {
    const value = await fn()
    if (predicate(value)) return value
    if (Date.now() >= deadline) throw new Error('进程回收探针超时')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.skipIf(process.platform !== 'darwin')('same-sandbox supervisor', () => {
  it.each(['success', 'SIGTERM', 'ownerEOF', 'ownerSIGKILL'] as const)(
    '%s 后回收 setsid 双重 fork 且清空 env 的写入进程，不影响其他沙箱或宿主',
    async (ending) => {
      const base = await mkdtemp('/tmp/keel-supervisor-')
      roots.push(base)
      const root = join(base, 'root')
      const home = join(root, 'home')
      const tmpdir = join(root, 'tmp')
      const workspace = join(base, 'repo')
      await Promise.all([home, tmpdir, workspace].map((path) => mkdir(path, { recursive: true })))
      execFileSync('git', ['init', '-q', workspace])
      const prepared = await prepareManagedOsSandbox({ root, home, tmpdir, workspace })
      if (!prepared.ok) throw new Error(prepared.error.detail)
      const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir }

      const outside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      children.push(outside)
      // 同一份 profile 再次启动，仍属于不同的内核 sandbox 身份。
      const unrelatedCommand = sandboxCommand(prepared.value, process.execPath, [
        '-e',
        'console.log("ready");setInterval(() => {}, 1000)',
      ])
      const unrelated = spawn(unrelatedCommand.command, [...unrelatedCommand.args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(unrelated)
      await new Promise<void>((resolve) => unrelated.stdout?.once('data', () => resolve()))

      const heartbeat = join(workspace, 'heartbeat')
      const pidfile = join(workspace, 'writer.pid')
      const writer = `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));
        const write = () => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'tick\\n');
        write(); setInterval(write, 10);
      `
      const middle = `
        const p = require('node:child_process').spawn(process.execPath,
          ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: 'ignore', env: {} });
        p.unref();
      `
      const harness = `
        const p = require('node:child_process').spawn(process.execPath,
          ['-e', ${JSON.stringify(middle)}], { detached: true, stdio: 'ignore', env: {} });
        p.unref();
        ${
          ending === 'success'
            ? `const fs = require('node:fs'); const t = setInterval(() => {
              if (fs.existsSync(${JSON.stringify(heartbeat)})) clearInterval(t);
            }, 10);`
            : 'setInterval(() => {}, 1000);'
        }
      `
      const command = supervisedSandboxCommand(prepared.value, process.execPath, ['-e', harness])
      let worker: ChildProcess
      let owner: ChildProcess | undefined
      if (ending === 'ownerSIGKILL') {
        owner = spawn(
          process.execPath,
          [
            '-e',
            `
          const p = require('node:child_process').spawn(${JSON.stringify(command.command)},
            ${JSON.stringify(command.args)}, { env: ${JSON.stringify(env)},
              stdio: ['pipe', 'ignore', 'inherit'], detached: true });
          console.log(p.pid); setInterval(() => {}, 1000);
        `,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        children.push(owner)
        worker = owner
      } else {
        worker = spawn(command.command, [...command.args], {
          env,
          cwd: workspace,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        children.push(worker)
      }
      let stderr = ''
      worker.stderr?.on('data', (data) => {
        stderr += String(data)
      })
      const exited = new Promise<number | null>((resolve) => worker.once('exit', resolve))
      const writerPid = Number(
        await until(
          () => readFile(pidfile, 'utf8').catch(() => ''),
          (value) => value !== '',
        ),
      )
      if (ending === 'SIGTERM') worker.kill('SIGTERM')
      if (ending === 'ownerEOF') worker.stdin?.end()
      if (ending === 'ownerSIGKILL') owner?.kill('SIGKILL')
      const exitCode = await exited
      if (ending === 'success') expect(exitCode, stderr).toBe(0)
      await until(async () => {
        try {
          process.kill(writerPid, 0)
          return false
        } catch {
          return true
        }
      }, Boolean)
      const before = await readFile(heartbeat, 'utf8')
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(await readFile(heartbeat, 'utf8')).toBe(before)
      expect(() => process.kill(outside.pid as number, 0)).not.toThrow()
      expect(() => process.kill(unrelated.pid as number, 0)).not.toThrow()
      expect(stderr).toBe('')
    },
  )
})
