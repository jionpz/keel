/**
 * Claude Code harness：Issue → S-DONE 真实验收（opt-in，不进默认 check）。
 *
 * 对标 `issue-e2e.acceptance.test.ts`，差别只有执行层是 `ClaudeCodeAdapter`。
 * Control / Fact 契约不变 —— 这是 ADR-0005「Harness 可替换」的验收。
 *
 * 前置：`claude` 在 PATH、`ANTHROPIC_API_KEY`（`--bare` 不读 OAuth）、
 * `KEEL_GITHUB_TOKEN`、`KEEL_TEST_REMOTE_REPO`、已登录的 `gh`。
 * 缺任一则明确失败，**不 skip**。
 *
 * 运行：
 *   export ANTHROPIC_API_KEY=...
 *   export KEEL_GITHUB_TOKEN="$(gh auth token)"
 *   export KEEL_TEST_REMOTE_REPO=https://github.com/<owner>/<repo>
 *   pnpm vitest run --config vitest.acceptance.config.ts src/acceptance/claude-code-e2e.acceptance.test.ts
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { registerRepoMain } from '../cli/register-repo.js'
import { runIssue } from '../cli/run-issue.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { ownerRepo, readTokenFromEnv } from '../fact/github-provider.js'
import {
  cleanupAcceptanceRun,
  createLabeledIssue,
  KEEL_LABEL,
  verifyCiOnPr,
} from './gh-issue-helpers.js'
import { preflightClaude, preflightGitHub } from './preflight.js'

const store = new PgArtifactStore()

const token: string | undefined = readTokenFromEnv()
const remote = process.env.KEEL_TEST_REMOTE_REPO

const LABEL = KEEL_LABEL
const ISSUE_BODY = [
  '目标:只改 README.md 一处文档,补一句「导出支持按日期筛选」。',
  '约束(必须遵守,写进 RFC.policy_facts):',
  '- risk=low',
  '- complexity=low',
  '- estimated_files=1',
  '- security_sensitive=false',
  '- 禁止改任何 .ts/.sql/.json 代码;禁止新建文件',
  '这是验收探针,不是架构变更。',
].join('\n')

beforeEach(async () => {
  if (token === undefined) {
    throw new Error(
      '缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN。设置方式:`export KEEL_GITHUB_TOKEN="$(gh auth token)"`',
    )
  }
  if (remote === undefined || remote === '') {
    throw new Error(
      '缺少 KEEL_TEST_REMOTE_REPO,例如:`export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel`',
    )
  }
  preflightClaude()
  await preflightGitHub(remote, token)
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

describe('Claude Code · Issue → S-DONE 全真实闭环', () => {
  it('runIssue harness=claude --ci real 从真实 Issue 走到 S-DONE', {
    timeout: 1_800_000,
  }, async () => {
    if (remote === undefined) throw new Error('缺少 KEEL_TEST_REMOTE_REPO')
    const slug = ownerRepo(remote)
    expect(slug.ok, slug.ok ? '' : `解析 owner/repo 失败:${slug.error.detail}`).toBe(true)
    if (!slug.ok) return

    const stamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)

    await registerRepoMain([remote])

    const issueUrl = await createLabeledIssue(
      slug.value,
      `[keel-claude] 文档补充 ${stamp}`,
      ISSUE_BODY,
    )
    const issueNumber = issueUrl.split('/').at(-1) ?? ''

    let taskId: string | undefined
    let prUrl: string | null = null
    try {
      const result = await runIssue({
        issueUrl,
        label: LABEL,
        ci: 'real',
        maxSteps: 30,
        wallClockS: 600,
        harness: 'claude',
      })
      expect(result.ok, result.ok ? '' : `run-issue 失败:${result.error.detail}`).toBe(true)
      if (!result.ok) return
      taskId = result.value.taskId
      prUrl = result.value.prUrl

      expect(result.value.created, '首次 ingest 应新建 task').toBe(true)

      const evs = await store.readEvents(taskId, 0, 2000)
      expect(evs.ok).toBe(true)
      if (!evs.ok) return
      const transitions = evs.value
        .filter((e) => e.type === 'TaskStatusChanged')
        .map((e) => (e.payload as { transition: string }).transition)
      expect(transitions[0], '第一条转移应是 T-001(Issue → S-NEW)').toBe('T-001')

      const fbEarly = await asOwner((c) =>
        c.query<{ source: string; external_ref: string }>(
          'SELECT source, external_ref FROM feedback WHERE id = $1',
          [result.value.feedbackId],
        ),
      )
      expect(fbEarly.rows[0]?.source).toBe('github')
      expect(fbEarly.rows[0]?.external_ref).toBe(`${slug.value}#${issueNumber}`)

      if (transitions.at(-1) === 'T-031') {
        throw new Error(
          [
            '重试耗尽升人工(T-031)—— 这不是 AC6,是没跑出结论。',
            `走过的路径:${transitions.join(' → ')}`,
            '常见成因:claude 不可用 / 缺 ANTHROPIC_API_KEY / 模型连续超时。',
            '按诚实纪律:本次既不算 AC5 通过,也不算 AC6 证据。',
          ].join('\n'),
        )
      }

      if (result.value.finalStatus === 'S-HUMAN_REVIEW') {
        console.log('走过的路径(AC6 人工闸门):', transitions.join(' → '))
        const policyHumanReview = evs.value.some(
          (e) =>
            e.type === 'PolicyEvaluated' &&
            (e.payload as { decision?: string }).decision === 'human_review',
        )
        expect(policyHumanReview, 'AC6 需要一条 human_review 的 PolicyEvaluated 作证').toBe(true)
        expect(prUrl, '人工闸门路径不应假装已建 PR').toBeNull()
        return
      }

      expect(result.value.finalStatus).toBe('S-DONE')
      expect(prUrl, 'S-DONE 必须有真实 PR URL').not.toBeNull()
      expect(prUrl ?? '').toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/)
      if (prUrl === null) return

      expect(transitions.at(-1), '最后一条转移应是 T-024(CI 通过 → S-DONE)').toBe('T-024')
      verifyCiOnPr(slug.value, prUrl)

      const prEvent = evs.value.find(
        (e) =>
          (e.type === 'SideEffectApplied' || e.type === 'SideEffectSkipped') &&
          (e.payload as { kind?: string }).kind === 'CreatePullRequest',
      )
      expect(prEvent, 'CreatePullRequest 必须落 Applied/Skipped 而非 Intent').toBeDefined()
      expect(
        evs.value.some(
          (e) =>
            e.type === 'SideEffectIntent' &&
            (e.payload as { kind?: string }).kind === 'CreatePullRequest',
        ),
        '真实模式下不应出现 CreatePullRequest 的 Intent',
      ).toBe(false)

      console.log('\n走过的路径(AC5):', transitions.join(' → '))
      console.log('PR:', prUrl)
    } finally {
      cleanupAcceptanceRun({
        remote,
        slug: slug.value,
        taskId,
        prUrl,
        issueNumber,
      })
    }
  })
})
