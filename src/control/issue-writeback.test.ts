import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { err, makeError, ok } from '../contracts/errors.js'
import type { IssueComment, IssueGateway } from '../contracts/issue-gateway.js'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { FactPlaneContextBuilder } from './context/builder.js'
import { WorkflowDriver } from './driver/driver.js'
import { collectIssueClarifications } from './issue-clarification.js'
import { drainIssueWriteback, enqueueIssueWriteback } from './issue-writeback.js'
import { RuleBasedPolicyEngine } from './policy/engine.js'
import { DEFAULT_RULESET } from './policy/ruleset.js'

const now = '2026-11-12T14:00:00Z'
let taskId: string
let repoId: string
let runId: string

beforeEach(async () => {
  taskId = randomUUID()
  repoId = randomUUID()
  runId = randomUUID()
  await asOwner(async (client) => {
    await client.query('TRUNCATE repo, feedback CASCADE')
    await client.query(
      `INSERT INTO repo (id,provider,remote_url,default_branch)
       VALUES ($1,'github','https://github.example.com/acme/widget.git','main')`,
      [repoId],
    )
    await client.query(
      `INSERT INTO task (id,repo_id,title,status,base_branch,work_branch)
       VALUES ($1,$2,'澄清试验','S-NEED_CLARIFICATION','main','ai/test')`,
      [taskId, repoId],
    )
    await client.query(
      `INSERT INTO run (id,task_id,stage,role,attempt,status,idempotency_key)
       VALUES ($1,$2,'pm','PM',1,'SUCCEEDED',$3)`,
      [runId, taskId, `${taskId}/pm/1`],
    )
    await client.query('UPDATE task SET current_run_id=$2 WHERE id=$1', [taskId, runId])
    const feedbackId = randomUUID()
    await client.query(
      `INSERT INTO feedback (id,source,external_ref,body) VALUES ($1,'github','acme/widget#7','原需求')`,
      [feedbackId],
    )
    await client.query('INSERT INTO task_feedback VALUES ($1,$2)', [taskId, feedbackId])
  })
})
afterAll(closePool)

function gateway() {
  const comments: IssueComment[] = []
  const create = vi.fn(async (_remote: string, _number: number, body: string) => {
    const comment = {
      id: Math.max(99, ...comments.map((item) => item.id)) + 1,
      body,
      author: 'keel-bot',
      createdAt: now,
    }
    comments.push(comment)
    return ok(comment)
  })
  const close = vi.fn(async () => ok(undefined))
  const listed = vi.fn(async () => ok({ comments: [...comments], truncated: false }))
  const api: IssueGateway = {
    createIssueComment: create,
    closeIssue: close,
    listIssueComments: listed,
    issueActor: async () => ok('keel-bot'),
  }
  return { api, comments, create, close, listed }
}

async function enable(mode = 'comment') {
  await asOwner((client) =>
    client.query('UPDATE repo SET issue_writeback=$2 WHERE id=$1', [repoId, mode]),
  )
}

async function enqueue(transition = 'T-005', seq = 1) {
  await asRole('keel_control', (client) =>
    enqueueIssueWriteback(client, {
      taskId,
      state: 'S-NEED_CLARIFICATION',
      transition,
      seq,
      now,
    }),
  )
}

async function pmOutcome(version: number, verdict: 'unclear' | 'actionable') {
  await asOwner(async (client) => {
    const event = await client.query<{ seq: string }>(
      `INSERT INTO event (task_id,type,payload) VALUES ($1,'ArtifactCommitted','{}') RETURNING seq`,
      [taskId],
    )
    await client.query(
      `INSERT INTO artifact (id,task_id,kind,key,version,schema_version,body,committed_at_seq)
       VALUES ($1,$2,'stage_outcome','pm',$3,'1.1',$4::jsonb,$5)`,
      [
        randomUUID(),
        taskId,
        version,
        JSON.stringify({
          schema_version: '1.1',
          stage: 'pm',
          run_id: runId,
          verdict,
          reason: '还需澄清',
          ...(verdict === 'unclear' ? { questions: [`第 ${version} 轮具体问题？`] } : {}),
        }),
        event.rows[0]?.seq,
      ],
    )
    await client.query(`UPDATE task SET status='S-PM_ANALYZING' WHERE id=$1`, [taskId])
  })
}

describe('Issue 回写与澄清闭环', () => {
  it.each(['github', 'simulated'] as const)('CI 与合并回写区分 %s 来源', async (source) => {
    const { api, create } = gateway()
    await enable()
    await asOwner((client) =>
      client.query(`UPDATE task SET status='S-PR_OPEN' WHERE id=$1`, [taskId]),
    )
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    expect((await driver.advance(taskId, { type: 'CIPassed', source }, now)).ok).toBe(true)
    expect(
      (
        await driver.advance(
          taskId,
          {
            type: 'PRMerged',
            source,
            mergedAt: now,
            mergeSha: 'a'.repeat(40),
          },
          now,
        )
      ).ok,
    ).toBe(true)
    expect(await drainIssueWriteback(api, now)).toBe(source === 'github' ? 2 : 0)
    const bodies = create.mock.calls.map((call) => call[2])
    if (source === 'github') {
      expect(bodies[0]).toContain('event=ci_passed')
      expect(bodies[1]).toContain('event=merged')
    } else expect(bodies).toEqual([])
  })

  it('节点逐 issue 回写并保持机器标记，T-040 不再评论已关闭 issue', async () => {
    const { api, create } = gateway()
    await enable()
    await asOwner((client) =>
      client.query(
        `INSERT INTO event (task_id,type,payload) VALUES ($1,'SideEffectApplied',$2::jsonb)`,
        [
          taskId,
          JSON.stringify({
            kind: 'CreatePullRequest',
            pr_url: 'https://github.example.com/acme/widget/pull/8',
          }),
        ],
      ),
    )
    const transitions = [
      'T-003',
      'T-005',
      'T-006',
      'T-013',
      'T-021',
      'T-042',
      'T-008',
      'T-024',
      'T-040',
    ]
    for (const [index, transition] of transitions.entries()) await enqueue(transition, index + 1)
    expect(await drainIssueWriteback(api, now)).toBe(8)
    expect(
      create.mock.calls.map(
        (call) => /<!-- keel:v1 event=(\w+) task=([\w-]+) state=([\w-]+) -->$/.exec(call[2])?.[1],
      ),
    ).toEqual([
      'accepted',
      'clarification_requested',
      'rejected',
      'human_review',
      'pr_opened',
      'ci_passed',
      'abandoned',
      'merged',
    ])
    expect(create.mock.calls[4]?.[2]).toContain('/pull/8')
  })
  it('真实 driver 推进与外写解耦，失败不回滚状态，重放不重复入队', async () => {
    const { api, listed, create } = gateway()
    await enable()
    await pmOutcome(1, 'actionable')
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    const advanced = await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, now)
    expect(advanced.ok && advanced.value.advanced).toBe(true)
    expect(create).not.toHaveBeenCalled()
    listed.mockResolvedValueOnce(err(makeError('HARNESS_UNAVAILABLE', 'HTTP 503')))
    expect(await drainIssueWriteback(api, now)).toBe(0)
    expect(
      await asOwner(
        async (client) =>
          (await client.query('SELECT status FROM task WHERE id=$1', [taskId])).rows[0]?.status,
      ),
    ).toBe('S-RFC_DRAFT')
    await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, now)
    expect(await drainIssueWriteback(api, now)).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[2]).toContain('event=accepted')
  })

  it('投递账本只向 control 授权，execution 与 ingress 无读写权限', async () => {
    for (const role of ['keel_execution', 'keel_ingress'] as const) {
      await expect(
        asRole(role, (client) => client.query('SELECT * FROM issue_delivery')),
      ).rejects.toMatchObject({
        code: '42501',
      })
    }
    await expect(
      asRole('keel_control', (client) => client.query('DELETE FROM issue_delivery')),
    ).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('默认 off 无出站调用，显式启用后节点标记稳定、重放幂等', async () => {
    const { api, create, listed } = gateway()
    await enqueue()
    expect(await drainIssueWriteback(api, now)).toBe(0)
    expect(listed).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    await enable()
    await enqueue()
    await enqueue()
    expect(await drainIssueWriteback(api, now)).toBe(1)
    expect(await drainIssueWriteback(api, now)).toBe(0)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toBe('https://github.example.com/acme/widget.git')
    expect(create.mock.calls[0]?.[2]).toMatch(
      /<!-- keel:v1 event=clarification_requested task=[\w-]+ state=S-NEED_CLARIFICATION -->$/,
    )
  })

  it('失败留证并在下一轮恢复；远端成功但本地回执丢失不重复评论', async () => {
    const { api, create, listed } = gateway()
    await enable()
    await enqueue()
    listed.mockResolvedValueOnce(err(makeError('AUTH_FAILED', 'GitHub 认证失败(HTTP 403)')))
    expect(await drainIssueWriteback(api, now)).toBe(0)
    const failed = await asOwner((client) =>
      client.query(`SELECT payload FROM event WHERE type='SideEffectFailed'`),
    )
    expect(failed.rows[0]?.payload.http_status).toBe('403')
    expect(await drainIssueWriteback(api, now)).toBe(1)
    await asOwner((client) =>
      client.query('UPDATE issue_delivery SET delivered_at=NULL,comment_id=NULL'),
    )
    expect(await drainIssueWriteback(api, now)).toBe(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('comment 不关闭；comment_and_close 拒收才关闭，关闭失败不重发评论', async () => {
    const { api, create, close } = gateway()
    await enable()
    await enqueue('T-006')
    await drainIssueWriteback(api, now)
    expect(close).not.toHaveBeenCalled()
    await enable('comment_and_close')
    await enqueue('T-006', 2)
    close.mockResolvedValueOnce(err(makeError('HARNESS_UNAVAILABLE', 'HTTP 503')))
    expect(await drainIssueWriteback(api, now)).toBe(0)
    expect(await drainIssueWriteback(api, now)).toBe(1)
    expect(create).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenLastCalledWith(
      'https://github.example.com/acme/widget.git',
      7,
      'not_planned',
    )
  })

  it('耗尽重试、关闭开关或评论分页截断均不会继续外写', async () => {
    const { api, create, listed } = gateway()
    await enable()
    await enqueue()
    listed.mockResolvedValue(ok({ comments: [], truncated: true }))
    for (let index = 0; index < 6; index++) await drainIssueWriteback(api, now)
    expect(listed).toHaveBeenCalledTimes(5)
    expect(create).not.toHaveBeenCalled()
    await enable('off')
    await drainIssueWriteback(api, now)
    expect(listed).toHaveBeenCalledTimes(5)
  })

  it('只收本轮问题之后的真人评论，复用 T-007，重复与编辑不改首次事实', async () => {
    const { api, comments } = gateway()
    await enable()
    await enqueue()
    await drainIssueWriteback(api, now)
    comments.push(
      { id: 99, body: '旧答复', author: 'owner', createdAt: now },
      { id: 101, body: '机器人自答', author: 'keel-bot', createdAt: now },
      { id: 102, body: '<!-- keel:v1 event=accepted -->', author: 'other', createdAt: now },
      { id: 103, body: '第一条真人答复', author: 'owner', createdAt: now },
      { id: 104, body: '第二条真人答复', author: 'owner', createdAt: now },
    )
    expect(await collectIssueClarifications(api, now)).toBe(1)
    expect(await collectIssueClarifications(api, now)).toBe(0)
    const result = await asOwner(async (client) => ({
      task: (await client.query('SELECT status FROM task WHERE id=$1', [taskId])).rows[0],
      feedback: (
        await client.query(
          `SELECT f.body,f.external_ref FROM feedback f JOIN task_feedback tf ON tf.feedback_id=f.id
           WHERE tf.task_id=$1 ORDER BY f.external_ref`,
          [taskId],
        )
      ).rows,
    }))
    expect(result.task.status).toBe('S-PM_ANALYZING')
    expect(result.feedback.map((row) => row.body)).toEqual([
      '原需求',
      '第一条真人答复',
      '第二条真人答复',
    ])
    expect(result.feedback[1]?.external_ref).toBe('acme/widget#7/comment/103')
    comments[comments.length - 1] = {
      id: 104,
      body: '编辑后的内容',
      author: 'owner',
      createdAt: now,
    }
    expect(await collectIssueClarifications(api, now)).toBe(0)
    await pmOutcome(2, 'unclear')
    const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))
    expect((await driver.advance(taskId, { type: 'RunSucceeded', stage: 'pm' }, now)).ok).toBe(true)
    await drainIssueWriteback(api, now)
    expect(comments.at(-1)?.body).toContain('1. 第 2 轮具体问题？')
    expect(await collectIssueClarifications(api, now)).toBe(0)
    comments.push({ id: 106, body: '第三条最新答复', author: 'owner', createdAt: now })
    expect(await collectIssueClarifications(api, now)).toBe(1)
    const built = await asRole('keel_control', async (client) => {
      const current = await client.query<{ current_run_id: string }>(
        'SELECT current_run_id FROM task WHERE id=$1',
        [taskId],
      )
      return new FactPlaneContextBuilder({ PM: '判断需求' }).build(client, {
        task_id: taskId,
        run_id: current.rows[0]?.current_run_id ?? '',
        stage: 'pm',
        role: 'PM',
        budget_tokens: 200_000,
      })
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const feedback = built.value.sections.find((section) => section.id === 'feedback')?.content
    expect(feedback).toContain('第三条最新答复')
    expect(feedback).toContain('第二条真人答复')
    expect(feedback).not.toContain('编辑后的内容')
  })
})
