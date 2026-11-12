import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { claimRunForExecution } from './concurrency/limits.js'
import { WorkflowDriver } from './driver/driver.js'
import { RuleBasedPolicyEngine } from './policy/engine.js'
import { DEFAULT_RULESET } from './policy/ruleset.js'
import { controlTask } from './task-control.js'
import { CONTROL_TRANSITIONS, controlTransition } from './transition/control-mode.js'

const now = '2026-11-12T10:00:00Z'
let taskId: string

beforeEach(async () => {
  taskId = randomUUID()
  await asOwner(async (client) => {
    await client.query('TRUNCATE repo CASCADE')
    const repoId = randomUUID()
    await client.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/console-controls','main')`,
      [repoId],
    )
    await client.query(
      `INSERT INTO task (id, title, status, repo_id, base_branch, work_branch)
       VALUES ($1,'控制台控制','S-NEW',$2,'main','ai/control')`,
      [taskId, repoId],
    )
  })
})

afterAll(closePool)

async function task() {
  return asRole(
    'keel_control',
    async (client) =>
      (await client.query('SELECT status, control_mode FROM task WHERE id=$1', [taskId])).rows[0],
  )
}

async function seedPending(): Promise<string> {
  const runId = randomUUID()
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'pm','PM',1,'PENDING',$3)`,
      [runId, taskId, `${taskId}/pm/1`],
    )
    await client.query(`UPDATE task SET status='S-PM_ANALYZING', current_run_id=$2 WHERE id=$1`, [
      taskId,
      runId,
    ])
  })
  return runId
}

describe('驾驶模式控制', () => {
  it('人工控制表与 docs/04-state-machine.md 的 C-001/003～006 双向一致', () => {
    const rows = readFileSync('docs/04-state-machine.md', 'utf8')
      .split('\n')
      .filter((line) => /^\|\s*`C-\d{3}`/.test(line))
      .map((line) => line.split('|').map((cell) => cell.replaceAll('`', '').trim()))
      .filter((cells) => cells[1] !== 'C-002')
      .map((cells) => ({ id: cells[1], from: cells[2], event: cells[3], to: cells[4] }))
    expect(rows).toEqual(
      CONTROL_TRANSITIONS.map(({ id, from, event, to }) => ({ id, from, event, to })),
    )
  })
  it('控制表与可用模式对应，重复动作不成为另一条转移', () => {
    expect(CONTROL_TRANSITIONS.map((rule) => rule.id)).toEqual([
      'C-001',
      'C-003',
      'C-004',
      'C-005',
      'C-006',
    ])
    expect(controlTransition('paused', 'pause')).toBeUndefined()
    expect(controlTransition('auto', 'resume')).toBeUndefined()
    expect(controlTransition('human', 'takeover')).toBeUndefined()
  })

  it('暂停/恢复不改变业务状态，模式变更和事件一起落库', async () => {
    expect(await controlTask(taskId, 'pause', now)).toMatchObject({
      ok: true,
      value: { from: 'auto', to: 'paused', transition: 'C-001' },
    })
    expect(await controlTask(taskId, 'resume', now)).toMatchObject({
      ok: true,
      value: { from: 'paused', to: 'auto', transition: 'C-005' },
    })
    expect(await task()).toMatchObject({ status: 'S-NEW', control_mode: 'auto' })
    const events = await asOwner((client) =>
      client.query(
        `SELECT payload FROM event WHERE task_id=$1 AND type='ControlModeChanged' ORDER BY seq`,
        [taskId],
      ),
    )
    expect(events.rows.map((event) => event.payload.transition)).toEqual(['C-001', 'C-005'])
  })

  it('终态、重复、过期的控制请求都被拒绝，事件不增加', async () => {
    await controlTask(taskId, 'pause', now)
    expect(await controlTask(taskId, 'pause', now)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT' },
    })
    expect(await controlTask(taskId, 'takeover', now, { expectedMode: 'auto' })).toMatchObject({
      ok: false,
    })
    await asOwner((client) => client.query(`UPDATE task SET status='S-DONE' WHERE id=$1`, [taskId]))
    expect(await controlTask(taskId, 'resume', now)).toMatchObject({ ok: false })
    const events = await asOwner((client) =>
      client.query(
        `SELECT count(*)::int AS count FROM event WHERE task_id=$1 AND type='ControlModeChanged'`,
        [taskId],
      ),
    )
    expect(events.rows[0]?.count).toBe(1)
  })

  it('安全接管与人工交还保留 A-State 版本，空说明不能恢复', async () => {
    expect(await controlTask(taskId, 'takeover', now)).toMatchObject({
      ok: true,
      value: { transition: 'C-003', to: 'human' },
    })
    expect(await controlTask(taskId, 'resume', now)).toMatchObject({ ok: false })
    expect((await task())?.control_mode).toBe('human')
    expect(
      await controlTask(taskId, 'resume', now, { note: '检查完成，没有改动和未决问题。' }),
    ).toMatchObject({ ok: true })
    await controlTask(taskId, 'pause', now)
    expect(await controlTask(taskId, 'takeover', now)).toMatchObject({
      ok: true,
      value: { transition: 'C-004' },
    })
    expect(
      await controlTask(taskId, 'resume', now, { note: '第二次核对，保留已有决定。' }),
    ).toMatchObject({ ok: true })
    const artifacts = await asOwner((client) =>
      client.query(
        `SELECT version, body, superseded_by FROM artifact WHERE task_id=$1 AND kind='state' ORDER BY version`,
        [taskId],
      ),
    )
    expect(artifacts.rows).toHaveLength(2)
    expect(artifacts.rows[0]?.superseded_by).not.toBeNull()
    expect(artifacts.rows[1]?.body.confirmed_facts).toHaveLength(2)
    expect(artifacts.rows[1]?.body.confirmed_facts[1].text).toBe('第二次核对，保留已有决定。')
    expect(await task()).toMatchObject({ status: 'S-NEW', control_mode: 'auto' })
  })

  it('已暂停任务不能被迟到 worker 认领，接管不能与运行中的 Run 并存', async () => {
    const runId = await seedPending()
    await controlTask(taskId, 'pause', now)
    expect(
      await asRole('keel_control', (client) => claimRunForExecution(client, runId)),
    ).toMatchObject({ ok: false })
    await controlTask(taskId, 'resume', now)
    expect(
      await asRole('keel_control', (client) => claimRunForExecution(client, runId)),
    ).toMatchObject({ ok: true })
    expect(await controlTask(taskId, 'takeover', now)).toMatchObject({
      ok: false,
      error: { kind: 'CONFLICT', detail: expect.stringContaining('尚未收尾') },
    })
    expect((await task())?.control_mode).toBe('auto')
    expect(await controlTask(taskId, 'pause', now)).toMatchObject({ ok: true })
  })

  it('并发接管与认领只有一个成功，不出现 human + RUNNING', async () => {
    const runId = await seedPending()
    const results = await Promise.all([
      controlTask(taskId, 'takeover', now),
      asRole('keel_control', (client) => claimRunForExecution(client, runId)),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const rows = await asOwner((client) =>
      client.query(
        `SELECT t.control_mode, r.status FROM task t JOIN run r ON r.task_id=t.id WHERE t.id=$1`,
        [taskId],
      ),
    )
    expect(rows.rows[0]).not.toEqual({ control_mode: 'human', status: 'RUNNING' })
  })

  it('已暂停任务不能被 driver 继续派发；已收尾事件保留 run 与 stage 供恢复', async () => {
    const runId = await seedPending()
    await controlTask(taskId, 'pause', now)
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    expect(await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, now)).toMatchObject({
      ok: true,
      value: { advanced: false },
    })
    const event = await asOwner((client) =>
      client.query(
        `SELECT payload FROM event WHERE task_id=$1 AND type='NoTransition' ORDER BY seq DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(event.rows[0]?.payload).toMatchObject({
      run_id: runId,
      stage: 'pm',
      event: 'RunSucceeded',
      reason: 'control_mode_not_auto',
    })
    expect(
      await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, now, {
        expectedRunId: randomUUID(),
      }),
    ).toMatchObject({ ok: false, error: { kind: 'CONFLICT' } })
  })
})
