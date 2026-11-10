/**
 * 执行面模型路由 —— 落库值必须与实际 spawn 的模型同源（R5）。
 *
 * 这里用 stub adapter 记录它收到的 `RunSpec.model`，再回读
 * `run.requested_model` 比对：两处若各算一次，最终会出现「库里记 A、实际跑 B」，
 * 而两边单独看都自洽。stub 声明 `harness_id='omp'`，才会触达 stage 路由。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok, type Result } from '../../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import { HarnessSessionManager } from '../../execution/session/manager.js'
import { loadToolPolicy } from '../../execution/tool-policy.js'
import { asOwner, closePool } from '../../fact/db.js'
import type { Stage, TaskStatus } from '../../shared/ids.js'
import { WorkflowDriver } from '../driver/driver.js'
import { RuleBasedPolicyEngine } from '../policy/engine.js'
import { DEFAULT_RULESET } from '../policy/ruleset.js'
import { type OrchestratorDeps, runTaskToCompletion } from './loop.js'

const NOW = '2026-11-05T12:00:00Z'

/** 每个 stage 一个合法 verdict —— 让 run 能真的成功，而不是靠失败路径蒙混 */
const VERDICTS: Readonly<Record<Stage, string>> = {
  pm: 'actionable',
  brainstorm: 'converged',
  critic: 'reviewed',
  rfc_draft: 'drafted',
  develop: 'implemented',
  qa: 'pass',
  review: 'pass',
}

class RecordingAdapter implements HarnessAdapter {
  readonly specs: RunSpec[] = []
  constructor(
    private readonly harnessId: string,
    private readonly stage: Stage,
    private readonly toolInventory?: readonly string[],
  ) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: this.harnessId,
      version: '0',
      tier: 'L2',
      capabilities: ['CAP-HEADLESS', 'CAP-STREAM', 'CAP-MODEL_OVERRIDE'],
      ...(this.toolInventory === undefined ? {} : { tool_inventory: this.toolInventory }),
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    this.specs.push(spec)
    return ok({ run_id: spec.run.run_id, harness_id: this.harnessId })
  }

  async awaitResult(): Promise<Result<RunResult>> {
    return ok({
      status: 'SUCCEEDED',
      text: JSON.stringify({
        schema_version: '1.0',
        run_id: 'r',
        stage: this.stage,
        verdict: VERDICTS[this.stage],
        reason: '桩',
      }),
      proposals: [],
      usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
      session_ref: null,
    })
  }

  async collectChanges(): Promise<Result<WorkspaceDiff>> {
    return ok({
      files_changed: [{ path: 'README.md', change: 'modified' }],
      patch: '+x\n',
      commits: [],
      is_dirty: true,
    })
  }

  async interrupt(): Promise<Result<void>> {
    return ok(undefined)
  }

  async dispose(): Promise<Result<DisposeReport>> {
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}

function deps(adapter: HarnessAdapter, over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
    sessions: new HarnessSessionManager(),
    adapter,
    workspace: { mode: 'fixed', path: '/tmp/fixed' },
    now: () => NOW,
    ...over,
  }
}

beforeEach(async () => {
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(async () => {
  await closePool()
})

async function seed(stage: Stage, status: TaskStatus): Promise<{ taskId: string; runId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const runId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch)
       VALUES ($1,'local','file:///tmp/x','main')`,
      [repoId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,$2,'模型路由',$3,'main','ai/t')`,
      [taskId, status, repoId],
    )
    await c.query(
      `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
       VALUES ($1,$2,$3,'PM',1,'PENDING',$4)`,
      [runId, taskId, stage, `${taskId}/${stage}/1`],
    )
  })
  return { taskId, runId }
}

async function requestedModel(runId: string): Promise<string | null> {
  const r = await asOwner((c) =>
    c.query<{ requested_model: string | null }>('SELECT requested_model FROM run WHERE id=$1', [
      runId,
    ]),
  )
  return r.rows[0]?.requested_model ?? null
}

async function runErrorKind(runId: string): Promise<string | null> {
  const r = await asOwner((c) =>
    c.query<{ error_kind: string | null }>('SELECT error_kind FROM run WHERE id=$1', [runId]),
  )
  return r.rows[0]?.error_kind ?? null
}

describe('requested_model 与 spawn 的模型同源', () => {
  it('未设新变量：omp 仍 spawn deepseek-v4-flash，且落库一致（R1）', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('omp', 'develop')

    await runTaskToCompletion(taskId, deps(adapter), { maxSteps: 1 })

    expect(adapter.specs[0]?.model).toBe('deepseek-v4-flash')
    expect(await requestedModel(runId)).toBe(adapter.specs[0]?.model)
  })

  it('enterprise profile：develop → Kimi-K3，requested_model 同值（R2/R5）', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('omp', 'develop')

    await runTaskToCompletion(taskId, deps(adapter, { modelProfile: 'enterprise' }), {
      maxSteps: 1,
    })

    expect(adapter.specs[0]?.model).toBe('moonshotai/Kimi-K3')
    expect(await requestedModel(runId)).toBe('moonshotai/Kimi-K3')
  })

  it('enterprise profile：pm → GLM-5.3，且与 develop 不同', async () => {
    const dev = await seed('develop', 'S-DEVELOPING')
    const devAdapter = new RecordingAdapter('omp', 'develop')
    await runTaskToCompletion(dev.taskId, deps(devAdapter, { modelProfile: 'enterprise' }), {
      maxSteps: 1,
    })

    const pm = await seed('pm', 'S-PM_ANALYZING')
    const pmAdapter = new RecordingAdapter('omp', 'pm')
    await runTaskToCompletion(pm.taskId, deps(pmAdapter, { modelProfile: 'enterprise' }), {
      maxSteps: 1,
    })

    expect(pmAdapter.specs[0]?.model).toBe('zai-org/GLM-5.3')
    expect(await requestedModel(pm.runId)).toBe('zai-org/GLM-5.3')
    expect(devAdapter.specs[0]?.model).not.toBe(pmAdapter.specs[0]?.model)
  })

  it('显式 override 全阶段生效，压过 enterprise 表（R3）', async () => {
    const { taskId, runId } = await seed('pm', 'S-PM_ANALYZING')
    const adapter = new RecordingAdapter('omp', 'pm')

    await runTaskToCompletion(
      taskId,
      deps(adapter, { modelProfile: 'enterprise', modelOverride: 'custom/model' }),
      { maxSteps: 1 },
    )

    expect(adapter.specs[0]?.model).toBe('custom/model')
    expect(await requestedModel(runId)).toBe('custom/model')
  })

  it('allowlist 未命中 → 不 spawn，run FAILED 且 requested_model 保持 NULL（R6）', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('omp', 'develop')

    await runTaskToCompletion(taskId, deps(adapter, { modelAllowlist: ['moonshotai/Kimi-K3'] }), {
      maxSteps: 1,
    })

    expect(adapter.specs, '解析失败不得启动进程').toHaveLength(0)
    expect(await runErrorKind(runId)).toBe('CAPABILITY_UNSUPPORTED')
    expect(await requestedModel(runId)).toBeNull()
  })
})

describe('claude 行为不变（R7）', () => {
  it('未指定模型：RunSpec 不带 model，requested_model 为 NULL', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('claude', 'develop')

    await runTaskToCompletion(taskId, deps(adapter), { maxSteps: 1 })

    expect(adapter.specs[0]?.model).toBeUndefined()
    expect(await requestedModel(runId)).toBeNull()
  })

  it('显式模型：不走 profile 表，requested_model 记录显式值', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('claude', 'develop')

    await runTaskToCompletion(
      taskId,
      deps(adapter, { modelProfile: 'enterprise', modelOverride: 'claude-opus-4-6' }),
      { maxSteps: 1 },
    )

    // claude 的模型来自 adapter 构造参数，RunSpec.model 不参与
    expect(adapter.specs[0]?.model).toBeUndefined()
    expect(await requestedModel(runId)).toBe('claude-opus-4-6')
  })
})

describe('jstack 工具策略接线', () => {
  it('pi 没有工具策略时拒绝 spawn，不退回统一 read/write', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('pi', 'develop', ['read', 'write'])

    await runTaskToCompletion(taskId, deps(adapter), { maxSteps: 1 })

    expect(adapter.specs).toHaveLength(0)
    expect(await runErrorKind(runId)).toBe('CAPABILITY_UNSUPPORTED')
  })

  it('pi develop 使用 profile 的原生工具清单，而不是统一 read/write', async () => {
    const { taskId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('pi', 'develop', [
      'read',
      'grep',
      'find',
      'ls',
      'edit',
      'write',
      'bash',
      'Agent',
    ])
    const loaded = await loadToolPolicy(
      new URL('../../../config/jstack-tools.json', import.meta.url).pathname,
    )
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    await runTaskToCompletion(taskId, deps(adapter, { toolPolicy: loaded.value }), {
      maxSteps: 1,
    })

    expect(adapter.specs[0]?.permissions).toEqual({
      allowed_tools: ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'Agent'],
      mode: 'deny_unlisted',
    })
  })

  it('claude 缺必需原生工具时在 spawn 前失败，不静默降级', async () => {
    const { taskId, runId } = await seed('develop', 'S-DEVELOPING')
    const adapter = new RecordingAdapter('claude', 'develop', ['Read', 'Write'])
    const loaded = await loadToolPolicy(
      new URL('../../../config/jstack-tools.json', import.meta.url).pathname,
    )
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    await runTaskToCompletion(taskId, deps(adapter, { toolPolicy: loaded.value }), {
      maxSteps: 1,
    })

    expect(adapter.specs).toHaveLength(0)
    expect(await runErrorKind(runId)).toBe('CAPABILITY_UNSUPPORTED')
  })
})
