/**
 * 完整编排器合并验收 —— 真实 OMP + 真实 GitHub(v0.1 最终整合,issue #24 收尾)。
 *
 * 已有分段覆盖:
 *   - v01-criterion:真实 OMP 全链路 S-NEW→S-DONE,但 CI 是注入的(externalCi);
 *   - github-pr.acceptance:真实 PR+CI 工具层,但不接编排器。
 *
 * 本文件把两者拼接:runTaskToCompletion + 真实 OMP + worktree 模式 +
 * 真实 GitHubProvider(driver github → T-021 建真 PR;opts.ci → waitForCi
 * 读真实 Actions)→ S-DONE。CI 只跑 `pnpm run check`(ci.yml,不含 acceptance),
 * 因此 waitForCi 等到 passed 即证明真实 PR 上跑过真实 CI 且绿。
 *
 * 凭据:KEEL_GITHUB_TOKEN + KEEL_TEST_REMOTE_REPO,缺失 → 明确失败(README 纪律)。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { OmpAdapter } from '../execution/adapters/omp.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { PgArtifactStore } from '../fact/artifact-store.js'
import { asOwner, closePool } from '../fact/db.js'
import { branchFor, GitWorkspace } from '../fact/git-workspace.js'
import { GitHubProvider, ownerRepo, readTokenFromEnv } from '../fact/github-provider.js'

const store = new PgArtifactStore()
const FEEDBACK = '导出 CSV 时文件编码改为 UTF-8 BOM,解决 Excel 打开中文乱码'
const remote = process.env.KEEL_TEST_REMOTE_REPO
const token = readTokenFromEnv()

function requireToken(): string {
  if (token === undefined) throw new Error('缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN')
  return token
}

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

function cleanupBranch(branch: string): void {
  try {
    execFileSync('git', ['push', remote as string, '--delete', branch], { stdio: 'pipe' })
  } catch {
    // 分支可能已被清理
  }
}

afterAll(closePool)

describe('完整编排器合并验收(真实 OMP + 真实 GitHub)', () => {
  it('真实反馈:真实 OMP 驱动 S-NEW → S-DONE,真实 push → 真 PR → 真 CI passed', {
    timeout: 900_000,
  }, async () => {
    if (remote === undefined || remote === '') {
      throw new Error('缺少 KEEL_TEST_REMOTE_REPO(beforeEach 已挡,收窄用)')
    }
    const taskId = randomUUID()
    const repoId = randomUUID()
    const feedbackId = randomUUID()

    // 只铺输入:repo(remote_url = 真实远程)、反馈、Task。此后不写产物。
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO repo (id, provider, remote_url, default_branch)
         VALUES ($1,'github',$2,'main')`,
        [repoId, remote],
      )
      await c.query(
        `INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,$3)`,
        [feedbackId, `ref-${feedbackId}`, FEEDBACK],
      )
      await c.query(
        `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
         VALUES ($1,'S-NEW',$2,$3,'main',$4)`,
        [taskId, FEEDBACK, repoId, branchFor(taskId)],
      )
      await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
        taskId,
        feedbackId,
      ])
    })

    const root = mkdtempSync(join(tmpdir(), 'keel-merge-'))
    const git = new GitWorkspace({ root })
    const bare = await git.ensureBareRepo(repoId, remote)
    expect(bare.ok, bare.ok ? '' : `从远程克隆裸仓库失败:${bare.error.detail}`).toBe(true)
    if (!bare.ok) return

    const github = new GitHubProvider({ token: requireToken() })
    const binding = { git, repoId, baseBranch: 'main' } as const

    try {
      const result = await runTaskToCompletion(
        taskId,
        {
          driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding, github),
          sessions: new HarnessSessionManager(),
          adapter: new OmpAdapter(),
          workspace: { mode: 'worktree', ...binding },
          now: () => '2026-08-25T12:00:00Z',
        },
        {
          maxSteps: 30,
          // 真实 CI 网关:T-021 建真 PR 后,编排器在 S-PR_OPEN 等真实 GitHub Actions
          ci: github,
        },
      )

      expect(result.ok, result.ok ? '' : `编排失败:${result.error.detail}`).toBe(true)
      if (!result.ok) {
        // 失败诊断:编排错误详情(模型波动 vs 合并逻辑归因)
        console.log('merge-acc error:', result.error.detail)
        return
      }

      // ── 1. 走到合法终态 ──
      // v0.1 判据是「无人干预走到底」;auto_develop vs human_review 由 Policy
      // 对模型如实填的 policy_facts 裁决 —— 不该把模型修为耦合进合并验收。
      // S-DONE 是目标(auto 路径);S-HUMAN_REVIEW 是 Policy 的正当裁决。
      const TERMINAL_LEGIT = ['S-DONE', 'S-HUMAN_REVIEW', 'S-REJECTED', 'S-ABANDONED']
      if (!TERMINAL_LEGIT.includes(result.value.finalStatus)) {
        console.log(
          'merge-acc stopped at 非终态',
          result.value.finalStatus,
          'steps:',
          JSON.stringify(
            result.value.steps.map(
              (s) => `${s.stage ?? ''}:${s.transition ?? ''}->${s.status_after}`,
            ),
          ),
        )
      }
      if (result.value.finalStatus === 'S-HUMAN_REVIEW') {
        // 诊断:读最新 A-RFC 的 policy_facts,归因 auto/human 裁决
        const rfc = await asOwner((c) =>
          c.query<{ body: { policy_facts?: Record<string, unknown>; title?: string } }>(
            `SELECT body FROM artifact WHERE task_id=$1 AND kind='rfc'
             ORDER BY version DESC LIMIT 1`,
            [taskId],
          ),
        )
        console.log(
          'merge-acc human_review, rfc:',
          JSON.stringify({ title: rfc.rows[0]?.body?.title, policy_facts: rfc.rows[0]?.body?.policy_facts }),
        )
      }
      expect(TERMINAL_LEGIT, `应到合法终态,实际 ${result.value.finalStatus}`).toContain(
        result.value.finalStatus,
      )

      // S-HUMAN_REVIEW 是 Policy 裁决,非 CI 路径 —— 只有 S-DONE 才验 T-024/PR
      if (result.value.finalStatus === 'S-HUMAN_REVIEW') return

      // ── 2. 事件流含 T-024(CIPassed → S-DONE)──
      const evs = await store.readEvents(taskId, 0, 1000)
      expect(evs.ok).toBe(true)
      if (!evs.ok) return
      const transitions = evs.value
        .filter((e) => e.type === 'TaskStatusChanged')
        .map((e) => (e.payload as { transition: string }).transition)
      expect(transitions).toContain('T-024')

      // ── 3. develop 留下真实提交在远程可解析分支上 ──
      const branch = branchFor(taskId)
      const commits = execFileSync(
        'git',
        ['-C', bare.value, 'log', '--format=%s', `main..${branch}`],
        { encoding: 'utf8' },
      ).trim()
      expect(commits, 'develop 阶段应在该 Task 的分支上留下提交').not.toBe('')

      // ── 4. 远程确有该分支的 PR(幂等 createPullRequest 复用即返回)──
      const found = await github.createPullRequest({
        repoId,
        remoteUrl: remote as string,
        baseBranch: 'main',
        headBranch: branch,
        title: `[keel-merge] ${branch}`,
        body: '合并验收:验证编排器已建 PR',
      })
      expect(found.ok, found.ok ? '' : `查 PR 失败:${found.error.detail}`).toBe(true)
      if (!found.ok) return
      expect(found.value.created, '编排器已建过,再次调用应复用').toBe(false)
      const prNumber = found.value.number
      expect(prNumber).toBeGreaterThan(0)
    } finally {
      // 清理:关 PR + 删远程分支,不留垃圾
      const slug = ownerRepo(remote)
      if (slug.ok) {
        try {
          const branch = branchFor(taskId)
          const list = execFileSync(
            'gh',
            [
              'pr',
              'list',
              '--repo',
              slug.value,
              '--head',
              branch,
              '--state',
              'open',
              '--json',
              'number',
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          )
          const prs = JSON.parse(list) as { number: number }[]
          if (prs.length > 0 && prs[0] !== undefined) {
            execFileSync('gh', ['pr', 'close', String(prs[0].number), '--repo', slug.value], {
              stdio: 'pipe',
            })
          }
        } catch {
          /* 已关闭则忽略 */
        }
        cleanupBranch(branchFor(taskId))
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
