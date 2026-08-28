/**
 * v0.1 完成判据的**合并**验证 —— 判据的三个部分与「产出一个通过 CI 的 PR」
 * 在**同一次真实运行**里完成，不再分段拼接。
 *
 * 此前判据是两半证明的：
 *   - `v01-criterion`：全链路 S-NEW → S-DONE，但 CI 由测试注入（本地 cheap 版，刻意保留）；
 *   - `github-pr`：真实 push / PR / CI 回读，但不经编排器。
 * 本文件把两者合一：一条真实反馈，真实 OMP session 驱动，
 * `CreatePullRequest` 副作用真实开 PR，`T-024` 由真实 `waitForCi='passed'` 驱动。
 *
 * **不在默认 `pnpm run check` 中**（见 src/acceptance/README.md）。前置条件：
 *   1. `KEEL_GITHUB_TOKEN`（或 `GITHUB_TOKEN`）—— PR 创建与 CI 回读的凭据。
 *      **注意 token 的能力边界**（2026-08-27 实测）：Cursor Cloud Agent 的
 *      GitHub App 安装 token（`ghs_` 前缀）可以 git push，但**不能创建 PR**
 *      （REST 返回 403 Resource not accessible by integration）。
 *      需要 fine-grained PAT：Contents Read+Write 且 Pull requests Read+Write。
 *   2. `KEEL_TEST_REMOTE_REPO`（如 `https://github.com/jionpz/keel`）——
 *      有 push 权限的远程仓库；push 鉴权靠环境 git credential（如 `gh auth setup-git`）；
 *   3. 本机可用的 omp CLI 与推理网关（`OPENCODE_API_KEY` 或 `DEEPSEEK_API_KEY`）。
 *
 * beforeEach 里有两个**预检探针**（都不改变远程状态）：token 有效性与 PR 写权限。
 * 权限不够时在起编排器（分钟级、花钱）**之前**就失败，并打印怎么补。
 *
 * 与项目纪律一致：**条件不满足时明确失败，绝不静默跳过**。
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
import { GitHubProvider, readTokenFromEnv } from '../fact/github-provider.js'
import { ownerRepoSlug, preflightGitHub, preflightOmp } from './preflight.js'

const store = new PgArtifactStore()
const token: string | undefined = readTokenFromEnv()
const remote = process.env.KEEL_TEST_REMOTE_REPO
/**
 * 反馈必须对**目标仓库**成立。
 *
 * 本文件克隆的是 `KEEL_TEST_REMOTE_REPO`（即 Keel 自己），
 * 而本地版 `v01-criterion` 铺的是一个写着「导出模块」的合成仓库 ——
 * 两者能用的反馈不是同一条。此前这里照抄了本地版的「Excel 按日期筛选」，
 * Keel 仓库里根本没有导出功能。
 *
 * 那条反馈曾「通过」，只是因为当时 Session Manager 把 ContextBuilder 造的
 * context 整个丢掉了（见 `src/execution/session/manager.ts` 的 withPrompt）：
 * Agent 既看不到反馈也看不到 RFC，于是照着阶段指令里的暗示答 actionable/pass。
 * 修好之后 Developer 与 QA 立刻如实报告「全仓不存在任何 Excel 导出代码」——
 * **它们是对的**，错的是夹具。
 *
 * 现在这条是**目标仓库 main 分支上真实存在**的缺口：README 的「开发」一节
 * 只写了 `pnpm install` + `pnpm run check`，而 check 里的不变量测试需要真实
 * Postgres（CI 的 workflow 专门起了 postgres service 并设 `KEEL_DATABASE_URL`），
 * 本地还得先 `pnpm run db:migrate`。照 README 做的新人必然失败。
 *
 * 选它有两个刻意的理由：
 *   1. **只依赖 main 上已有的东西**。夹具若引用尚未合并的产物（例如本任务才加的
 *      `pnpm run timeline`），PM 会如实报「前提不成立」—— 而它是对的。
 *   2. **纯文档改动**。PR 要过的 CI 就是 `pnpm run check`，
 *      让模型去改被四条架构约束盯着的源码，验证的就不再是编排闭环了。
 */
const FEEDBACK =
  '照 README 的开发一节做，pnpm install 之后直接 pnpm run check 就失败了——' +
  '原来还得先起 Postgres 再跑 pnpm run db:migrate。希望 README 把这个前置条件写清楚'

/**
 * 前置检查放 beforeEach：缺任何一项就让测试**失败**并打印怎么补，
 * 而不是 skip —— 假绿的输出和通过看起来一样。
 */
beforeEach(async () => {
  if (token === undefined) {
    throw new Error(
      '缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN。设置方式：`export KEEL_GITHUB_TOKEN="$(gh auth token)"`',
    )
  }
  if (remote === undefined || remote === '') {
    throw new Error(
      '缺少 KEEL_TEST_REMOTE_REPO，例如：`export KEEL_TEST_REMOTE_REPO=https://github.com/jionpz/keel`',
    )
  }
  preflightOmp()
  await preflightGitHub(remote, token)
  await asOwner((c) =>
    c.query(
      'TRUNCATE artifact, event, task_feedback, run, task, feedback, repo RESTART IDENTITY CASCADE',
    ),
  )
}, 60_000)

afterAll(closePool)

/** 只铺**输入**：仓库、反馈、Task。此后测试不再写入任何产物 —— 那是「无人干预」的定义 */
async function seed(remoteUrl: string): Promise<{ taskId: string; repoId: string }> {
  const repoId = randomUUID()
  const taskId = randomUUID()
  const feedbackId = randomUUID()

  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO repo (id, provider, remote_url, default_branch) VALUES ($1,'github',$2,'main')`,
      [repoId, remoteUrl],
    )
    await c.query(
      `INSERT INTO feedback (id, source, external_ref, body) VALUES ($1,'manual',$2,$3)`,
      [feedbackId, `ref-${feedbackId}`, FEEDBACK],
    )
    // title 会成为 PR 标题 —— 带前缀便于人在远程仓库辨认并清理
    await c.query(
      `INSERT INTO task (id, status, title, repo_id, base_branch, work_branch)
       VALUES ($1,'S-NEW',$2,$3,'main',$4)`,
      [taskId, `[keel-acc] ${FEEDBACK}`, repoId, branchFor(taskId)],
    )
    await c.query(`INSERT INTO task_feedback (task_id, feedback_id) VALUES ($1,$2)`, [
      taskId,
      feedbackId,
    ])
  })

  return { taskId, repoId }
}

/** beforeEach 已保证非空；此处收窄类型，exactOptionalPropertyTypes 不收 undefined */
function requireToken(): string {
  if (token === undefined) throw new Error('缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN')
  return token
}

/** 收尾：关掉验收 PR。失败只影响远程整洁度，不影响验收结论，故吞掉 */
async function closePr(remoteUrl: string, prNumber: number): Promise<void> {
  try {
    await fetch(`https://api.github.com/repos/${ownerRepoSlug(remoteUrl)}/pulls/${prNumber}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${requireToken()}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state: 'closed' }),
    })
  } catch {
    // 网络抖动等；PR 留着人工关
  }
}

function deleteRemoteBranch(bare: string, remoteUrl: string, branch: string): void {
  try {
    execFileSync('git', ['-C', bare, 'push', remoteUrl, '--delete', branch], { stdio: 'pipe' })
  } catch {
    // 分支可能已被清理
  }
}

describe('v0.1 完成判据（合并：真实编排 + 真实 GitHub PR/CI）', () => {
  it('一条真实反馈无人干预走完 S-NEW → S-DONE，PR 真实存在且 CI 通过，事件流可完整重建', async () => {
    if (remote === undefined) throw new Error('缺少 KEEL_TEST_REMOTE_REPO')
    const { taskId, repoId } = await seed(remote)

    const root = mkdtempSync(join(tmpdir(), 'keel-v01-gh-'))
    const git = new GitWorkspace({ root })
    const bare = await git.ensureBareRepo(repoId, remote)
    expect(bare.ok, bare.ok ? '' : `克隆失败：${bare.error.detail}`).toBe(true)
    if (!bare.ok) return

    // 同一个 GitHubProvider 兼任两个契约：
    // PullRequestGateway 注入 driver（CreatePullRequest 副作用），
    // CiGateway 注入 opts.ci（S-PR_OPEN 读真实 Checks/Status）。不用 externalCi。
    const provider = new GitHubProvider({
      token: requireToken(),
      pollIntervalMs: 5_000,
      pollTimeoutMs: 300_000,
    })
    const binding = { git, repoId, baseBranch: 'main' } as const

    let prNumber: number | undefined
    try {
      const result = await runTaskToCompletion(
        taskId,
        {
          driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding, provider),
          sessions: new HarnessSessionManager(),
          adapter: new OmpAdapter(),
          workspace: { mode: 'worktree', ...binding },
          // 时间由外部注入 —— Control Plane 不读时钟
          now: () => '2026-08-26T13:00:00Z',
        },
        { maxSteps: 25, ci: provider },
      )

      expect(result.ok, result.ok ? '' : `编排失败：${result.error.detail}`).toBe(true)
      if (!result.ok) return

      // ── 1. 走到终态，且最后一步由真实 CI 驱动 ──
      expect(result.value.finalStatus).toBe('S-DONE')
      expect(result.value.steps.map((s) => s.note).join('|')).toContain('外部 CI：passed')

      // ── 2. 事件流能完整重建全过程 ──
      const evs = await store.readEvents(taskId, 0, 1000)
      expect(evs.ok).toBe(true)
      if (!evs.ok) return

      const transitions = evs.value
        .filter((e) => e.type === 'TaskStatusChanged')
        .map((e) => (e.payload as { transition: string }).transition)
      expect(transitions).toEqual(
        result.value.steps.map((s) => s.transition).filter((t) => t !== null),
      )
      expect(transitions[0]).toBe('T-002')
      expect(transitions.at(-1)).toBe('T-024')

      // ── 3. PR 是真实副作用，不是意图：SideEffectApplied(CreatePullRequest) ──
      const prApplied = evs.value.find(
        (e) =>
          e.type === 'SideEffectApplied' &&
          (e.payload as { kind?: string }).kind === 'CreatePullRequest',
      )
      expect(prApplied, '应有真实的 CreatePullRequest 副作用').toBeDefined()
      const prPayload = prApplied?.payload as { pr_number: number; pr_url: string }
      expect(prPayload.pr_url).toMatch(/\/pull\/\d+$/)
      prNumber = prPayload.pr_number

      // 全程不允许出现「记了意图没落地」—— 那说明接线缺了一块
      expect(
        evs.value.filter(
          (e) =>
            e.type === 'SideEffectIntent' &&
            (e.payload as { kind?: string }).kind === 'CreatePullRequest',
        ),
      ).toEqual([])

      // ── 4. 分支真的到了远程（cleanup 前验证）──
      const lsRemote = execFileSync(
        'git',
        ['-C', bare.value, 'ls-remote', remote, `refs/heads/${branchFor(taskId)}`],
        { encoding: 'utf8' },
      ).trim()
      expect(lsRemote, '远程应有该 Task 的 ai/* 分支').not.toBe('')

      // ── 5. 途中每个阶段的产物都由真实 run 产出（无人干预）──
      const artifacts = await asOwner((c) =>
        c.query<{ kind: string; produced_by_run: string | null }>(
          'SELECT kind, produced_by_run FROM artifact WHERE task_id=$1',
          [taskId],
        ),
      )
      const bySession = artifacts.rows.filter((a) => a.kind === 'stage_outcome' || a.kind === 'rfc')
      expect(bySession.length, '应有多个由 session 产出的产物').toBeGreaterThan(2)
      for (const a of bySession) {
        expect(a.produced_by_run, `${a.kind} 应有 produced_by_run`).not.toBeNull()
      }

      // ── 6. develop 阶段在该 Task 的分支上留下真实提交 ──
      const commits = execFileSync(
        'git',
        ['-C', bare.value, 'log', '--format=%s', `main..${branchFor(taskId)}`],
        { encoding: 'utf8' },
      ).trim()
      expect(commits, 'develop 阶段应在分支上留下提交').not.toBe('')

      // ── 7. 每次给 Agent 的上下文都可复现 ──
      const ctxEvents = evs.value.filter((e) => e.type === 'ContextBuilt')
      expect(ctxEvents.length, '每个 session 都应有 ContextBuilt 事件').toBeGreaterThan(2)
      for (const e of ctxEvents) {
        const p = e.payload as {
          sections: { source_ref: string }[]
          dropped: unknown[]
          context_id: string
        }
        expect(p.context_id).toBeTruthy()
        expect(Array.isArray(p.dropped)).toBe(true)
        for (const s of p.sections) expect(s.source_ref).toBeTruthy()
      }

      // ── 8. Policy 裁决落库且是自动放行 ──
      const decision = await store.latest(taskId, 'policy_decision', 'rfc_ready')
      expect(decision.ok).toBe(true)
      if (!decision.ok) return
      expect((decision.value.body as { decision: string }).decision).toBe('auto_develop')

      // 打印路径与 PR，便于写验收记录
      console.log(
        '\n走过的路径：',
        result.value.steps.map((s) => `${s.transition}(${s.note})`).join(' → '),
      )
      console.log('PR：', prPayload.pr_url)
    } finally {
      // 收尾：关 PR + 删远端分支，不留垃圾
      if (prNumber !== undefined) await closePr(remote, prNumber)
      deleteRemoteBranch(join(root, 'repos', `${repoId}.git`), remote, branchFor(taskId))
      rmSync(root, { recursive: true, force: true })
    }
  }, 900_000)
})
