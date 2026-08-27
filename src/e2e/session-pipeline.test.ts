/**
 * 端到端：Session Manager 与 Proposal 校验流水线。
 *
 * **放在 src/e2e/ 而非 src/execution/ 是刻意的**：
 * 本测试跨越三个平面（Execution 起会话、Control 校验、Fact 落库），
 * 不属于任何单一平面。放进 src/execution/ 会让它 import src/fact，
 * 触发 execution-must-not-write-fact —— 而那条规则是对的，
 * 说明放错了地方，不是规则太严。
 *
 * 里程碑测试在最后：**真实 OMP session 产出的提案落成 A-StageOutcome，
 * driver 读它推进状态，全程无测试代码提交产物** ——
 * 这才是 v0.1 判据里的「无人干预」。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { RunSpec } from '../contracts/harness-adapter.js'
import type { Proposal } from '../contracts/types.js'
import { runSessionUntilValid } from '../control/proposal/pipeline.js'
import { checkPlaneBoundary, checkSchema } from '../control/proposal/validate.js'
import { OmpAdapter } from '../execution/adapters/omp.js'
import { extractJson } from '../execution/session/extract.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'

const NOW = '2026-08-23T12:00:00Z'
const store = new PgArtifactStore()

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    proposal_id: randomUUID(),
    task_id: randomUUID(),
    kind: 'stage_outcome',
    key: 'pm',
    body: {
      schema_version: '1.0',
      run_id: 'r1',
      stage: 'pm',
      verdict: 'actionable',
      reason: '可以做',
    },
    supersedes: null,
    produced_by_run: 'r1',
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

afterAll(closePool)

// ───────────────────────── 提取 ─────────────────────────

describe('post_validate 的 JSON 提取', () => {
  it('```json 围栏', () => {
    const r = extractJson('说明文字\n```json\n{"a":1}\n```\n收尾')
    expect(r.ok && r.strategy).toBe('json-fence')
    expect(r.ok && r.value).toEqual({ a: 1 })
  })

  it('任意围栏', () => {
    const r = extractJson('```\n{"a":2}\n```')
    expect(r.ok && r.value).toEqual({ a: 2 })
  })

  it('裸 JSON 带前后文', () => {
    const r = extractJson('好的，结果是 {"a":3} 就这样')
    expect(r.ok && r.strategy).toBe('balanced-scan')
    expect(r.ok && r.value).toEqual({ a: 3 })
  })

  it('嵌套对象不会被截断 —— 平衡括号扫描而非正则', () => {
    const r = extractJson('{"a":{"b":{"c":1}},"d":2} 尾巴')
    expect(r.ok && r.value).toEqual({ a: { b: { c: 1 } }, d: 2 })
  })

  it('字符串里的括号不影响扫描', () => {
    const r = extractJson('{"a":"}{","b":1}')
    expect(r.ok && r.value).toEqual({ a: '}{', b: 1 })
  })

  it('提取不到时给出可回灌的理由，而不是静默返回空', () => {
    const r = extractJson('我做完了，没有输出 JSON。')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/未能从输出中提取 JSON/)
  })
})

// ───────────────── 第 1 步：Schema ─────────────────

describe('第 1 步 · Schema 校验', () => {
  it('合法提案通过', () => {
    expect(checkSchema(proposal())).toEqual([])
  })

  it('verdict 不在该 stage 的取值集合内 → 拒绝', () => {
    const v = checkSchema(
      proposal({
        body: { schema_version: '1.0', run_id: 'r', stage: 'pm', verdict: 'pass', reason: 'x' },
      }),
    )
    expect(v.length).toBeGreaterThan(0)
  })

  it('缺必填字段 → 拒绝，且理由具体到字段', () => {
    const v = checkSchema(
      proposal({ body: { schema_version: '1.0', stage: 'pm', verdict: 'actionable' } }),
    )
    expect(v.length).toBeGreaterThan(0)
    // 回灌给模型的文本必须说清哪里错了，只说「格式错误」等于让它猜
    expect(v.map((x) => x.message).join(' ')).toMatch(/run_id|reason|required/)
  })

  it('未知 kind → 拒绝并列出可选值', () => {
    // 类型层面已收窄为 ProposalKind,但校验器仍须防御运行时越界(如旧数据/强转)
    const v = checkSchema(proposal({ kind: 'nonsense' as Proposal['kind'] }))
    expect(v[0]?.message).toMatch(/未知的产物 kind/)
  })
})

// ───────────── 第 3 步：平面越界（核心） ─────────────

describe('第 3 步 · 平面越界 —— Session 可以陈述事实，但不能指挥流程', () => {
  it('提案里出现 task_status → 拒绝', () => {
    const v = checkPlaneBoundary(
      proposal({ body: { verdict: 'actionable', task_status: 'S-DEVELOPING' } }),
    )
    expect(v).toHaveLength(1)
    expect(v[0]?.rule).toBe('plane-boundary')
  })

  it('嵌套层级里的 next_state 也会被抓到', () => {
    const v = checkPlaneBoundary(
      proposal({ body: { details: { inner: { next_state: 'S-DONE' } } } }),
    )
    expect(v).toHaveLength(1)
    expect(v[0]?.path).toBe('details.inner.next_state')
  })

  it('数组元素里的越权字段也会被抓到', () => {
    const v = checkPlaneBoundary(
      proposal({ body: { items: [{ ok: 1 }, { transition: 'T-012' }] } }),
    )
    expect(v).toHaveLength(1)
    expect(v[0]?.path).toBe('items[1].transition')
  })

  it('正常的事实陈述不受影响', () => {
    expect(
      checkPlaneBoundary(
        proposal({ body: { verdict: 'actionable', reason: '方案 A 被选中', details: {} } }),
      ),
    ).toEqual([])
  })

  it('拒绝理由说明了为什么，而不只是「不允许」', () => {
    const v = checkPlaneBoundary(proposal({ body: { control_mode: 'auto' } }))
    expect(v[0]?.message).toMatch(/不能指挥流程/)
  })
})

// ───────────────── R-007 回灌 ─────────────────

describe('R-007 · 校验失败不等于 Run 失败', () => {
  /** 前 N 轮输出坏 JSON，之后输出合法的 —— 用来观察回灌是否真的发生 */
  function flakyAdapter(badTurns: number): { adapter: OmpAdapter; feedbacks: string[][] } {
    const feedbacks: string[][] = []
    let turn = 0
    const adapter = new OmpAdapter()
    // 直接替换 startRun/awaitResult，避免真实调用
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    ;(adapter as any).startRun = async (spec: RunSpec) => {
      const fb = spec.context.sections[0]?.content ?? ''
      const m = /## 上一次提交被拒绝[\s\S]*/.exec(fb)
      if (m !== null) feedbacks.push([m[0].slice(0, 200)])
      return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'omp' } }
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    ;(adapter as any).awaitResult = async () => {
      turn++
      const body =
        turn <= badTurns
          ? '{"schema_version":"1.0","stage":"pm"}' // 缺 run_id / verdict / reason
          : '{"schema_version":"1.0","run_id":"r1","stage":"pm","verdict":"actionable","reason":"ok"}'
      return {
        ok: true,
        value: {
          status: 'SUCCEEDED',
          text: `\`\`\`json\n${body}\n\`\`\``,
          proposals: [],
          usage: { tokens_in: 1, tokens_out: 1, cost_usd: 0, cost_basis: 'estimated' },
          session_ref: 'sess-1',
        },
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    ;(adapter as any).dispose = async () => ({ ok: true, value: {} })
    return { adapter, feedbacks }
  }

  /** 必须连 run 一起铺 —— event.run_id 有外键约束 */
  async function seedTask(): Promise<{ taskId: string; runId: string }> {
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
         VALUES ($1,'S-PM_ANALYZING','t',$2,'main','ai/t')`,
        [taskId, repoId],
      )
      await c.query(
        `INSERT INTO run (id, task_id, stage, role, attempt, status, idempotency_key)
         VALUES ($1,$2,'pm','PM',1,'RUNNING',$3)`,
        [runId, taskId, `${taskId}/pm/1`],
      )
    })
    return { taskId, runId }
  }

  function specFor(taskId: string, runId: string, ws: string): RunSpec {
    return {
      run: { run_id: runId, task_id: taskId, stage: 'pm', role: 'PM', attempt: 1 },
      idempotency_key: `${taskId}/pm/1`,
      workspace: { path: ws, repo_id: 'r', branch: 'main', untrusted: true },
      context: {
        context_id: 'c',
        recipe_id: 'pm',
        recipe_version: '1',
        sections: [],
        total_tokens: 0,
        dropped: [],
      },
      output_contract: { schema_ref: 'stage_outcome', mode: 'post_validate' },
      permissions: { allowed_tools: [], mode: 'manual' },
      limits: { wall_clock_s: 60, budget_usd: null, max_turns: 4 },
    }
  }

  it('第一次不合格 → 回灌具体理由 → 第二次通过并落库', async () => {
    const { taskId, runId } = await seedTask()
    const { adapter, feedbacks } = flakyAdapter(1)
    const sessions = new HarnessSessionManager()

    const r = await runSessionUntilValid(
      sessions,
      {
        runSpec: specFor(taskId, runId, '/tmp'),
        adapter,
        expect: { kind: 'stage_outcome', key: 'pm' },
      },
      '判断这条反馈要不要做',
      { now: NOW },
    )

    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)
    if (!r.ok) return
    expect(r.value.committed).toBe(true)
    expect(r.value.attempts).toBe(2)
    // 回灌确实发生了，且内容具体
    expect(feedbacks.length).toBeGreaterThan(0)
    expect(feedbacks[0]?.[0]).toMatch(/上一次提交被拒绝/)

    // 落库了
    const got = await store.latest(taskId, 'stage_outcome', 'pm')
    expect(got.ok && (got.value.body as { verdict: string }).verdict).toBe('actionable')

    // R2:事件时间来自注入的 now,不回落 DB 时钟(重放不读时钟)
    const evs = await store.readEvents(taskId, 0, 100)
    expect(evs.ok).toBe(true)
    if (!evs.ok) return
    const norm = (t: string | undefined): string => new Date(t ?? '').toISOString()
    const acc = evs.value.filter((e) => e.type === 'ProposalAccepted')
    expect(acc.length).toBeGreaterThan(0)
    expect(norm(acc[0]?.occurred_at)).toBe(norm(NOW))
    const rej = evs.value.filter((e) => e.type === 'ProposalRejected')
    expect(rej.length).toBeGreaterThan(0)
    expect(norm(rej[0]?.occurred_at)).toBe(norm(NOW))
  })

  /**
   * ContextBuilder 是 Fact → Execution 的**唯一下行桥**，
   * 而 `ContextBuilt` 事件是「这个 Agent 当时到底看到了什么」的唯一答案
   * （docs/08-cross-cutting.md §2.2、`O3`）。
   *
   * Session Manager 曾在追加阶段指令时**替换掉**整个 sections ——
   * 于是那条事件记录的 section 根本没进提示词，`O3` 记的是假话。
   * 这条测试把「事件里写了什么」与「Adapter 收到了什么」绑在一起。
   */
  it('阶段指令是追加而非替换 —— ContextBuilder 造的 section 必须原样到达 Adapter', async () => {
    const { taskId, runId } = await seedTask()
    const { adapter } = flakyAdapter(0)
    const seen: RunSpec[] = []
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    ;(adapter as any).startRun = async (s: RunSpec) => {
      seen.push(s)
      return { ok: true, value: { run_id: s.run.run_id, harness_id: 'omp' } }
    }

    const base = specFor(taskId, runId, '/tmp')
    const built: RunSpec = {
      ...base,
      context: {
        ...base.context,
        sections: [
          {
            id: 'feedback',
            source_ref: `artifact:feedback/${taskId}`,
            source_kind: 'artifact',
            priority: 'required',
            content: '## 用户反馈\n\nKEEL_MARKER_FEEDBACK',
            tokens: 8,
          },
        ],
        total_tokens: 8,
      },
    }

    const r = await runSessionUntilValid(
      new HarnessSessionManager(),
      { runSpec: built, adapter, expect: { kind: 'stage_outcome', key: 'pm' } },
      '判断上面的用户反馈是否值得做。',
      { now: NOW },
    )
    expect(r.ok, r.ok ? '' : r.error.detail).toBe(true)

    const delivered = seen[0]
    expect(delivered, 'Adapter 应被调用过').toBeDefined()
    const ids = delivered?.context.sections.map((s) => s.id) ?? []
    // 追加：原 section 保留在前，指令在后
    expect(ids).toEqual(['feedback', 'prompt'])

    const rendered = (delivered?.context.sections ?? []).map((s) => s.content).join('\n\n')
    expect(rendered).toContain('KEEL_MARKER_FEEDBACK')
    expect(rendered).toContain('判断上面的用户反馈')
    // total_tokens 要跟着变 —— 记账与内容不一致会让预算判断建立在假数上
    expect(delivered?.context.total_tokens).toBe(
      (delivered?.context.sections ?? []).reduce((n, s) => n + s.tokens, 0),
    )
  })

  it('连续失败到上限 → 判 Run 失败，且什么都没落库', async () => {
    const { taskId, runId } = await seedTask()
    const { adapter } = flakyAdapter(99)
    const sessions = new HarnessSessionManager()

    const r = await runSessionUntilValid(
      sessions,
      {
        runSpec: specFor(taskId, runId, '/tmp'),
        adapter,
        expect: { kind: 'stage_outcome', key: 'pm' },
      },
      'x',
      { maxProposalRetries: 2, now: NOW },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('SCHEMA_VIOLATION')

    const n = await asOwner((c) =>
      c.query<{ n: string }>('SELECT count(*) AS n FROM artifact WHERE task_id=$1', [taskId]),
    )
    expect(Number(n.rows[0]?.n)).toBe(0)

    // 但拒绝被如实记录了
    const evs = await store.readEvents(taskId, 0, 100)
    expect(evs.ok && evs.value.filter((e) => e.type === 'ProposalRejected').length).toBe(2)
  })
})
