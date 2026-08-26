/**
 * ContextBuilder 确定性回归 —— issue #25。
 *
 * rfc_draft 必须能从上下文拿到「用户反馈 + A-State 候选方案」,
 * 否则模型无方案可写(合并验收暴露的断链已由 synthesizeStateFromBrainstorm
 * 修复;这里钉住 context 组装本身)。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../../fact/db.js'
import { FactPlaneContextBuilder } from './builder.js'

let ctxBuilder: FactPlaneContextBuilder

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
  ctxBuilder = new FactPlaneContextBuilder({
    PM: '你是 PM。职责：判断用户反馈是否值得做。',
  })
})

afterAll(closePool)

/** 铺 task + feedback + A-State(候选方案),无任何 run */
async function seed(): Promise<{ taskId: string; runId: string }> {
  const taskId = randomUUID()
  const repoId = randomUUID()
  const feedbackId = randomUUID()
  const runId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body)
       VALUES ($1,'manual',$2,'导出 CSV 时文件编码改为 UTF-8 BOM')`,
      [feedbackId, `ref-${feedbackId}`],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-RFC_DRAFT','t',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
    const ev = await c.query<{ seq: string }>(
      `INSERT INTO event (task_id, type, payload) VALUES ($1,'TaskCreated','{}'::jsonb)
       RETURNING seq`,
      [taskId],
    )
    // build 会写 ContextBuilt 事件(run_id 外键)—— 需真实 run 行
    await c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'rfc_draft','PM',1,'PENDING',$3)`,
      [runId, taskId, `${taskId}/rfc_draft/1`],
    )
    await c.query(
      `INSERT INTO artifact (id, task_id, kind, key, version, schema_version, body, committed_at_seq)
       VALUES ($1,$2,'state','',1,'1.0',$3::jsonb,$4)`,
      [
        randomUUID(),
        taskId,
        JSON.stringify({
          schema_version: '1.0',
          current_goal: '导出加 BOM',
          confirmed_facts: [],
          decisions: [],
          open_questions: [],
          risks: [],
          candidate_options: [{ id: 'A', summary: '导出时加 UTF-8 BOM' }],
        }),
        Number(ev.rows[0]?.seq),
      ],
    )
  })
  return { taskId, runId }
}

describe('FactPlaneContextBuilder · rfc_draft 方案传递(issue #25)', () => {
  it('PM(rfc_draft) 的 context 含用户反馈与 A-State 候选方案', async () => {
    const { taskId, runId } = await seed()
    const r = await asOwner((c) =>
      ctxBuilder.build(c, {
        task_id: taskId,
        run_id: runId,
        role: 'PM',
        stage: 'rfc_draft',
        budget_tokens: 200_000,
      }),
    )
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return

    const contents = r.value.sections.map((s) => s.content).join('\n')
    // 反馈原文进上下文
    expect(contents).toContain('用户反馈')
    expect(contents).toContain('UTF-8 BOM')
    // A-State 候选方案进上下文
    expect(contents).toContain('A-State')
    expect(contents).toContain('candidate_options')
    expect(contents).toContain('导出时加 UTF-8 BOM')
  })
})
