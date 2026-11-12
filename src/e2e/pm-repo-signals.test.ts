/**
 * issue #133 回放：默认分支已有修复提交 / 已有高度相似的关闭 issue 时，
 * PM 必须拿到证据并结构化拒收，而不是从头开发。
 *
 * 这里不调用真实模型：fake harness 从实际到达的 context 里读取 repo_signals，
 * 再按它看到的证据产出 PM 结论。断言的是「证据真的到达了 PM」与「拒收落库」。
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ok } from '../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../contracts/harness-adapter.js'
import type { IssueComment, IssueGateway } from '../contracts/issue-gateway.js'
import type { RepoSignals, RepoSignalsSource } from '../contracts/repo-signals.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import { drainIssueWriteback } from '../control/issue-writeback.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner, closePool } from '../fact/db.js'

const NOW = '2026-11-12T12:00:00Z'
const FIX_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const DUPLICATE_URL = 'https://github.com/acme/widget/issues/120'

type Rejection =
  | { readonly kind: 'already_fixed'; readonly sha: string }
  | { readonly kind: 'duplicate'; readonly url: string }

class EvidencePmAdapter implements HarnessAdapter {
  readonly calls: string[] = []
  private rejection: Rejection | null = null

  describe(): HarnessDescriptor {
    return {
      harness_id: 'evidence-pm',
      version: '0',
      tier: 'L0',
      capabilities: [],
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<{ ok: true; value: RunHandle }> {
    this.calls.push(spec.run.stage)
    const signals = spec.context.sections.find((section) => section.id === 'repo_signals')
    if (spec.run.stage === 'pm' && signals !== undefined) {
      const sha = /\b([a-f0-9]{12,40})\b/.exec(signals.content)?.[1]
      if (sha !== undefined && signals.content.includes('fix: 修正下拉数据源')) {
        this.rejection = { kind: 'already_fixed', sha }
      } else if (signals.content.includes(DUPLICATE_URL)) {
        this.rejection = { kind: 'duplicate', url: DUPLICATE_URL }
      }
    }
    return { ok: true, value: { run_id: spec.run.run_id, harness_id: 'evidence-pm' } }
  }

  async awaitResult(handle: RunHandle): Promise<{ ok: true; value: RunResult }> {
    const rejection = this.rejection
    const body =
      rejection === null
        ? {
            schema_version: '1.1',
            run_id: handle.run_id,
            stage: 'pm',
            verdict: 'actionable',
            reason: '没有足以拒收的证据',
            details: { needs_design: false },
          }
        : {
            schema_version: '1.1',
            run_id: handle.run_id,
            stage: 'pm',
            verdict: 'reject',
            reason:
              rejection.kind === 'already_fixed'
                ? '默认分支已有修复提交'
                : '已有高度相似的已关闭 issue',
            reject_kind: rejection.kind,
            evidence: [rejection.kind === 'already_fixed' ? rejection.sha : rejection.url],
          }
    return {
      ok: true,
      value: {
        status: 'SUCCEEDED',
        text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
        proposals: [],
        usage: {
          tokens_in: null,
          tokens_out: null,
          cost_usd: null,
          cost_basis: 'unavailable',
        },
        session_ref: null,
      },
    }
  }

  async collectChanges(): Promise<{ ok: true; value: WorkspaceDiff }> {
    return {
      ok: true,
      value: { files_changed: [], patch: null, commits: [], is_dirty: false },
    }
  }

  async interrupt(): Promise<{ ok: true; value: undefined }> {
    return { ok: true, value: undefined }
  }

  async dispose(): Promise<{ ok: true; value: DisposeReport }> {
    return {
      ok: true,
      value: { session_ref_retained: false, workspace_cleaned: false },
    }
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

async function seedTask(issueWriteback = 'off'): Promise<string> {
  const taskId = randomUUID()
  const repoId = randomUUID()
  const feedbackId = randomUUID()
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch, issue_writeback)
       VALUES ($1,'github','https://github.com/acme/widget.git','main',$2)`,
      [repoId, issueWriteback],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body)
       VALUES ($1,'github','acme/widget#133','导出 CSV 时下拉数据源为空，文件 src/ui/select.ts')`,
      [feedbackId],
    )
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW','下拉数据源错误',$2,'main','ai/t')`,
      [taskId, repoId],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
  })
  return taskId
}

function source(signals: RepoSignals): RepoSignalsSource {
  return { load: async () => ok(signals) }
}

function run(taskId: string, adapter: HarnessAdapter, repoSignals: RepoSignalsSource) {
  return runTaskToCompletion(
    taskId,
    {
      driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET)),
      sessions: new HarnessSessionManager(),
      adapter,
      workspace: { mode: 'fixed', path: '/tmp/fixed' },
      now: () => NOW,
      repoSignals,
    },
    { maxSteps: 3 },
  )
}

function baseSignals(over: Partial<RepoSignals> = {}): RepoSignals {
  return {
    commits: [],
    issues: [],
    pullRequests: [],
    referencedCommits: [],
    referencedPullRequests: [],
    ...over,
  }
}

describe('PM repo_signals 回放（issue #133）', () => {
  it('默认分支已有修复提交 → reject_kind=already_fixed，evidence 含该 SHA', async () => {
    const taskId = await seedTask()
    const adapter = new EvidencePmAdapter()
    const result = await run(
      taskId,
      adapter,
      source(
        baseSignals({
          commits: [
            {
              sha: FIX_SHA,
              title: 'fix: 修正下拉数据源为空 (#133)',
              committedAt: '2026-11-10T08:00:00Z',
              url: `https://github.com/acme/widget/commit/${FIX_SHA}`,
            },
          ],
          referencedCommits: [
            {
              sha: FIX_SHA,
              title: 'fix: 修正下拉数据源为空 (#133)',
              committedAt: '2026-11-10T08:00:00Z',
              url: `https://github.com/acme/widget/commit/${FIX_SHA}`,
            },
          ],
        }),
      ),
    )
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-REJECTED')
    expect(adapter.calls).toEqual(['pm'])

    const outcome = await asOwner((c) =>
      c.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM artifact
         WHERE task_id=$1 AND kind='stage_outcome' AND key='pm'
         ORDER BY version DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(outcome.rows[0]?.body).toMatchObject({
      verdict: 'reject',
      reject_kind: 'already_fixed',
      evidence: [FIX_SHA],
    })
  })

  it('已有高度相似的关闭 issue → reject_kind=duplicate，evidence 含 issue 链接', async () => {
    const taskId = await seedTask()
    const adapter = new EvidencePmAdapter()
    const result = await run(
      taskId,
      adapter,
      source(
        baseSignals({
          issues: [
            {
              number: 120,
              title: '下拉数据源错误',
              state: 'closed',
              url: DUPLICATE_URL,
              isPullRequest: false,
              merged: false,
            },
          ],
        }),
      ),
    )
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return
    expect(result.value.finalStatus).toBe('S-REJECTED')

    const outcome = await asOwner((c) =>
      c.query<{ body: Record<string, unknown> }>(
        `SELECT body FROM artifact
         WHERE task_id=$1 AND kind='stage_outcome' AND key='pm'
         ORDER BY version DESC LIMIT 1`,
        [taskId],
      ),
    )
    expect(outcome.rows[0]?.body).toMatchObject({
      verdict: 'reject',
      reject_kind: 'duplicate',
      evidence: [DUPLICATE_URL],
    })
  })

  it('comment_and_close 回写列出证据、提示可重开，并以 not_planned 关单', async () => {
    const taskId = await seedTask('comment_and_close')
    const adapter = new EvidencePmAdapter()
    const result = await run(
      taskId,
      adapter,
      source(
        baseSignals({
          commits: [
            {
              sha: FIX_SHA,
              title: 'fix: 修正下拉数据源为空 (#133)',
              committedAt: '2026-11-10T08:00:00Z',
              url: `https://github.com/acme/widget/commit/${FIX_SHA}`,
            },
          ],
        }),
      ),
    )
    expect(result.ok, result.ok ? '' : result.error.detail).toBe(true)
    if (!result.ok) return

    const comments: IssueComment[] = []
    const closed: { number: number; reason: 'completed' | 'not_planned' }[] = []
    const gateway: IssueGateway = {
      listIssueComments: async () => ok({ comments: [...comments], truncated: false }),
      issueActor: async () => ok('keel-bot'),
      createIssueComment: async (_remote, _number, body) => {
        const comment = { id: 100 + comments.length, body, author: 'keel-bot', createdAt: NOW }
        comments.push(comment)
        return ok(comment)
      },
      closeIssue: async (_remote, number, reason) => {
        closed.push({ number, reason })
        return ok(undefined)
      },
    }

    expect(await drainIssueWriteback(gateway, NOW)).toBe(1)
    expect(comments[0]?.body).toContain('already_fixed')
    expect(comments[0]?.body).toContain(FIX_SHA)
    expect(comments[0]?.body).toContain('如仍复现，请附截图后重开')
    expect(closed).toEqual([{ number: 133, reason: 'not_planned' }])
  })
})
