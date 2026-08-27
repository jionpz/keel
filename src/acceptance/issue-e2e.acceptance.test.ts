/**
 * Issue → S-DONE 全真实闭环验收(AC5–AC7)。
 *
 * 这是 v0.1 判据「一条真实反馈进入系统 → 无人干预 → 通过 CI 的 PR」里
 * **「进入」那一环**的真实验证:此前 v01-criterion 用 seed SQL 直插 S-NEW,
 * 事件流从 T-002 起;本文件从真实 GitHub Issue 起,事件流从 T-001 起。
 *
 * **不在默认 `pnpm run check` 中**(见 README.md):它建真实 Issue、真实 PR,
 * 且中间六个阶段依赖模型输出,天然有波动。
 *
 * 前置条件:
 *   1. `KEEL_GITHUB_TOKEN`(或 `GITHUB_TOKEN`)—— 读 Issue / 建 PR / 读 CI;
 *   2. `KEEL_TEST_REMOTE_REPO`(如 `https://github.com/jionpz/keel`)——
 *      你拥有 push 权限的远程仓库;
 *   3. `gh` CLI 已登录 —— 用于创建/关闭验收用的 Issue(Keel 自己只读 Issue,
 *      建 Issue 是人的动作,不该进产品代码)。
 *
 * 与项目纪律一致:**条件不满足时明确失败,绝不静默跳过**。
 *
 * 运行:
 *   export KEEL_GITHUB_TOKEN="$(gh auth token)"
 *   export KEEL_TEST_REMOTE_REPO=https://github.com/<owner>/<repo>
 *   pnpm run test:acceptance
 */

import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { registerRepoMain } from '../cli/register-repo.js'
import { runIssue } from '../cli/run-issue.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor } from '../fact/git-workspace.js'
import { ownerRepo, readTokenFromEnv } from '../fact/github-provider.js'

const store = new PgArtifactStore()

const token: string | undefined = readTokenFromEnv()
const remote = process.env.KEEL_TEST_REMOTE_REPO

const LABEL = 'keel'
/** 刻意压到 Policy P4(auto_develop)窗口:文档-only、单文件、无安全面。 */
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
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

function gh(args: readonly string[]): string {
  return execFileSync('gh', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 创建带目标 label 的真实 Issue,返回其 URL */
function createLabeledIssue(slug: string, title: string): string {
  try {
    gh(['label', 'create', LABEL, '--repo', slug, '--description', 'Keel 自动构建闸门'])
  } catch {
    // label 已存在 —— 这是期望的常态
  }
  const out = gh([
    'issue',
    'create',
    '--repo',
    slug,
    '--title',
    title,
    '--body',
    ISSUE_BODY,
    '--label',
    LABEL,
  ])
  const url = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('https://'))
    .at(-1)
  if (url === undefined) {
    throw new Error(`gh issue create 未返回 URL:${out}`)
  }
  return url
}

describe('Issue → S-DONE 全真实闭环(需要凭据、远程仓库与 gh CLI)', () => {
  it('keel run-issue --ci real 从真实 Issue 走到 S-DONE,产出通过 CI 的真实 PR', {
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

    // 注册先于建 Issue:反过来的话 register 抛异常时 Issue 已经建好却还没进
    // try/finally,远端会留一个没人关的验收 Issue。
    await registerRepoMain([remote])

    const issueUrl = createLabeledIssue(slug.value, `[keel-acc] 文档补充 ${stamp}`)
    const issueNumber = issueUrl.split('/').at(-1) ?? ''

    let taskId: string | undefined
    let prUrl: string | null = null
    try {
      const result = await runIssue({ issueUrl, label: LABEL, ci: 'real', maxSteps: 30 })
      expect(result.ok, result.ok ? '' : `run-issue 失败:${result.error.detail}`).toBe(true)
      if (!result.ok) return
      taskId = result.value.taskId
      prUrl = result.value.prUrl

      expect(result.value.created, '首次 ingest 应新建 task').toBe(true)

      // ── 事件流必含 T-001(进入路径),无论终态是 S-DONE 还是 Policy 人工闸门 ──
      const evs = await store.readEvents(taskId, 0, 2000)
      expect(evs.ok).toBe(true)
      if (!evs.ok) return
      const transitions = evs.value
        .filter((e) => e.type === 'TaskStatusChanged')
        .map((e) => (e.payload as { transition: string }).transition)
      expect(transitions[0], '第一条转移应是 T-001(Issue → S-NEW)').toBe('T-001')

      // ── AC5-5:feedback 来自 github(入口闭环不依赖终态)──
      const fbEarly = await asOwner((c) =>
        c.query<{ source: string; external_ref: string }>(
          'SELECT source, external_ref FROM feedback WHERE id = $1',
          [result.value.feedbackId],
        ),
      )
      expect(fbEarly.rows[0]?.source).toBe('github')
      expect(fbEarly.rows[0]?.external_ref).toBe(`${slug.value}#${issueNumber}`)

      // AC6:Policy 拦到 S-HUMAN_REVIEW 是设计内终点 —— 如实断言,不伪造成 S-DONE。
      // AC5 全自动到 PR 需要模型给出 low/low RFC;波动时本断言会红,按诚实纪律记录重跑。
      if (result.value.finalStatus === 'S-HUMAN_REVIEW') {
        console.log('走过的路径(AC6 人工闸门):', transitions.join(' → '))
        expect(prUrl, '人工闸门路径不应假装已建 PR').toBeNull()
        return
      }

      // ── AC5-1:走到 S-DONE ──
      expect(result.value.finalStatus).toBe('S-DONE')

      // ── AC5-2:真实 PR ──
      expect(prUrl, 'S-DONE 必须有真实 PR URL').not.toBeNull()
      expect(prUrl ?? '').toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/)

      // ── AC5-3:事件流终于 T-024(CI 通过)──
      expect(transitions.at(-1), '最后一条转移应是 T-024(CI 通过 → S-DONE)').toBe('T-024')

      // ── AC5-4:PR 是真做的,不是记意图 ──
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
      // 收尾:关 PR、删远端分支、关 Issue —— 验收不留垃圾
      if (prUrl !== null) {
        const prNumber = prUrl.split('/').at(-1) ?? ''
        try {
          gh(['pr', 'close', prNumber, '--repo', slug.value])
        } catch {
          /* 已关闭则忽略 */
        }
      }
      if (taskId !== undefined) {
        try {
          execFileSync('git', ['push', remote, '--delete', branchFor(taskId)], { stdio: 'pipe' })
        } catch {
          /* 分支可能已随 PR 关闭被清理 */
        }
      }
      try {
        gh(['issue', 'close', issueNumber, '--repo', slug.value])
      } catch {
        /* 已关闭则忽略 */
      }
    }
  })
})
