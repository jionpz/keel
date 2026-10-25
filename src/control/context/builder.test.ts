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

// ───────────── QA / Reviewer 必须看到 develop 的真实改动 ─────────────
//
// 旧配方是 ['role','rfc','state'] —— QA 没有任何 diff 可看，只能对着 RFC 空想，
// 它报的「仅改了一个文件」是猜的。diff section 让它看到 git 观测到的事实。

/** 给 task 铺一条 WorkspaceDiffCollected 事件 */
async function insertDiffEvent(
  taskId: string,
  stage: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const r = await asOwner((c) =>
    c.query<{ seq: string }>(
      `INSERT INTO event (task_id, type, payload)
       VALUES ($1,'WorkspaceDiffCollected',$2::jsonb) RETURNING seq`,
      [taskId, JSON.stringify({ stage, attempt: 1, collected: true, ...payload })],
    ),
  )
  return Number(r.rows[0]?.seq)
}

async function seedQaRun(taskId: string, runId: string): Promise<void> {
  await asOwner((c) =>
    c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,'qa','QA',1,'PENDING',$3)`,
      [runId, taskId, `${taskId}/qa/1`],
    ),
  )
}

describe('FactPlaneContextBuilder · QA 看到 develop 的真实 diff', () => {
  it('有 diff 事件 → section 出现，含文件清单与 patch，source_ref 指回 seq', async () => {
    const { taskId } = await seed()
    const runId = randomUUID()
    await seedQaRun(taskId, runId)
    const seq = await insertDiffEvent(taskId, 'develop', {
      files_changed: [{ path: 'README.md', change: 'modified' }],
      commits: ['abc123'],
      is_dirty: false,
      patch: 'diff --git a/README.md b/README.md\n+hello\n',
      patch_chars: 45,
      patch_truncated: false,
    })

    const r = await asOwner((c) =>
      ctxBuilder.build(c, {
        task_id: taskId,
        run_id: runId,
        role: 'QA',
        stage: 'qa',
        budget_tokens: 200_000,
      }),
    )
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return

    const section = r.value.sections.find((s) => s.id === 'diff')
    expect(section, 'QA 配方里必须有 diff').toBeDefined()
    expect(section?.priority).toBe('required')
    expect(section?.source_ref).toBe(`event:WorkspaceDiffCollected@${seq}`)
    expect(section?.content).toContain('README.md')
    expect(section?.content).toContain('abc123')
    expect(section?.content).toContain('+hello')
  })

  it('没有 develop 的 diff 事件 → section 缺席（不拿「无改动」冒充）', async () => {
    const { taskId } = await seed()
    const runId = randomUUID()
    await seedQaRun(taskId, runId)

    const r = await asOwner((c) =>
      ctxBuilder.build(c, {
        task_id: taskId,
        run_id: runId,
        role: 'QA',
        stage: 'qa',
        budget_tokens: 200_000,
      }),
    )
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.sections.find((s) => s.id === 'diff')).toBeUndefined()
  })

  it('只取 stage=develop 的那条 —— 后面的 pm 事件不得把它顶掉', async () => {
    const { taskId } = await seed()
    const runId = randomUUID()
    await seedQaRun(taskId, runId)
    await insertDiffEvent(taskId, 'develop', {
      files_changed: [{ path: 'src/a.ts', change: 'modified' }],
      commits: [],
      is_dirty: true,
      patch: null,
      patch_chars: 0,
      patch_truncated: false,
    })
    // 返工后 pm 又跑了一轮，写了一条更晚的（空）事件
    await insertDiffEvent(taskId, 'pm', {
      files_changed: [],
      commits: [],
      is_dirty: false,
      patch: null,
      patch_chars: 0,
      patch_truncated: false,
    })

    const r = await asOwner((c) =>
      ctxBuilder.build(c, {
        task_id: taskId,
        run_id: runId,
        role: 'QA',
        stage: 'qa',
        budget_tokens: 200_000,
      }),
    )
    if (!r.ok) return
    const section = r.value.sections.find((s) => s.id === 'diff')
    expect(section?.content).toContain('src/a.ts')
  })

  it('patch 被截断时如实标注，不假装给全了', async () => {
    const { taskId } = await seed()
    const runId = randomUUID()
    await seedQaRun(taskId, runId)
    await insertDiffEvent(taskId, 'develop', {
      files_changed: [{ path: 'big.ts', change: 'modified' }],
      commits: [],
      is_dirty: true,
      patch: '+x\n',
      patch_chars: 99_999,
      patch_truncated: true,
    })

    const r = await asOwner((c) =>
      ctxBuilder.build(c, {
        task_id: taskId,
        run_id: runId,
        role: 'QA',
        stage: 'qa',
        budget_tokens: 200_000,
      }),
    )
    if (!r.ok) return
    const section = r.value.sections.find((s) => s.id === 'diff')
    expect(section?.content).toContain('截断')
    expect(section?.content).toContain('99999')
  })
})
