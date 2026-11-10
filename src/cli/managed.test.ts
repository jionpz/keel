/** JT-01 managed CLI：参数拒绝与 worker 认领前置检查。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedTask } from '../control/managed/store.js'
import { asOwner, closePool } from '../fact/db.js'
import { managedMain } from './managed.js'

const WORKFLOW = {
  protocol_version: '1.0',
  workflow_id: 'jstack',
  mode: 'investigation',
  source_commit: 'fixture',
  stages: ['execute'],
  instructions: {
    route: '| Question | investigation | execute only |',
    stages: '| execute |',
    execute: '只读调查并引用事实。',
  },
}

const ENV_KEYS = ['PATH', 'KEEL_HARNESS', 'KEEL_MODEL'] as const
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
let savedExitCode: typeof process.exitCode

beforeEach(() => {
  savedExitCode = process.exitCode
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
})

afterEach(() => {
  process.exitCode = savedExitCode
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

afterAll(closePool)

async function expectRejected(argv: readonly string[], message?: string): Promise<void> {
  const priorExitCode = process.exitCode
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await managedMain(argv)
  expect(process.exitCode).toBe(1)
  expect(error).toHaveBeenCalledOnce()
  if (message !== undefined) expect(error.mock.calls[0]?.[0]).toContain(message)
  process.exitCode = priorExitCode
  error.mockRestore()
}

async function seedReadyTask(): Promise<{ taskId: string; root: string; packagePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'keel-managed-cli-'))
  await writeFile(join(root, 'README.md'), '项目事实：源码只读。', 'utf8')
  const packagePath = join(root, 'workflow.json')
  await writeFile(packagePath, JSON.stringify(WORKFLOW), 'utf8')
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
       VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${root}`, root],
    ),
  )
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await managedMain([
    'investigate',
    '--repo',
    repoId,
    '--question',
    '说明项目约束',
    '--package',
    packagePath,
  ])
  expect(process.exitCode).not.toBe(1)
  const taskId = String(output.mock.calls[0]?.[0] ?? '')
  output.mockRestore()
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/i)
  return { taskId, root, packagePath }
}

describe('managed CLI · 参数拒绝', () => {
  it('拒绝未知子命令、未知/重复选项、空值、非法 UUID 和非法 interval', async () => {
    await expectRejected(['unknown'], '用法')
    await expectRejected(
      ['investigate', '--repo', randomUUID(), '--question', 'q', '--package', 'x', '--extra', 'v'],
      '未知选项',
    )
    await expectRejected(
      [
        'investigate',
        '--repo',
        randomUUID(),
        '--repo',
        randomUUID(),
        '--question',
        'q',
        '--package',
        'x',
      ],
      '重复',
    )
    await expectRejected(
      ['investigate', '--repo', randomUUID(), '--question', '   ', '--package', 'x'],
      '不能为空',
    )
    await expectRejected(['status', 'not-a-uuid'], 'UUID')
    await expectRejected(['worker', '--interval', '0'], '正整数')
  })
})

describe.skipIf(process.platform !== 'linux')('managed worker · harness 预检早于认领', () => {
  it('坏 harness 或缺少 omp 时 READY 任务保持未认领', async () => {
    await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
    const { taskId, root } = await seedReadyTask()
    try {
      await expectRejected(['worker', '--once', '--task', taskId, '--harness', 'bad'], 'harness')
      let task = await getManagedTask(taskId)
      expect(task?.status).toBe('READY')
      expect(task?.attempts).toBe(0)

      const emptyPath = await mkdtemp(join(tmpdir(), 'keel-no-harness-'))
      process.env.PATH = emptyPath
      delete process.env.KEEL_MODEL
      await expectRejected(['worker', '--once', '--task', taskId, '--harness', 'omp'], 'omp CLI')
      task = await getManagedTask(taskId)
      expect(task?.status).toBe('READY')
      expect(task?.attempts).toBe(0)
      await rm(emptyPath, { recursive: true, force: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform !== 'linux')('managed CLI · 非 Linux 能力门', () => {
  it('investigate 明确报告缺少 Linux 文件读取能力', async () => {
    await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
    const root = await mkdtemp(join(tmpdir(), 'keel-managed-cli-'))
    try {
      const packagePath = join(root, 'workflow.json')
      await writeFile(packagePath, JSON.stringify(WORKFLOW), 'utf8')
      const repoId = randomUUID()
      await asOwner((c) =>
        c.query(
          `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
           VALUES($1,'local',$2,'main',$3)`,
          [repoId, `file://${root}`, root],
        ),
      )
      await expectRejected(
        ['investigate', '--repo', repoId, '--question', '说明项目约束', '--package', packagePath],
        '/proc/self/fd',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
