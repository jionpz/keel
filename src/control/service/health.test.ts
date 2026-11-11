import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../../fact/db.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import {
  assertServiceSchema,
  REQUIRED_SERVICE_COMPONENTS,
  readServiceStatus,
  recordServiceHealth,
} from './health.js'

const NOW = '2026-11-11T00:00:00.000Z'
const LATER = '2026-11-11T00:01:00.000Z'
const HASH = 'a'.repeat(64)

async function clean(): Promise<void> {
  await asOwner(async (c) => {
    await c.query('DELETE FROM worker_health')
    await c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE')
  })
}

async function recordRequired(
  now = NOW,
  status: 'RUNNING' | 'DEGRADED' = 'RUNNING',
  skip?: (typeof REQUIRED_SERVICE_COMPONENTS)[number],
): Promise<void> {
  for (const component of REQUIRED_SERVICE_COMPONENTS) {
    if (component === skip) continue
    await recordServiceHealth({
      component,
      status,
      now,
      instanceId: randomUUID(),
      pid: 4242,
      checkpoint: { component },
      startedAt: NOW,
    })
  }
}

async function seedQueues(): Promise<void> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const questionId = randomUUID()
  const ticketId = randomUUID()
  const workflowId = randomUUID()
  const intentId = randomUUID()
  const outboxId = randomUUID()
  const packageDigest = sha256CanonicalJson({})

  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'local',$2,'main')`,
      [repoId, `file:///tmp/health-${repoId}`],
    )
    await c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [
      packageDigest,
      '{}',
    ])
    await c.query(
      `INSERT INTO managed_task(
        id,repo_id,package_digest,workspace_path,question,file_index,status,phase
      ) VALUES($1,$2,$3,'/tmp/health','health?','[]'::jsonb,'WAITING_HUMAN','investigate')`,
      [taskId, repoId, packageDigest],
    )
    await c.query(
      `INSERT INTO managed_question(id,task_id,question,options,status)
       VALUES($1,$2,'health?','["yes","no"]'::jsonb,'WAITING_HUMAN')`,
      [questionId, taskId],
    )
    await c.query(`UPDATE managed_task SET pending_question_id=$2 WHERE id=$1`, [
      taskId,
      questionId,
    ])
    await c.query(
      `INSERT INTO managed_ticket_task(
        id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,
        worktree_path,current_stage,status
      ) VALUES($1,$2,$3,'health-ticket','health ticket',$4,'/tmp/health-worktree',
               'execute','WAITING_HUMAN')`,
      [ticketId, repoId, packageDigest, 'a'.repeat(40)],
    )
    await c.query(
      `INSERT INTO managed_workflow(
        id,repo_id,package_digest,repo_config_digest,baseline_commit,worktree_root,
        request,scope_paths,completion_target,status
      ) VALUES($1,$2,$3,$4,$5,'/tmp/health-root','health workflow','["README.md"]'::jsonb,
               'branch_ready','READY')`,
      [workflowId, repoId, packageDigest, HASH, 'b'.repeat(40)],
    )
    await c.query(
      `INSERT INTO managed_action_intent(
        id,task_id,project_id,repo_id,action,remote_url,base_branch,head_branch,
        head_sha,diff_digest,environment,reversibility,affected_resources,
        pr_title,pr_body,idempotency_key
      ) VALUES($1,$2,$3,$3,'push_and_pr','file:///tmp/health.git','main','ai/health',
               $4,$5,'local','reversible','["health"]'::jsonb,'health','health',$6)`,
      [intentId, ticketId, repoId, 'c'.repeat(40), HASH, `intent-${intentId}`],
    )
    await c.query(
      `INSERT INTO managed_action_outbox(id,action_intent_id,status)
       VALUES($1,$2,'PENDING')`,
      [outboxId, intentId],
    )
    await c.query(
      `INSERT INTO managed_decision_request(
        id,revision,idempotency_key,project_id,repo_id,managed_task_id,managed_question_id,
        decision_key,kind,question,options,impact,action_category,input_digest,status
      ) VALUES($1,1,$2,$3,$3,$4,$5,'health.decision','clarification','health?',
               '[{"id":"yes","text":"yes"},{"id":"no","text":"no"}]'::jsonb,
               '{}'::jsonb,'read_only',$6,'OPEN')`,
      [randomUUID(), `decision-${questionId}`, repoId, taskId, questionId, HASH],
    )
  })
}

beforeEach(clean)
afterAll(closePool)

describe('service health', () => {
  it('必需角色齐全时返回 healthy，且健康查询不改变队列表和心跳', async () => {
    await recordRequired()
    const before = await asOwner((c) =>
      c.query<{ count: number }>('SELECT count(*)::int AS count FROM worker_health'),
    )
    const status = await readServiceStatus({ now: NOW, staleAfterMs: 30_000 })
    const after = await asOwner((c) =>
      c.query<{ count: number }>('SELECT count(*)::int AS count FROM worker_health'),
    )

    expect(status.state).toBe('healthy')
    expect(status.ok).toBe(true)
    expect(status.missing_components).toEqual([])
    expect(status.components).toHaveLength(REQUIRED_SERVICE_COMPONENTS.length)
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
    expect(status.pending).toEqual({
      questions: 0,
      decisions: 0,
      tickets: 0,
      workflows: 0,
      outbox: 0,
    })
  })

  it('缺失和 DEGRADED 角色都让状态变为 unhealthy，并暴露原因码', async () => {
    await recordRequired(NOW, 'RUNNING', 'checks')
    await recordServiceHealth({
      component: 'outbox',
      status: 'DEGRADED',
      now: NOW,
      reasonCode: 'AUTH_FAILED',
      detail: 'credential missing',
    })

    const status = await readServiceStatus({ now: NOW, staleAfterMs: 30_000 })
    expect(status.state).toBe('unhealthy')
    expect(status.ok).toBe(false)
    expect(status.missing_components).toEqual(['checks'])
    expect(
      status.components.find((component) => component.name === 'outbox')?.effective_status,
    ).toBe('DEGRADED')
    expect(status.components.find((component) => component.name === 'outbox')?.reason_code).toBe(
      'AUTH_FAILED',
    )
  })

  it('心跳超过阈值返回 STALE，而不是把失联说成健康', async () => {
    await recordRequired(NOW)
    const status = await readServiceStatus({ now: LATER, staleAfterMs: 5_000 })
    expect(status.state).toBe('unhealthy')
    expect(
      status.components.filter((component) => component.effective_status === 'STALE').length,
    ).toBe(REQUIRED_SERVICE_COMPONENTS.length)
  })

  it('显式关闭的 ingress 旧 STOPPED 行不会拖累必需角色健康', async () => {
    await recordRequired()
    await recordServiceHealth({
      component: 'ingress',
      status: 'STOPPED',
      now: NOW,
      checkpoint: {},
    })
    const status = await readServiceStatus({ now: NOW, staleAfterMs: 30_000 })
    expect(status.state).toBe('healthy')
    expect(status.components.some((component) => component.name === 'ingress')).toBe(true)
  })

  it('统计待答问题、ticket、workflow、decision 与 outbox 积压', async () => {
    await recordRequired()
    await seedQueues()

    const status = await readServiceStatus({ now: NOW, staleAfterMs: 30_000 })
    expect(status.pending.questions).toBe(1)
    expect(status.pending.decisions).toBe(1)
    expect(status.pending.tickets).toBe(1)
    expect(status.pending.workflows).toBe(1)
    expect(status.pending.outbox).toBe(1)
    expect(status.queues.tickets.WAITING_HUMAN).toBe(1)
    expect(status.recovery.awaiting_human).toBe(1)
    expect(status.recovery.awaiting_tianwen).toBe(0)
    expect(status.recovery.uncertain_actions).toBe(0)
    expect(status.state).toBe('healthy')
  })

  it('启动 schema 检查在 JT-06 迁移缺失时失败，且不写数据', async () => {
    await expect(assertServiceSchema()).resolves.toBeUndefined()
    const rows = await asOwner((c) =>
      c.query<{ count: number }>('SELECT count(*)::int AS count FROM worker_health'),
    )
    expect(rows.rows[0]?.count).toBe(0)
  })
})
