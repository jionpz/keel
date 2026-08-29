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
 *   3. `gh` CLI —— 用于创建/关闭验收用的 Issue(Keel 自己只读 Issue,
 *      建 Issue 是人的动作,不该进产品代码)。`gh()` 会把 `KEEL_GITHUB_TOKEN`
 *      注入 `GH_TOKEN`,避免 Cloud Agent 的 `ghs_` 凭据能 push 却不能打 label。
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
import { preflightGitHub, preflightOmp } from './preflight.js'

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
  // 起编排器之前把「跑不出结论」的前置一次性挡掉:PR 权限与 omp 都不具备时,
  // 这条链路只会烧十几分钟再落进一个**看起来像 AC6** 的终态。
  preflightOmp()
  await preflightGitHub(remote, token)
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
})

afterAll(closePool)

function gh(args: readonly string[]): string {
  const t = readTokenFromEnv()
  const env = t === undefined ? process.env : { ...process.env, GH_TOKEN: t, GITHUB_TOKEN: t }
  return execFileSync('gh', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
}

/** 从 PR URL 取编号 —— 断言与 cleanup 共用一份,不写第二遍 */
function prNumber(url: string): string {
  return url.split('/').at(-1) ?? ''
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
      // wallClockS=600:真实 rfc_draft 在 180s 默认墙上多次超时(2026-08-27),
      // 与 Policy/提示词无关;验收单独抬高,不改生产默认。
      const result = await runIssue({
        issueUrl,
        label: LABEL,
        ci: 'real',
        maxSteps: 30,
        wallClockS: 600,
      })
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

      // ── S-HUMAN_REVIEW 有两条来路,必须分开看 ──
      //
      // T-031(stage_retries_exhausted)也落 S-HUMAN_REVIEW,与 Policy 判高风险
      // **同一个终态**。若只看终态就早退,那么「omp 不存在 / 网关没 key /
      // 模型连续超时」这些**基础设施故障**会与 AC6 无法区分,测试照样判绿 ——
      // 正是本项目一路在避免的假绿(见 README.md「不是『不可用就跳过』」)。
      // 2026-08-27 第三次真实运行就是这一形态:用例绿,实际没跑出任何结论。
      if (transitions.at(-1) === 'T-031') {
        throw new Error(
          [
            '重试耗尽升人工(T-031)—— 这不是 AC6,是没跑出结论。',
            `走过的路径:${transitions.join(' → ')}`,
            '常见成因:omp 不可用 / 推理网关无 key / 模型连续超时。',
            '按诚实纪律:本次既不算 AC5 通过,也不算 AC6 证据。',
          ].join('\n'),
        )
      }

      // AC6:Policy 拦到 S-HUMAN_REVIEW 是设计内终点 —— 如实断言,不伪造成 S-DONE。
      // AC5 全自动到 PR 需要模型给出 low/low RFC;波动时本断言会红,按诚实纪律记录重跑。
      if (result.value.finalStatus === 'S-HUMAN_REVIEW') {
        console.log('走过的路径(AC6 人工闸门):', transitions.join(' → '))
        // 真正的 Policy 闸门必有一条 human_review 裁决 —— 否则不算 AC6 证据
        const policyHumanReview = evs.value.some(
          (e) =>
            e.type === 'PolicyEvaluated' &&
            (e.payload as { decision?: string }).decision === 'human_review',
        )
        expect(policyHumanReview, 'AC6 需要一条 human_review 的 PolicyEvaluated 作证').toBe(true)
        expect(prUrl, '人工闸门路径不应假装已建 PR').toBeNull()
        return
      }

      // ── AC5-1:走到 S-DONE ──
      expect(result.value.finalStatus).toBe('S-DONE')

      // ── AC5-2:真实 PR ──
      expect(prUrl, 'S-DONE 必须有真实 PR URL').not.toBeNull()
      expect(prUrl ?? '').toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/)
      if (prUrl === null) return

      // ── AC5-3:事件流终于 T-024(CI 通过)──
      expect(transitions.at(-1), '最后一条转移应是 T-024(CI 通过 → S-DONE)').toBe('T-024')

      // ── AC5-3b:T-024 得有真实 CI 作证,不能只有 Keel 自己的事件 ──
      //
      // 2026-08-28 第六次验收:用例判绿,但 T-024 是在建 PR 后 3.5 秒流出的 ——
      // 那时 Actions 还没启动(check-run 晚 5 秒才 started_at)。Keel 把
      // 「两个端点都还读不到」当成了 passed。判据要的是「通过 CI 的 PR」,
      // 所以这里回到 GitHub 核对一次:head SHA 上必须真有跑完且成功的 check。
      const headSha = gh([
        'pr',
        'view',
        prNumber(prUrl),
        '--repo',
        slug.value,
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]).trim()
      const checkRuns = JSON.parse(
        gh(['api', `/repos/${slug.value}/commits/${headSha}/check-runs`]),
      ) as { check_runs: { name: string; status: string; conclusion: string | null }[] }
      const completed = checkRuns.check_runs.filter((c) => c.status === 'completed')
      expect(
        completed.length,
        `head SHA ${headSha} 上没有任何跑完的 check —— T-024 无真实 CI 作证(假绿)`,
      ).toBeGreaterThan(0)
      expect(
        completed.every((c) => c.conclusion === 'success' || c.conclusion === 'skipped'),
        `真实 check 结论:${completed.map((c) => `${c.name}=${c.conclusion}`).join(', ')}`,
      ).toBe(true)

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
        try {
          gh(['pr', 'close', prNumber(prUrl), '--repo', slug.value])
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
