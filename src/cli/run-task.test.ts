/**
 * run-task 的 `--ci real` 接线与 PR URL 回读 —— **确定性**验证,不打真实 GitHub。
 *
 * 真实 GitHub 行为由 github-provider.test.ts(stub HTTP)与 issue-e2e 验收分层覆盖;
 * 这里钉住的是 CLI 侧两条容易悄悄坏掉的规则:
 *
 *   1. `--ci real` 缺 token 必须在**进 loop 之前**失败 —— 否则要花几分钟跑完
 *      brainstorm→develop 才在 CreatePullRequest 撞 AUTH_FAILED;
 *   2. PR URL 从事件流读,且 `SideEffectSkipped`(幂等复用)也要读得出来。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../fact/db.js'
import { readPrUrl, resolveCiGateway, runTask } from './run-task.js'

const ENV_KEYS = ['KEEL_GITHUB_TOKEN', 'GITHUB_TOKEN'] as const
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
const savedModel = process.env.KEEL_MODEL
const savedHarness = process.env.KEEL_HARNESS
const savedAnthropic = process.env.ANTHROPIC_API_KEY

function setToken(value: string | undefined): void {
  for (const k of ENV_KEYS) {
    if (value === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = value
    }
  }
}

beforeEach(() => {
  setToken(undefined)
  delete process.env.KEEL_MODEL
  delete process.env.KEEL_HARNESS
  delete process.env.ANTHROPIC_API_KEY
})

afterAll(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
  if (savedModel === undefined) {
    delete process.env.KEEL_MODEL
  } else {
    process.env.KEEL_MODEL = savedModel
  }
  if (savedHarness === undefined) {
    delete process.env.KEEL_HARNESS
  } else {
    process.env.KEEL_HARNESS = savedHarness
  }
  if (savedAnthropic === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = savedAnthropic
  }
  await closePool()
})

describe('resolveCiGateway · --ci real 的凭据闸门', () => {
  it('缺 token → AUTH_FAILED 且不可重试', () => {
    const r = resolveCiGateway('real')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toMatch(/KEEL_GITHUB_TOKEN/)
  })

  it('有 token → 返回 provider(同时充当 PR 网关与 CI 网关)', () => {
    setToken('t0ken')
    const r = resolveCiGateway('real')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toBeDefined()
    // 一个实例同时满足两个契约 —— driver 第三参与 opts.ci 用的是同一个
    expect(typeof r.value?.createPullRequest).toBe('function')
    expect(typeof r.value?.waitForCi).toBe('function')
  })

  it('模拟模式不构造 provider(缺省不打真实 API)', () => {
    for (const mode of ['passed', 'failed'] as const) {
      const r = resolveCiGateway(mode)
      expect(r.ok && r.value).toBeUndefined()
    }
  })
})

describe('runTask · --ci real 缺 token 时不进 loop', () => {
  it('在 task 查询之前就失败(不存在的 taskId 也报 AUTH_FAILED 而非 NOT_FOUND)', async () => {
    const r = await runTask(randomUUID(), { ci: 'real' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // NOT_FOUND 说明凭据检查排在 DB 查询之后 —— 那就不是「启动即失败」
    expect(r.error.kind).toBe('AUTH_FAILED')
  })

  it('模拟模式下同一个不存在的 taskId 报 NOT_FOUND(证明上一条不是巧合)', async () => {
    const r = await runTask(randomUUID(), { ci: 'passed' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('NOT_FOUND')
  })

  it('空白 model 在 task 查询之前失败(CAPABILITY_UNSUPPORTED 而非 NOT_FOUND)', async () => {
    const r = await runTask(randomUUID(), { ci: 'passed', model: '   ' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/空白/)
  })

  it('非法 harness 在 task 查询之前失败(不静默回退 omp)', async () => {
    const r = await runTask(randomUUID(), { ci: 'passed', harness: 'codex' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('CAPABILITY_UNSUPPORTED')
    expect(r.error.detail).toMatch(/claude/)
  })

  it('harness=claude 缺 ANTHROPIC_API_KEY → AUTH_FAILED 且不可重试', async () => {
    const r = await runTask(randomUUID(), { ci: 'passed', harness: 'claude' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('AUTH_FAILED')
    expect(r.error.retryable).toBe(false)
    expect(r.error.detail).toMatch(/--bare/)
  })
})

/**
 * AC6:高风险 RFC 停在 S-HUMAN_REVIEW 是**设计内**结果(Policy 保留人工闸门),
 * 编排如实走完了 —— 必须回 `ok`(CLI 退出码 0),不能伪装失败也不能伪装成功。
 *
 * 这里不跑模型:直接把 task 放在 S-HUMAN_REVIEW 且无 PENDING run,
 * loop 应当原地返回该状态。git 侧用本地 file:// 仓库,不碰网络。
 */
describe('runTask · 非 S-DONE 停靠如实报告(AC6)', () => {
  it('S-HUMAN_REVIEW 无 PENDING run → ok + finalStatus 原样 + prUrl 为 null', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'keel-origin-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: origin })
      execFileSync('git', ['config', 'user.email', 'keel@test'], { cwd: origin })
      execFileSync('git', ['config', 'user.name', 'keel'], { cwd: origin })
      writeFileSync(join(origin, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', '.'], { cwd: origin })
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: origin })

      const repoId = randomUUID()
      const taskId = randomUUID()
      await asOwner(async (c) => {
        await c.query(
          `INSERT INTO repo (id, provider, remote_url, default_branch)
           VALUES ($1, 'local', $2, 'main')`,
          [repoId, `file://${origin}`],
        )
        await c.query(
          `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
           VALUES ($1, 'S-HUMAN_REVIEW', 'high risk rfc', $2, 'main', $3)`,
          [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
        )
      })

      const r = await runTask(taskId, { ci: 'passed', maxSteps: 3 })
      expect(r.ok, r.ok ? '' : `应如实返回停靠状态,而非报错:${r.error.detail}`).toBe(true)
      if (!r.ok) return
      expect(r.value.finalStatus).toBe('S-HUMAN_REVIEW')
      expect(r.value.steps).toEqual([])
      expect(r.value.prUrl).toBeNull()
    } finally {
      rmSync(origin, { recursive: true, force: true })
    }
  })
})

describe('readPrUrl · 从事件流回读 PR', () => {
  async function seedTask(): Promise<string> {
    const repoId = randomUUID()
    const taskId = randomUUID()
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
         VALUES ($1, 'github', $2, 'main')`,
        [repoId, `https://github.com/acme/pr-${taskId.slice(0, 8)}.git`],
      )
      await c.query(
        `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
         VALUES ($1, 'S-PR_OPEN', 'pr url readback', $2, 'main', $3)`,
        [taskId, repoId, `ai/task-${taskId.slice(0, 8)}`],
      )
    })
    return taskId
  }

  async function emit(taskId: string, type: string, payload: unknown): Promise<void> {
    await asOwner((c) =>
      c.query(`INSERT INTO event (task_id, type, payload) VALUES ($1, $2, $3::jsonb)`, [
        taskId,
        type,
        JSON.stringify(payload),
      ]),
    )
  }

  it('SideEffectApplied(首次创建)→ 读出 pr_url', async () => {
    const taskId = await seedTask()
    await emit(taskId, 'SideEffectApplied', {
      kind: 'CreatePullRequest',
      pr_number: 7,
      pr_url: 'https://github.com/acme/widget/pull/7',
    })
    expect(await readPrUrl(taskId)).toBe('https://github.com/acme/widget/pull/7')
  })

  it('SideEffectSkipped(幂等复用)→ 也读得出来', async () => {
    const taskId = await seedTask()
    await emit(taskId, 'SideEffectSkipped', {
      kind: 'CreatePullRequest',
      pr_number: 9,
      pr_url: 'https://github.com/acme/widget/pull/9',
    })
    expect(await readPrUrl(taskId)).toBe('https://github.com/acme/widget/pull/9')
  })

  it('无 PR 事件 → null(不编造)', async () => {
    const taskId = await seedTask()
    await emit(taskId, 'SideEffectApplied', { kind: 'CreateBranch', dedupe_key: 'x' })
    expect(await readPrUrl(taskId)).toBeNull()
  })
})
