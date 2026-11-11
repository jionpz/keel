import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, closePool } from '../../fact/db.js'
import { sha256CanonicalJson } from '../../shared/canonical-json.js'
import { claimActionOutbox } from '../managed/action-store.js'
import { claimManagedTicketTask } from '../managed/ticket-store.js'
import { claimManagedWorkflow } from '../managed/workflow-store.js'

const NOW = '2026-11-11T00:00:00.000Z'
const HASH = 'a'.repeat(64)

async function clean(): Promise<void> {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
}

async function seedProject(label: string): Promise<string> {
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'local',$2,'main')`,
      [repoId, `file:///tmp/fair-${label}-${repoId}`],
    ),
  )
  return repoId
}

beforeEach(clean)
afterAll(closePool)

describe('JT-06 fair scheduling', () => {
  it('ticket claim 按项目各取最久未推进的一条，不连续清空一个项目', async () => {
    const digest = sha256CanonicalJson({})
    const a = await seedProject('ticket-a')
    const b = await seedProject('ticket-b')
    const rows = [
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:01Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:02Z' },
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:03Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:04Z' },
    ]

    await asOwner(async (c) => {
      await c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [digest, '{}'])
      for (const [index, row] of rows.entries()) {
        await c.query(
          `INSERT INTO managed_ticket_task(
            id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,
            worktree_path,current_stage,status,updated_at
          ) VALUES($1,$2,$3,$4,$4,$5,$6,'execute','READY',$7)`,
          [
            row.id,
            row.repo,
            digest,
            `fair-ticket-${index + 1}`,
            'b'.repeat(40),
            `/tmp/fair-ticket-${index + 1}`,
            row.updated,
          ],
        )
      }
    })

    const claimed: string[] = []
    for (let index = 0; index < rows.length; index++) {
      const claim = await claimManagedTicketTask(NOW)
      expect(claim).not.toBeNull()
      if (claim !== null) claimed.push(claim.task.repo_id)
    }
    expect(claimed).toEqual([a, b, a, b])
  })

  it('workflow claim 按项目轮转 READY/ROUTING 工作', async () => {
    const digest = sha256CanonicalJson({})
    const a = await seedProject('workflow-a')
    const b = await seedProject('workflow-b')
    const rows = [
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:01Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:02Z' },
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:03Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:04Z' },
    ]

    await asOwner(async (c) => {
      await c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [digest, '{}'])
      for (const [index, row] of rows.entries()) {
        await c.query(
          `INSERT INTO managed_workflow(
            id,repo_id,package_digest,repo_config_digest,baseline_commit,worktree_root,
            request,scope_paths,completion_target,status,updated_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,'["src"]'::jsonb,'branch_ready','READY',$8)`,
          [
            row.id,
            row.repo,
            digest,
            HASH,
            'c'.repeat(40),
            `/tmp/fair-workflow-${index + 1}`,
            `fair workflow ${index + 1}`,
            row.updated,
          ],
        )
      }
    })

    const claimed: string[] = []
    for (let index = 0; index < rows.length; index++) {
      const claim = await claimManagedWorkflow(NOW)
      expect(claim).not.toBeNull()
      if (claim !== null) claimed.push(claim.workflow.repo_id)
    }
    expect(claimed).toEqual([a, b, a, b])
  })

  it('outbox claim 按项目轮转待发送动作', async () => {
    const digest = sha256CanonicalJson({})
    const a = await seedProject('outbox-a')
    const b = await seedProject('outbox-b')
    const rows = [
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:01Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:02Z' },
      { repo: a, id: randomUUID(), updated: '2026-11-10T00:00:03Z' },
      { repo: b, id: randomUUID(), updated: '2026-11-10T00:00:04Z' },
    ]

    await asOwner(async (c) => {
      await c.query('INSERT INTO managed_package(digest,body) VALUES($1,$2::jsonb)', [digest, '{}'])
      for (const [index, row] of rows.entries()) {
        const taskId = randomUUID()
        const intentId = randomUUID()
        const outboxId = randomUUID()
        await c.query(
          `INSERT INTO managed_ticket_task(
            id,repo_id,package_digest,ticket_id,ticket_title,baseline_commit,
            worktree_path,current_stage,status
          ) VALUES($1,$2,$3,$4,$4,$5,$6,'land','WAITING_GATEWAY')`,
          [
            taskId,
            row.repo,
            digest,
            `fair-outbox-${index + 1}`,
            'd'.repeat(40),
            `/tmp/fair-outbox-${index + 1}`,
          ],
        )
        await c.query(
          `INSERT INTO managed_action_intent(
            id,task_id,project_id,repo_id,action,remote_url,base_branch,head_branch,
            head_sha,diff_digest,environment,reversibility,affected_resources,
            pr_title,pr_body,idempotency_key
          ) VALUES($1,$2,$3,$3,'push_and_pr',$4,'main',$5,$6,$7,'local','reversible',
                   '["fair"]'::jsonb,'fair','fair',$8)`,
          [
            intentId,
            taskId,
            row.repo,
            `file:///tmp/fair-outbox-${index + 1}.git`,
            `ai/fair-outbox-${index + 1}`,
            'e'.repeat(40),
            digest,
            `fair-intent-${index + 1}`,
          ],
        )
        await c.query(
          `INSERT INTO managed_action_outbox(id,action_intent_id,status,created_at)
           VALUES($1,$2,'PENDING',$3)`,
          [outboxId, intentId, row.updated],
        )
      }
    })

    const claimed: string[] = []
    for (let index = 0; index < rows.length; index++) {
      const claim = await claimActionOutbox(NOW)
      expect(claim).not.toBeNull()
      if (claim !== null) claimed.push(claim.intent.project_id)
    }
    expect(claimed).toEqual([a, b, a, b])
  })
})
