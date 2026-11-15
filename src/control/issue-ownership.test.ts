import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { asOwner, asRole, closePool } from '../fact/db.js'
import { WorkflowDriver } from './driver/driver.js'
import { claimIssue } from './managed/workflow-store.js'
import { RuleBasedPolicyEngine } from './policy/engine.js'
import { DEFAULT_RULESET } from './policy/ruleset.js'

const driver = new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET))

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo,feedback RESTART IDENTITY CASCADE'))
})
afterAll(closePool)

async function fixture() {
  const repoId = randomUUID()
  const feedbackId = randomUUID()
  const issueRef = 'acme/widget#42'
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch)
       VALUES($1,'github','https://github.com/acme/widget','main')`,
      [repoId],
    )
  })
  await asRole('keel_ingress', (c) =>
    c.query(
      `INSERT INTO feedback(id,source,external_ref,body)
       VALUES($1,'github',$2,'ownership fixture')`,
      [feedbackId, issueRef],
    ),
  )
  return {
    legacy: () =>
      driver.intake(
        { repoId, feedbackId, title: 'fixture', baseBranch: 'main' },
        new Date().toISOString(),
      ),
    managed: () =>
      asRole('keel_control', (c) =>
        claimIssue(c, {
          repo_id: repoId,
          issue_ref: issueRef,
          owner_kind: 'managed_workflow',
          owner_id: randomUUID(),
        }),
      ),
  }
}

describe('Issue 引擎所有权边界', () => {
  it('拒绝 legacy 抢占已经被 managed 认领的 issue', async () => {
    const operations = await fixture()
    expect((await operations.managed()).ok).toBe(true)
    const legacy = await operations.legacy()
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.error.kind).toBe('CONFLICT')
    const rows = await asOwner((c) => c.query('SELECT id FROM task'))
    expect(rows.rowCount).toBe(0)
  })

  it('拒绝 managed 抢占已进入 legacy 的 issue', async () => {
    const operations = await fixture()
    expect((await operations.legacy()).ok).toBe(true)
    const managed = await operations.managed()
    expect(managed.ok).toBe(false)
    if (!managed.ok) expect(managed.error.kind).toBe('CONFLICT')
  })

  it('两个引擎并发 intake 时只有一个获得所有权', async () => {
    const operations = await fixture()
    const results = await Promise.all([operations.legacy(), operations.managed()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)
    if (loser?.ok === false) expect(loser.error.kind).toBe('CONFLICT')
    const counts = await asOwner((c) =>
      c.query<{ owners: string }>(
        `SELECT (SELECT count(*) FROM task) +
          (SELECT count(*) FROM managed_issue_claim WHERE status='ACTIVE') AS owners`,
      ),
    )
    expect(counts.rows[0]?.owners).toBe('1')
  })
})
