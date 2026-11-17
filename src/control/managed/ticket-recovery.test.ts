import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { makeError } from '../../contracts/errors.js'
import type { ManagedTicketStageRunner } from '../../contracts/managed.js'
import { ZERO_USAGE } from '../../contracts/types.js'
import { asOwner, asRole, closePool } from '../../fact/db.js'
import type { ManagedTicketStageResult } from '../../generated/managed.js'
import { sha256Text } from '../../shared/canonical-json.js'
import {
  answerManagedTicketDecision,
  overrideManagedTicketDecision,
  readDecisionResolution,
  recordDelegationPolicy,
  revokeDelegationPolicy,
} from './decision-store.js'
import { pauseManagedTicket, resumeManagedTicket } from './ticket-control.js'
import {
  createManagedTicketTask,
  getManagedTicket,
  type ManagedTicketWorker,
  tickManagedTicket,
} from './ticket-runtime.js'
import { listManagedTicketStages } from './ticket-store.js'
import { fixtureTicketPackage } from './ticket-test-utils.js'

const run = promisify(execFile)
const tools = [
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write',
  'bash',
  'Agent',
  'web_search',
  'fetch_content',
]
const roots: string[] = []
const now = () => new Date().toISOString()

async function git(root: string, ...args: string[]) {
  return (
    await run('git', ['-C', root, ...args], {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
    })
  ).stdout.trim()
}

async function commit(root: string, body: string) {
  await writeFile(join(root, 'feature.txt'), body)
  await git(root, 'add', 'feature.txt')
  await git(root, 'commit', '-m', 'fixture implementation')
  return git(root, 'rev-parse', 'HEAD')
}

function result(extra: Partial<ManagedTicketStageResult> = {}): ManagedTicketStageResult {
  return {
    schema_version: '1.0',
    stage: 'execute',
    status: 'completed',
    summary: 'review fixture',
    ...extra,
  }
}

function worker(
  handler: (input: Parameters<ManagedTicketStageRunner>[0]) => Promise<ManagedTicketStageResult>,
): ManagedTicketWorker {
  return {
    harness: 'pi',
    toolInventory: tools,
    run: async (input) => ({
      ok: true,
      value: { output: await handler(input), usage: ZERO_USAGE },
    }),
  }
}

beforeEach(async () => {
  await asOwner((c) => c.query('TRUNCATE repo, managed_package RESTART IDENTITY CASCADE'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(closePool)

async function checkpoint(
  mode: 'human' | 'delegated' = 'human',
  beforeBlocked?: (root: string) => Promise<void>,
  action?: 'requested' | 'must-stop',
  commitCheckpoint = true,
) {
  const optionId = action === undefined ? 'option-1' : 'option-2'
  const base = await mkdtemp(join(tmpdir(), 'ticket-recovery-'))
  roots.push(base)
  const root = join(base, 'repo')
  await run('git', ['init', '-b', 'main', root])
  await git(root, 'config', 'user.name', 'Review Fixture')
  await git(root, 'config', 'user.email', 'fixture@example.test')
  await git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'fixture initial')
  await git(root, 'checkout', '-b', 'ai/review')
  const baseline = await git(root, 'rev-parse', 'HEAD')
  const repoId = randomUUID()
  await asOwner((c) =>
    c.query(
      `INSERT INTO repo(id,provider,remote_url,default_branch,local_path)
       VALUES($1,'local',$2,'main',$3)`,
      [repoId, `file://${root}`, root],
    ),
  )
  const pkg = fixtureTicketPackage()
  const packagePath = join(base, 'package.json')
  await writeFile(packagePath, JSON.stringify(pkg))
  const task = await createManagedTicketTask(repoId, packagePath, root)
  if (!task.ok) throw new Error(task.error.detail)
  const taskId = task.value
  const workflowId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO managed_workflow(id,repo_id,package_digest,repo_config_digest,baseline_commit,
       worktree_root,request,scope_paths,completion_target,status,current_graph_version)
       VALUES($1,$2,$3,$4,$5,$6,'review fixture','["feature.txt"]'::jsonb,'pr_ready','READY',1)`,
      [workflowId, repoId, pkg.content_digest, 'a'.repeat(64), baseline, root],
    )
    await c.query(
      `INSERT INTO managed_workflow_graph(workflow_id,version,plan_digest,plan)
       VALUES($1,1,$2,'{}'::jsonb)`,
      [workflowId, 'b'.repeat(64)],
    )
    await c.query(
      `INSERT INTO managed_workflow_node(id,workflow_id,graph_version,node_key,ticket_id,ticket_title,
       ticket_size,depends_on,scope_paths,acceptance,status,ticket_task_id)
       VALUES($1,$2,1,'review',$3,$4,'S','[]'::jsonb,'["feature.txt"]'::jsonb,
       '["fixture"]'::jsonb,'RUNNING',$5)`,
      [randomUUID(), workflowId, pkg.ticket.id, pkg.ticket.title, taskId],
    )
  })

  let head = baseline
  expect(
    await tickManagedTicket(
      {
        harness: 'pi',
        toolInventory: tools,
        run: async () => {
          if (commitCheckpoint) head = await commit(root, 'approved checkpoint\n')
          return {
            ok: false,
            error: makeError('RUN_TIMEOUT', 'fixture committed then timed out'),
            usage: ZERO_USAGE,
          }
        },
      },
      taskId,
    ),
  ).toMatchObject({ ok: true, value: { status: 'READY' } })

  const policyId = randomUUID()
  if (mode === 'delegated') {
    const time = now()
    expect(
      await recordDelegationPolicy({
        schema_version: '1.0',
        id: policyId,
        policy_id: 'review-checkpoint',
        version: 1,
        project_id: repoId,
        approved_by_owner: 'fixture-owner',
        approved_at: time,
        valid_from: time,
        rules: [
          {
            id: 'recover',
            decision_kinds: ['recovery'],
            actions: ['validation_environment_recovery'],
            resource_selectors: ['fixture'],
            environments: ['test'],
            reversibility: 'reversible',
            impact_limits: {
              environments: ['test'],
              reversibilities: ['reversible'],
              max_affected_resources: 1,
            },
            budget_limits: {},
            required_evidence: [],
            required_checks: [],
            mode: 'delegated',
            default_option_id: optionId,
          },
        ],
        created_at: time,
      }),
    ).toMatchObject({ ok: true })
  }

  const blocker = worker(async () => {
    if (beforeBlocked !== undefined) {
      await beforeBlocked(root)
      head = await git(root, 'rev-parse', 'HEAD')
    }
    return result({
      status: 'blocked',
      commit: head,
      worktree_head: head,
      ...(action === undefined
        ? {}
        : {
            requested_action: {
              action: action === 'must-stop' ? 'sudo fixture' : '修复测试夹具后重新验证',
              reason: 'fixture requested recovery action',
            },
          }),
      checks: [
        {
          command: 'fixture checkpoint check',
          exit_code: 0,
          passed: true,
          output_digest: sha256Text('fixture'),
          output_excerpt: 'fixture',
        },
      ],
      decision: {
        decision_key: 'review.recovery',
        kind: 'recovery',
        question: '保留 checkpoint 后继续验证？',
        options: ['继续验证', '停止'],
        action_category: 'validation_environment_recovery',
        impact: {
          environment: 'test',
          reversibility: 'reversible',
          affected_resources: ['fixture'],
        },
      },
    })
  })
  const blockedWorker: ManagedTicketWorker =
    mode === 'human'
      ? blocker
      : {
          ...blocker,
          decide: async () => ({
            ok: true,
            value: {
              usage: ZERO_USAGE,
              output: {
                recommendation: 'answer',
                answer_option_id: optionId,
                rationale: 'fixture exact delegation',
                basis_refs: [{ kind: 'delegation_policy', id: policyId, version: 1 }],
                assumptions: [],
                alternatives: [],
                unresolved_conflicts: [],
                missing_authority: [],
              },
            },
          }),
        }
  expect(await tickManagedTicket(blockedWorker, taskId)).toMatchObject({
    ok: true,
    value: { status: mode === 'human' ? 'WAITING_HUMAN' : 'READY' },
  })

  if (mode === 'delegated') {
    const resolved = await asRole('keel_control', (c) =>
      c.query('SELECT id FROM managed_decision_request WHERE managed_ticket_task_id=$1', [taskId]),
    )
    const requestId = resolved.rows[0]?.id
    if (typeof requestId !== 'string') throw new Error('missing delegated decision request')
    return { root, baseline, head, taskId, requestId, policyId }
  }

  const waiting = await getManagedTicket(taskId)
  if (!waiting.ok || !waiting.value.pending_decision_id || !waiting.value.pending_decision_revision)
    throw new Error('missing pending decision')
  const requestId = waiting.value.pending_decision_id
  const answered = await answerManagedTicketDecision(
    requestId,
    waiting.value.pending_decision_revision,
    optionId,
    now(),
  )
  expect(answered).toMatchObject({ ok: true, value: { taskStatus: 'READY' } })
  return { root, baseline, head, taskId, requestId, policyId }
}

it.each(['answer', 'override'] as const)(
  '人工明确批准请求动作后的恢复点可继续：%s',
  async (entrypoint) => {
    const fixture = await checkpoint('human', undefined, 'requested')
    const reason = '只修复测试夹具使用隔离临时目录，保持权限、沙箱与超时不变'
    if (entrypoint === 'override')
      expect(
        await overrideManagedTicketDecision(fixture.requestId, 2, 'option-2', reason, now()),
      ).toMatchObject({ ok: true, value: { taskStatus: 'READY' } })
    let ran = false
    const outcome = await tickManagedTicket(
      worker(async (input) => {
        ran = true
        expect(input.input_commit).toBe(fixture.head)
        if (entrypoint === 'override') {
          expect(input.human_decisions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ rationale: expect.stringContaining(reason) }),
            ]),
          )
          expect(JSON.stringify(input.context)).toContain(reason)
        }
        return result({ commit: fixture.head, worktree_head: fixture.head })
      }),
      fixture.taskId,
    )
    expect(outcome).toMatchObject({ ok: true, value: { status: 'READY' } })
    expect(ran).toBe(true)
    if (entrypoint === 'override') {
      const resolution = await readDecisionResolution(fixture.requestId, 3)
      expect(resolution).not.toBeNull()
      const event = await asOwner((c) =>
        c.query(
          `SELECT payload FROM managed_ticket_event
           WHERE task_id=$1 AND type='ManagedTicketDecisionRecovery'`,
          [fixture.taskId],
        ),
      )
      expect(event.rows[0]?.payload).toMatchObject({
        requestId: fixture.requestId,
        requestRevision: 3,
        resolutionId: resolution?.id,
        contextDigest: resolution?.context_digest,
      })
    }
  },
)

it('委托决定不能接纳请求动作后的恢复点', async () => {
  const fixture = await checkpoint('delegated', undefined, 'requested')
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran).toBe(false)
})

it('无改动恢复点按精确人工批准启动', async () => {
  const fixture = await checkpoint('human', undefined, 'requested', false)
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async (input) => {
      ran = true
      expect(input.input_commit).toBe(fixture.baseline)
      expect(input.context).toMatchObject({
        decision_recovery: {
          decisionRequestId: fixture.requestId,
          decisionRequestRevision: 2,
          changedFiles: [],
        },
      })
      const head = await commit(fixture.root, 'post-approval implementation\n')
      return result({ commit: head, worktree_head: head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'READY' } })
  expect(ran).toBe(true)
  const resolution = await readDecisionResolution(fixture.requestId, 2)
  expect(resolution).not.toBeNull()
  const event = await asOwner((c) =>
    c.query(
      `SELECT payload FROM managed_ticket_event
       WHERE task_id=$1 AND type='ManagedTicketDecisionRecovery'`,
      [fixture.taskId],
    ),
  )
  expect(event.rows[0]?.payload).toMatchObject({
    requestId: fixture.requestId,
    requestRevision: 2,
    resolutionId: resolution?.id,
    contextDigest: resolution?.context_digest,
  })
})

it('无改动恢复点在暂停并恢复后不能复用旧批准', async () => {
  const fixture = await checkpoint('human', undefined, 'requested', false)
  expect(
    await pauseManagedTicket(fixture.taskId, 'revoke old requested-action approval', now()),
  ).toMatchObject({ ok: true })
  expect(await resumeManagedTicket(fixture.taskId, now())).toMatchObject({ ok: true })

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.baseline, worktree_head: fixture.baseline })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '控制代次变化后，无改动恢复也不能复用旧批准').toBe(false)
})

it('无改动恢复点在决议过期后不能启动', async () => {
  const fixture = await checkpoint('human', undefined, 'requested', false)
  await asOwner((c) =>
    c.query('UPDATE managed_decision_request SET expires_at=$2 WHERE id=$1', [
      fixture.requestId,
      '2000-01-01T00:00:00.000Z',
    ]),
  )

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.baseline, worktree_head: fixture.baseline })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '过期决定不能授权无改动恢复').toBe(false)
})

it('无改动恢复点仍拒绝委托批准', async () => {
  const fixture = await checkpoint('delegated', undefined, 'requested', false)
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.baseline, worktree_head: fixture.baseline })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '请求动作的恢复通道不能接受委托').toBe(false)
})

it.each(['descendant', 'dirty', 'index-hidden'] as const)(
  '无改动恢复批准后拒绝现场漂移：%s',
  async (kind) => {
    const fixture = await checkpoint('human', undefined, 'requested', false)
    if (kind === 'descendant') await commit(fixture.root, 'unapproved descendant\n')
    if (kind === 'dirty') await writeFile(join(fixture.root, 'feature.txt'), 'unapproved WIP\n')
    if (kind === 'index-hidden') {
      await git(fixture.root, 'update-index', '--assume-unchanged', 'README.md')
      await writeFile(join(fixture.root, 'README.md'), 'hidden unapproved WIP\n')
    }

    let ran = false
    const outcome = await tickManagedTicket(
      worker(async () => {
        ran = true
        return result({ commit: fixture.baseline, worktree_head: fixture.baseline })
      }),
      fixture.taskId,
    )
    expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
    expect(ran, '批准后出现的现场变化不能借用无改动恢复点').toBe(false)
  },
)

it('无改动恢复必须产生新的实现提交', async () => {
  const fixture = await checkpoint('human', undefined, 'requested', false)
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.baseline, worktree_head: fixture.baseline })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran).toBe(true)
})

it.each(['HARNESS_UNAVAILABLE', 'PROTOCOL_ERROR', 'RUN_TIMEOUT'] as const)(
  '请求动作的一次批准在执行失败 %s 后不能复用',
  async (kind) => {
    const fixture = await checkpoint('human', undefined, 'requested')
    expect(
      await tickManagedTicket(
        {
          harness: 'pi',
          toolInventory: tools,
          run: async () => ({
            ok: false,
            error: makeError(kind, 'fixture attempted approved action then failed'),
            usage: ZERO_USAGE,
          }),
        },
        fixture.taskId,
      ),
    ).toMatchObject({ ok: true, value: { status: 'READY' } })
    let ran = false
    const outcome = await tickManagedTicket(
      worker(async () => {
        ran = true
        return result({ commit: fixture.head, worktree_head: fixture.head })
      }),
      fixture.taskId,
    )
    expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
    expect(ran, '未知动作结果不能隐式重用一次批准').toBe(false)
  },
)

it('人工决定不能将 MUST_STOP 纳入普通恢复通道', async () => {
  const fixture = await checkpoint('human', undefined, 'must-stop')
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran).toBe(false)
})

it.each(['HARNESS_UNAVAILABLE', 'PROTOCOL_ERROR'] as const)(
  '临时错误 %s 未改变恢复点时仍可重试',
  async (kind) => {
    const fixture = await checkpoint()
    const first = await tickManagedTicket(
      {
        harness: 'pi',
        toolInventory: tools,
        run: async () => ({
          ok: false,
          error: makeError(kind, 'fixture transient failure before writes'),
          usage: ZERO_USAGE,
        }),
      },
      fixture.taskId,
    )
    expect(first).toMatchObject({ ok: true, value: { status: 'READY' } })

    let ran = false
    const second = await tickManagedTicket(
      worker(async () => {
        ran = true
        return result({ commit: fixture.head, worktree_head: fixture.head })
      }),
      fixture.taskId,
    )
    expect(second).toMatchObject({ ok: true, value: { status: 'READY' } })
    expect(ran, '恢复点未变化时，临时错误后必须允许重试').toBe(true)
  },
)

it('暂停并恢复后的控制代次使旧恢复决定失效', async () => {
  const fixture = await checkpoint()
  expect(
    await pauseManagedTicket(fixture.taskId, 'revoke old recovery authorization', now()),
  ).toMatchObject({ ok: true })
  expect(await resumeManagedTicket(fixture.taskId, now())).toMatchObject({ ok: true })

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '控制代次变化后，旧恢复决定不能再次授权').toBe(false)
})

it('恢复续跑超时后不能回退并丢弃已批准的提交', async () => {
  const fixture = await checkpoint()
  expect(
    await tickManagedTicket(
      {
        harness: 'pi',
        toolInventory: tools,
        run: async () => ({
          ok: false,
          error: makeError('RUN_TIMEOUT', 'fixture timeout without Git writes'),
          usage: ZERO_USAGE,
        }),
      },
      fixture.taskId,
    ),
  ).toMatchObject({ ok: true, value: { status: 'READY' } })
  await git(fixture.root, 'reset', '--hard', fixture.baseline)
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      const replacement = await commit(fixture.root, 'discarded approved checkpoint\n')
      return result({ commit: replacement, worktree_head: replacement })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '超时不能授权丢弃已批准的 checkpoint').toBe(false)
})

it('无改动决定恢复后的超时提交进入 timeout recovery', async () => {
  const fixture = await checkpoint('human', undefined, undefined, false)
  let timedOutHead = fixture.baseline
  expect(
    await tickManagedTicket(
      {
        harness: 'pi',
        toolInventory: tools,
        run: async () => {
          timedOutHead = await commit(fixture.root, 'implementation before timeout\n')
          return {
            ok: false,
            error: makeError('RUN_TIMEOUT', 'fixture committed after decision then timed out'),
            usage: ZERO_USAGE,
          }
        },
      },
      fixture.taskId,
    ),
  ).toMatchObject({ ok: true, value: { status: 'READY' } })

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async (input) => {
      ran = true
      expect(input.input_commit).toBe(timedOutHead)
      return result({ commit: timedOutHead, worktree_head: timedOutHead })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'READY' } })
  expect(ran).toBe(true)
})

it.each([false, true])('恢复续跑超时后保留原提交或其后代可以继续：新增提交=%s', async (advance) => {
  const fixture = await checkpoint()
  let head = fixture.head
  expect(
    await tickManagedTicket(
      {
        harness: 'pi',
        toolInventory: tools,
        run: async () => {
          if (advance) head = await commit(fixture.root, 'approved checkpoint plus timeout work\n')
          return {
            ok: false,
            error: makeError('RUN_TIMEOUT', 'fixture timeout retaining approved checkpoint'),
            usage: ZERO_USAGE,
          }
        },
      },
      fixture.taskId,
    ),
  ).toMatchObject({ ok: true, value: { status: 'READY' } })
  let ran = false
  const outcome = await tickManagedTicket(
    worker(async (input) => {
      ran = true
      expect(input.input_commit).toBe(head)
      return result({ commit: head, worktree_head: head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'READY' } })
  expect(ran).toBe(true)
  expect(await getManagedTicket(fixture.taskId)).toMatchObject({
    ok: true,
    value: { current_stage: 'verify' },
  })
})

it.each(['feature.txt', 'README.md'] as const)(
  'index 隐藏 %s 的真实修改时拒绝恢复',
  async (path) => {
    const fixture = await checkpoint()
    await git(fixture.root, 'update-index', '--assume-unchanged', path)
    await writeFile(join(fixture.root, path), 'unapproved hidden WIP\n')

    let ran = false
    const outcome = await tickManagedTicket(
      worker(async () => {
        ran = true
        return result({ commit: fixture.head, worktree_head: fixture.head })
      }),
      fixture.taskId,
    )
    expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
    expect(ran, '现场内容与获准 checkpoint 不同时必须拒绝恢复').toBe(false)
  },
)

it('撤销委托策略后拒绝启动恢复', async () => {
  const fixture = await checkpoint('delegated')
  const authority = await asRole('keel_control', (c) =>
    c.query(
      `SELECT disposition,delegation_policy_id,validity_conditions FROM managed_decision_resolution
       WHERE request_id=$1`,
      [fixture.requestId],
    ),
  )
  expect(authority.rows[0]).toMatchObject({
    disposition: 'delegated',
    delegation_policy_id: fixture.policyId,
  })
  expect(
    await revokeDelegationPolicy(
      fixture.policyId,
      'fixture-owner',
      'revoke before recovery starts',
      now(),
    ),
  ).toMatchObject({ ok: true })
  const policy = await asRole('keel_control', (c) =>
    c.query('SELECT revoked_at IS NOT NULL AS revoked FROM managed_delegation_policy WHERE id=$1', [
      fixture.policyId,
    ]),
  )
  expect(policy.rows[0]).toMatchObject({ revoked: true })

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, '委托策略撤销后不能启动恢复').toBe(false)
})

it('前置空格的路径不属于声明的 scope', async () => {
  const fixture = await checkpoint('human', async (root) => {
    await writeFile(join(root, ' feature.txt'), 'out of scope committed file\n')
    await git(root, 'add', ' feature.txt')
    await git(root, 'commit', '-m', 'fixture outside scope')
  })

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran, 'scope=feature.txt 不能匹配前置空格的另一个文件').toBe(false)
})

it('其他任务的决议不能授权当前任务恢复', async () => {
  const fixture = await checkpoint()
  const foreign = await checkpoint()
  await asRole('keel_control', (c) =>
    c.query(
      `UPDATE managed_ticket_task
       SET handoff=(SELECT handoff FROM managed_ticket_task WHERE id=$2)
       WHERE id=$1`,
      [fixture.taskId, foreign.taskId],
    ),
  )

  let ran = false
  const outcome = await tickManagedTicket(
    worker(async () => {
      ran = true
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )
  expect(outcome).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect(ran).toBe(false)
})

it('MUST_STOP 检查不能复用为正式 verify 证据', async () => {
  const fixture = await checkpoint()
  expect(
    await tickManagedTicket(
      worker(async () => result({ commit: fixture.head, worktree_head: fixture.head })),
      fixture.taskId,
    ),
  ).toMatchObject({ ok: true, value: { status: 'READY' } })
  expect(await getManagedTicket(fixture.taskId)).toMatchObject({
    ok: true,
    value: { current_stage: 'verify' },
  })

  let verifyRan = false
  const verified = await tickManagedTicket(
    worker(async (input) => {
      verifyRan = true
      expect(input.stage).toBe('verify')
      return result({
        stage: 'verify',
        worktree_head: fixture.head,
        checks: [
          {
            command: 'fixture formal verification',
            exit_code: 1,
            passed: false,
            output_digest: sha256Text('fail'),
            output_excerpt: 'fail',
          },
        ],
      })
    }),
    fixture.taskId,
  )
  expect(verifyRan).toBe(true)
  expect(verified).toMatchObject({ ok: true, value: { status: 'PAUSED' } })
  expect((await listManagedTicketStages(fixture.taskId)).map((stage) => stage.status)).toEqual([
    'FAILED',
    'MUST_STOP',
    'SUCCEEDED',
    'FAILED',
  ])
  const reused = await asRole('keel_control', (c) =>
    c.query(
      `SELECT * FROM managed_ticket_event
       WHERE task_id=$1 AND type='ManagedTicketEvidenceReused'`,
      [fixture.taskId],
    ),
  )
  expect(reused.rowCount).toBe(0)
})

it('有效委托策略下恢复点可以正常续跑', async () => {
  const fixture = await checkpoint('delegated')
  let ran = false
  const recovered = await tickManagedTicket(
    worker(async (input) => {
      ran = true
      expect(input.input_commit).toBe(fixture.head)
      return result({ commit: fixture.head, worktree_head: fixture.head })
    }),
    fixture.taskId,
  )

  expect(recovered).toMatchObject({
    ok: true,
    value: { status: 'READY', stage: 'execute' },
  })
  expect(ran, '有效委托策略必须允许恢复点继续执行').toBe(true)
  expect(await getManagedTicket(fixture.taskId)).toMatchObject({
    ok: true,
    value: { current_stage: 'verify' },
  })
  const recoveries = await asRole('keel_control', (c) =>
    c.query(
      `SELECT * FROM managed_ticket_event
       WHERE task_id=$1 AND type='ManagedTicketDecisionRecovery'`,
      [fixture.taskId],
    ),
  )
  expect(recoveries.rowCount).toBe(1)
})
