import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { listenTestServer } from '../test-support/http-server.js'
import { createConsoleHandler } from './console.js'

const token = 'console-database-test-token'
let taskId: string

beforeEach(async () => {
  taskId = randomUUID()
  await asOwner(async (client) => {
    await client.query('TRUNCATE repo CASCADE')
    const repoId = randomUUID()
    await client.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/console-db','main')`,
      [repoId],
    )
    await client.query(
      `INSERT INTO task (id, title, status, repo_id, base_branch, work_branch)
       VALUES ($1,'真实数据库面板验收','S-NEW',$2,'main','ai/console-db')`,
      [taskId, repoId],
    )
  })
})

afterAll(closePool)

async function withConsole(
  use: (api: (path: string, body?: unknown) => Promise<Response>) => Promise<void>,
) {
  const handler = createConsoleHandler({
    query: (sql, params) =>
      asRole('keel_control', async (client) => (await client.query(sql, [...params])).rows),
    auth: { password: 'console-database-test-password' },
    token,
  })
  const server = createServer((request, response) => {
    handler(request, response).catch(() => response.destroy())
  })
  const { baseUrl: base, fetch, close } = await listenTestServer(server)
  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-keel-console': token },
      body: JSON.stringify({ password: 'console-database-test-password' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    await use((path, body) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-keel-console': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  } finally {
    await close()
  }
}

describe('控制台真实 PostgreSQL 与 HTTP', () => {
  it('工作流列表与详情读取当前图的 ticket、决策、执行次数和当前轮次进展', async () => {
    const workflowId = randomUUID()
    const ticketId = randomUUID()
    const waitingTicketId = randomUUID()
    const decisionId = randomUUID()
    const stageIds = [randomUUID(), randomUUID(), randomUUID()]
    const packageDigest = 'a'.repeat(64)
    await asOwner(async (client) => {
      const repo = await client.query<{ repo_id: string }>('SELECT repo_id FROM task WHERE id=$1', [
        taskId,
      ])
      const repoId = repo.rows[0]?.repo_id
      await client.query(
        `INSERT INTO managed_package (digest,body) VALUES ($1,'{}') ON CONFLICT DO NOTHING`,
        [packageDigest],
      )
      await client.query(
        `INSERT INTO managed_workflow
         (id,repo_id,package_digest,repo_config_digest,baseline_commit,worktree_root,
          request,scope_paths,completion_target,status,current_graph_version,updated_at)
         VALUES ($1,$2,$3,$3,'abcdef1','/tmp/console','托管进展','["src"]',
                 'branch_ready','READY',2,'2026-11-13T01:00:00Z')`,
        [workflowId, repoId, packageDigest],
      )
      for (const version of [1, 2]) {
        await client.query(
          `INSERT INTO managed_workflow_graph (workflow_id,version,plan_digest,plan)
           VALUES ($1,$2,$3,'{}')`,
          [workflowId, version, packageDigest],
        )
      }
      for (const [id, status, stage] of [
        [ticketId, 'RUNNING', 'verify'],
        [waitingTicketId, 'WAITING_HUMAN', 'execute'],
      ]) {
        await client.query(
          `INSERT INTO managed_ticket_task
           (id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,
            worktree_path,current_stage,status,updated_at,last_error)
           VALUES ($1::uuid,$2,$3,$1::text,'执行测试','abcdef1','/tmp/ticket',$4,$5,
                   '2026-11-13T02:00:00Z','等待核验')`,
          [id, repoId, packageDigest, stage, status],
        )
      }
      for (const [key, version, id] of [
        ['old', 1, null],
        ['running', 2, ticketId],
        ['waiting', 2, waitingTicketId],
      ]) {
        await client.query(
          `INSERT INTO managed_workflow_node
           (id,workflow_id,graph_version,node_key,ticket_id,ticket_title,ticket_size,
            depends_on,scope_paths,acceptance,status,ticket_task_id,updated_at)
           VALUES ($1,$2,$3,$4,$4,'测试节点','S','[]','["src"]','["通过"]',
                   'WAITING_HUMAN',$5,'2026-11-13T01:00:00Z')`,
          [randomUUID(), workflowId, version, key, id],
        )
      }
      for (const [index, id] of stageIds.entries()) {
        await client.query(
          `INSERT INTO managed_ticket_stage
           (id,task_id,stage,attempt,status,package_digest,baseline_commit,input_commit,
            input_digest,started_at,ended_at)
           VALUES ($1,$2,$3,$4,$5,$6,'abcdef1','abcdef1',$6,$7,$8)`,
          [
            id,
            ticketId,
            index === 2 ? 'verify' : 'execute',
            index + 1,
            index === 2 ? 'RUNNING' : 'SUCCEEDED',
            packageDigest,
            `2026-11-13T02:0${index}:00Z`,
            index === 2 ? null : `2026-11-13T02:0${index}:30Z`,
          ],
        )
      }
      await client.query(
        `INSERT INTO managed_decision_request
         (id,revision,idempotency_key,project_id,repo_id,managed_ticket_task_id,
          decision_key,kind,question,options,impact,action_category,input_digest,status,updated_at)
         VALUES ($1::uuid,1,$1::text,$2,$2,$3,'console-check','recovery','是否继续执行',
                 '[{"id":"continue"},{"id":"stop"}]','{}','local',$4,'PROCESSING',
                 '2026-11-13T03:00:00Z')`,
        [decisionId, repoId, waitingTicketId, packageDigest],
      )
      await client.query(
        `UPDATE managed_ticket_task SET pending_decision_id=$2,pending_decision_revision=1 WHERE id=$1`,
        [waitingTicketId, decisionId],
      )
      // 后写入旧 stage 的事件不能盖掉当前轮次的进展。
      for (const [stageId, observedAt] of [
        [stageIds[2], '2026-11-13T02:10:00Z'],
        [stageIds[0], '2026-11-13T02:11:00Z'],
      ]) {
        await client.query(
          `INSERT INTO managed_ticket_event (task_id,type,payload,occurred_at)
           VALUES ($1,'ManagedTicketProgress',$2::jsonb,$3)`,
          [
            ticketId,
            JSON.stringify({ stageId, stage: 'verify', kind: 'output', observedAt }),
            observedAt,
          ],
        )
      }
    })
    await withConsole(async (api) => {
      const list = await api('/api/workflows')
      expect(list.status).toBe(200)
      const body = (await list.json()) as { workflows: Record<string, unknown>[] }
      expect(body.workflows).toHaveLength(1)
      const workflow = body.workflows[0]
      expect(workflow).toMatchObject({
        status: 'READY',
        repo: 'file:///tmp/console-db',
        repo_provider: 'local',
        node_count: 2,
        run_count: 3,
        waiting_human: 0,
      })
      const tickets = workflow?.tickets as Record<string, unknown>[]
      expect(tickets.find((ticket) => ticket.ticket_task_id === ticketId)).toMatchObject({
        ticket_status: 'RUNNING',
        current_stage: 'verify',
        run_count: 3,
        stage_status: 'RUNNING',
        last_progress_at: '2026-11-13T02:10:00Z',
        ticket_error: '等待核验',
      })
      expect(tickets.find((ticket) => ticket.ticket_task_id === waitingTicketId)).toMatchObject({
        decision_status: 'PROCESSING',
        decision_question: '是否继续执行',
        run_count: 0,
        last_progress_at: null,
      })
      const detail = await api(`/api/workflows/${workflowId}`)
      expect(detail.status).toBe(200)
      expect(((await detail.json()) as { nodes: unknown[] }).nodes).toEqual(tickets)
      await asOwner(async (client) => {
        await client.query(
          `UPDATE managed_decision_request SET status='WAITING_HUMAN',updated_at='2026-11-13T04:00:00Z'
           WHERE id=$1`,
          [decisionId],
        )
        await client.query(`UPDATE managed_ticket_task SET status='PAUSED' WHERE id=$1`, [ticketId])
      })
      const after = (await (await api('/api/workflows')).json()) as typeof body
      expect(after.workflows[0]).toMatchObject({ waiting_human: 1, run_count: 3 })
      const afterWorkflow = after.workflows[0]
      if (afterWorkflow === undefined) throw new Error('缺少 workflow')
      const paused = (afterWorkflow.tickets as typeof tickets).find(
        (ticket) => ticket.ticket_task_id === ticketId,
      )
      expect(paused?.last_progress_at).toBeNull()
      expect(Date.parse(String(after.workflows[0]?.activity_at))).toBe(
        Date.parse('2026-11-13T04:00:00Z'),
      )
    })
  })

  it('仅 RUNNING 轮次关联遥测，空遥测和非运行轮次返回 null', async () => {
    const runIds = [randomUUID(), randomUUID(), randomUUID()]
    await asOwner(async (client) => {
      for (const [index, status] of ['RUNNING', 'SUCCEEDED', 'PENDING'].entries()) {
        await client.query(
          `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
           VALUES ($1,$2,'pm','PM',$3,$4,$5)`,
          [runIds[index], taskId, index + 1, status, `${taskId}/pm/${index + 1}`],
        )
        await client.query(
          `INSERT INTO run_liveness (run_id, last_progress_at, silence_ms, owner_heartbeat_at)
           VALUES ($1,'2026-11-12T08:00:00Z',300000,'2026-11-12T08:00:01Z')`,
          [runIds[index]],
        )
      }
    })
    await withConsole(async (api) => {
      const response = await api(`/api/tasks/${taskId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        runs: {
          status: string
          liveness: {
            last_progress_at: string
            silence_threshold_ms: number
            owner_heartbeat_at: string
          } | null
        }[]
      }
      const live = body.runs.find((run) => run.status === 'RUNNING')?.liveness
      expect(live?.silence_threshold_ms).toBe(300000)
      expect(Date.parse(live?.last_progress_at ?? '')).toBe(Date.parse('2026-11-12T08:00:00Z'))
      expect(Date.parse(live?.owner_heartbeat_at ?? '')).toBe(Date.parse('2026-11-12T08:00:01Z'))
      expect(body.runs.find((run) => run.status === 'SUCCEEDED')?.liveness).toBeNull()
      expect(body.runs.find((run) => run.status === 'PENDING')?.liveness).toBeNull()
      await asOwner((client) =>
        client.query('DELETE FROM run_liveness WHERE run_id=$1', [runIds[0]]),
      )
      const missing = (await (await api(`/api/tasks/${taskId}`)).json()) as typeof body
      expect(missing.runs.find((run) => run.status === 'RUNNING')?.liveness).toBeNull()
    })
  })

  it('真实写入口完成暂停、恢复、接管、带 A-State 交还，过期请求返回 409', async () => {
    await withConsole(async (api) => {
      const path = `/api/tasks/${taskId}/control`
      expect((await api(path, { action: 'pause', expected_mode: 'auto' })).status).toBe(200)
      expect((await api(path, { action: 'takeover', expected_mode: 'auto' })).status).toBe(409)
      expect((await api(path, { action: 'resume', expected_mode: 'paused' })).status).toBe(200)
      expect((await api(path, { action: 'takeover', expected_mode: 'auto' })).status).toBe(200)
      expect((await api(path, { action: 'resume', expected_mode: 'human' })).status).toBe(409)
      expect(
        (
          await api(path, {
            action: 'resume',
            expected_mode: 'human',
            note: '人工核对，无阶段完成。',
          })
        ).status,
      ).toBe(200)
      const detail = (await (await api(`/api/tasks/${taskId}`)).json()) as {
        task: { status: string; control_mode: string }
        artifacts: { kind: string; body: { confirmed_facts: { text: string }[] } }[]
        events: { type: string }[]
      }
      expect(detail.task).toMatchObject({ status: 'S-NEW', control_mode: 'auto' })
      expect(detail.artifacts[0]?.body.confirmed_facts[0]?.text).toBe('人工核对，无阶段完成。')
      expect(detail.events.filter((event) => event.type === 'ControlModeChanged')).toHaveLength(4)
    })
  })
})
