/** 确定性协议与真实 PostgreSQL 测试：固定候选只测试接纳/恢复，不代表真实模型验收。 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '../../contracts/errors.js'
import type { ManagedInference } from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import { readManagedFiles } from '../../fact/managed-files.js'
import type { JstackInvestigationPackage } from '../../generated/managed.js'
import { packageDigest } from './protocol.js'
import { createManagedInvestigation, listManagedQuestions, tickManaged } from './runtime.js'
import {
  answerManagedQuestion,
  claimManagedTask,
  getManagedTask,
  withManagedClaim,
} from './store.js'

const workflow: JstackInvestigationPackage = {
  protocol_version: '1.0',
  workflow_id: 'jstack',
  mode: 'investigation',
  source_commit: 'fixture',
  stages: ['execute'],
  instructions: {
    route: 'Question -> execute only',
    stages: 'execute',
    execute: '调查并引用实际观察',
  },
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})
afterAll(closePool)

async function seed(): Promise<{
  taskId: string
  repoId: string
  root: string
  packagePath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'keel-managed-'))
  await writeFile(join(root, 'README.md'), '本项目采用 pnpm；需要选择报告语言。')
  const packagePath = join(root, 'workflow.json')
  await writeFile(packagePath, JSON.stringify(workflow))
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path) VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${root}`, root],
    ),
  )
  const created = await createManagedInvestigation(repoId, '说明项目如何运行', packagePath)
  if (!created.ok) throw new Error(created.error.detail)
  return { taskId: created.value, repoId, root, packagePath }
}

function fixed(value: unknown): ManagedInference {
  return async () => ({ ok: true as const, value: { value, usage: ZERO_USAGE } })
}

async function events(taskId: string): Promise<string[]> {
  return asRole('keel_control', async (c) =>
    (
      await c.query<{ type: string }>(
        'SELECT type FROM managed_event WHERE task_id=$1 ORDER BY seq',
        [taskId],
      )
    ).rows.map((r) => r.type),
  )
}

describe('managed investigation · 持久链路', () => {
  it('读文件→天问建议→人工答复→新worker完成，顺序和来源可审计', async () => {
    const { taskId } = await seed()
    expect(
      (await tickManaged(fixed({ outcome: 'read_files', paths: ['README.md'] }), taskId)).ok,
    ).toBe(true)
    await tickManaged(
      fixed({
        outcome: 'waiting_decision',
        question: '报告用哪种语言？',
        options: ['中文', '英文'],
      }),
      taskId,
    )
    const q = (await listManagedQuestions(taskId))[0]
    expect(q?.status).toBe('OPEN')
    if (q === undefined) throw new Error('missing question')
    expect((await answerManagedQuestion(q.id, '中文')).ok).toBe(false)
    let observed = false
    const tianwen: ManagedInference = async (input) => {
      observed =
        input.phase === 'tianwen' &&
        input.context.sections.some((s) => s.content.includes('报告用哪种语言'))
      return {
        ok: true as const,
        value: {
          value: {
            recommendation: '中文',
            rationale: '当前任务使用中文，但缺明确项目偏好',
            missing_information: ['项目长期报告语言'],
          },
          usage: ZERO_USAGE,
        },
      }
    }
    await tickManaged(tianwen, taskId)
    expect(observed).toBe(true)
    expect((await getManagedTask(taskId))?.status).toBe('WAITING_HUMAN')
    expect(await tickManaged(fixed({}), taskId)).toEqual(ok(null))
    const answers = await Promise.all([
      answerManagedQuestion(q.id, '中文'),
      answerManagedQuestion(q.id, '中文'),
    ])
    expect(answers.every((a) => a.ok)).toBe(true)
    expect((await answerManagedQuestion(q.id, '英文')).ok).toBe(false)
    const state = await getManagedTask(taskId)
    expect(state?.answers).toHaveLength(1)
    const observation = state?.observations[0]
    if (observation === undefined) throw new Error('missing observation')
    const nextWorker: ManagedInference = async (input) => {
      expect(
        input.context.sections.some(
          (s) => s.content.includes('confirmed_answers') && s.content.includes('human'),
        ),
      ).toBe(true)
      return {
        ok: true as const,
        value: {
          value: {
            outcome: 'completed',
            report: '本项目使用 pnpm。',
            citations: [{ path: observation.path, digest: observation.digest }],
          },
          usage: ZERO_USAGE,
        },
      }
    }
    await tickManaged(nextWorker, taskId)
    expect((await getManagedTask(taskId))?.status).toBe('DONE')
    const audit = await events(taskId)
    expect(audit.indexOf('TianwenAttemptStarted')).toBeLessThan(
      audit.indexOf('HumanAttentionRequested'),
    )
    expect(audit.filter((t) => t === 'ManagedHumanAnswered')).toHaveLength(1)
    expect(audit).not.toContain('HumanApproved')
    const contexts = await asRole('keel_control', (c) =>
      c.query('SELECT context FROM managed_attempt WHERE task_id=$1', [taskId]),
    )
    expect(contexts.rows.every((r) => r.context.sections?.length > 0)).toBe(true)
  })

  it('新worker可回收过期租约，旧worker迟到结果被围栏拒绝', async () => {
    const { taskId } = await seed()
    const first = await claimManagedTask(new Date().toISOString(), taskId)
    if (first === null) throw new Error('missing claim')
    await asOwner((c) =>
      c.query(`UPDATE managed_task SET lease_until=now()-interval '1 second' WHERE id=$1`, [
        taskId,
      ]),
    )
    const second = await claimManagedTask(new Date().toISOString(), taskId)
    expect(second?.token).not.toBe(first.token)
    let wrote = false
    const late = await withManagedClaim(first, async () => {
      wrote = true
    })
    expect(late.ok).toBe(false)
    expect(wrote).toBe(false)
    expect(await events(taskId)).toContain('ManagedLeaseExpired')
  })

  it('同任务并发认领只有一个执行者', async () => {
    const { taskId } = await seed()
    const claims = await Promise.all([
      claimManagedTask(new Date().toISOString(), taskId),
      claimManagedTask(new Date().toISOString(), taskId),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it('天问故障也留真实attempt再上报，不把故障写成人工决定', async () => {
    const { taskId } = await seed()
    await tickManaged(
      fixed({ outcome: 'waiting_decision', question: '是否继续？', options: ['是', '否'] }),
      taskId,
    )
    await tickManaged(fixed({ actor: 'human', answer: 'approve' }), taskId)
    expect((await getManagedTask(taskId))?.status).toBe('WAITING_HUMAN')
    expect(await events(taskId)).toContain('TianwenUnavailable')
    expect((await listManagedQuestions(taskId))[0]?.answer).toBeNull()
  })

  it('未读或伪造引用不能完成，真实观察摘要才可作证', async () => {
    const { taskId } = await seed()
    for (let i = 0; i < 3; i++)
      await tickManaged(
        fixed({
          outcome: 'completed',
          report: '我已经读过',
          citations: [{ path: 'README.md', digest: 'a'.repeat(64) }],
        }),
        taskId,
      )
    expect((await getManagedTask(taskId))?.status).toBe('FAILED')
    expect(await events(taskId)).not.toContain('ManagedInvestigationCompleted')
  })

  it('包固定在数据库中，后续替换导出文件不改变既有任务', async () => {
    const { taskId, packagePath } = await seed()
    const digest = (await getManagedTask(taskId))?.package_digest
    await writeFile(packagePath, '{}')
    expect(digest).toBe(packageDigest(workflow))
    let sawOriginal = false
    await tickManaged(async (input) => {
      sawOriginal = input.context.sections.some(
        (s) => s.source_ref === `managed-package:${digest}` && s.content.includes('Question'),
      )
      return {
        ok: true as const,
        value: { value: { outcome: 'read_files', paths: ['README.md'] }, usage: ZERO_USAGE },
      }
    }, taskId)
    expect(sawOriginal).toBe(true)
  })

  it('其他项目问题的答复不影响当前任务', async () => {
    const a = await seed(),
      b = await seed()
    const request = fixed({
      outcome: 'waiting_decision',
      question: '语言？',
      options: ['中文', '英文'],
    })
    await tickManaged(request, a.taskId)
    await tickManaged(request, b.taskId)
    await tickManaged(
      fixed({ recommendation: '中文', rationale: '当前输入语言', missing_information: [] }),
      a.taskId,
    )
    const q = (await listManagedQuestions(a.taskId))[0]
    if (!q) throw new Error('missing question')
    await answerManagedQuestion(q.id, '中文')
    expect((await getManagedTask(b.taskId))?.answers).toEqual([])
    expect((await getManagedTask(b.taskId))?.status).toBe('WAITING_TIANWEN')
  })

  it('模型不能扩大读取到索引外的文件', async () => {
    const { taskId } = await seed()
    await tickManaged(fixed({ outcome: 'read_files', paths: ['../secret'] }), taskId)
    expect((await getManagedTask(taskId))?.error).toBe('PERMISSION_DENIED')
  })

  it('Execution没有managed事实权限，Control不能改删审计事件', async () => {
    const { taskId, root } = await seed()
    expect((await readManagedFiles(root, ['README.md'])).ok).toBe(true)
    await expect(
      asRole('keel_execution', (c) => c.query('SELECT * FROM managed_task')),
    ).rejects.toThrow()
    await expect(
      asRole('keel_execution', (c) =>
        c.query(`INSERT INTO managed_package(digest,body) VALUES($1,'{}')`, ['b'.repeat(64)]),
      ),
    ).rejects.toThrow()
    await expect(
      asRole('keel_control', (c) =>
        c.query('DELETE FROM managed_event WHERE task_id=$1', [taskId]),
      ),
    ).rejects.toThrow()
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_event SET type='HumanApproved' WHERE task_id=$1`, [taskId]),
      ),
    ).rejects.toThrow()
  })

  it('完成后数据库拒绝重写任务和终态尝试', async () => {
    const { taskId } = await seed()
    await tickManaged(fixed({ outcome: 'read_files', paths: ['README.md'] }), taskId)
    const observation = (await getManagedTask(taskId))?.observations[0]
    if (!observation) throw new Error('missing observation')
    await tickManaged(
      fixed({
        outcome: 'completed',
        report: '已验证',
        citations: [{ path: observation.path, digest: observation.digest }],
      }),
      taskId,
    )
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_task SET status='READY' WHERE id=$1`, [taskId]),
      ),
    ).rejects.toThrow('immutable')
    await expect(
      asRole('keel_control', (c) =>
        c.query(`UPDATE managed_attempt SET status='RUNNING' WHERE task_id=$1`, [taskId]),
      ),
    ).rejects.toThrow('immutable')
  })

  it('推理异常有界重试且不把原始stderr写入审计', async () => {
    const { taskId } = await seed()
    const throws: ManagedInference = async () => {
      throw new Error('private-token-in-stderr')
    }
    await tickManaged(throws, taskId)
    expect((await getManagedTask(taskId))?.status).toBe('READY')
    await tickManaged(throws, taskId)
    await tickManaged(throws, taskId)
    expect((await getManagedTask(taskId))?.status).toBe('FAILED')
    const audit = await asRole('keel_control', (c) =>
      c.query('SELECT payload FROM managed_event WHERE task_id=$1', [taskId]),
    )
    expect(JSON.stringify(audit.rows)).not.toContain('private-token-in-stderr')
  })
})
