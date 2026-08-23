/**
 * 真实 GitHub PR / CI 验收 —— v0.1 判据「产出一个通过 CI 的 PR」的真实验证。
 *
 * **不在默认 `pnpm run check` 中**(见 src/acceptance/README.md):
 * 它打真实 GitHub API,创建真实的 PR。前置条件:
 *
 *   1. `KEEL_GITHUB_TOKEN`(或 `GITHUB_TOKEN`)已设置 —— PR 创建与 CI 回读的凭据;
 *   2. `KEEL_TEST_REMOTE_REPO`(如 `https://github.com/jionpz/keel`)——
 *      一个你拥有 push 权限的远程仓库,测试会往它推 `ai/*` 分支并建 PR。
 *
 * 与项目纪律一致:**条件不满足时明确失败,绝不静默跳过** ——
 * 假绿的输出和通过看起来一样(src/acceptance/README.md §这不是不可用就跳过)。
 *
 * 测试内容(design.md §6 验收层):
 *   A. GitWorkspace.push 把 ai/* 分支推到真实远程;
 *   B. GitHubProvider.createPullRequest 真实建 PR(SideEffectApplied 路径);
 *   C. 幂等:同一 head 再调一次,复用已有 PR(created=false);
 *   D. waitForCi 对无 CI 配置的仓库返回 passed(不卡死)。
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { GitWorkspace } from '../fact/git-workspace.js'
import { GitHubProvider, readTokenFromEnv } from '../fact/github-provider.js'

const token: string | undefined = readTokenFromEnv()
const remote = process.env.KEEL_TEST_REMOTE_REPO

/** beforeEach 已保证非空;此处收窄类型,exactOptionalPropertyTypes 不收 undefined */
function requireToken(): string {
  if (token === undefined) throw new Error('缺少 KEEL_GITHUB_TOKEN / GITHUB_TOKEN')
  return token
}

/**
 * 前置检查放 beforeEach:缺任何一项就让测试**失败**并打印怎么补,
 * 而不是 skip —— 这条纪律与数据库测试「连不上就失败」完全相同。
 */
beforeEach(() => {
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
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'keel-gh-acc-'))
})

function cleanupBranch(remoteUrl: string | undefined, branch: string): void {
  if (remoteUrl === undefined || remoteUrl === '') return
  try {
    execFileSync('git', ['push', remoteUrl, '--delete', branch], { cwd: root, stdio: 'pipe' })
  } catch {
    // 分支可能不存在或已被清理;验收记录以 PR 状态为准
  }
}

describe('真实 GitHub PR / CI(需要凭据与远程仓库)', () => {
  it('push → 创建 PR → 幂等复用 → CI 回读', { timeout: 300_000 }, async () => {
    if (remote === undefined) throw new Error('缺少 KEEL_TEST_REMOTE_REPO')
    const provider = new GitHubProvider({ token: requireToken() })
    const git = new GitWorkspace({ root })
    const repoId = randomUUID()
    const taskId = randomUUID()

    // ── A. 本地裸仓库从真实远程克隆 ──
    const bare = await git.ensureBareRepo(repoId, remote)
    expect(bare.ok, bare.ok ? '' : `克隆失败:${bare.error.detail}`).toBe(true)
    if (!bare.ok) return

    // ── B. worktree + 提交 + push ──
    const wt = await git.ensureWorktree(repoId, taskId, 'main')
    expect(wt.ok).toBe(true)
    if (!wt.ok) return
    writeFileSync(join(wt.value.path, '.keel-acc.txt'), `keel acceptance ${taskId}\n`)
    const commit = await git.commitAll(taskId, `keel: acceptance ${taskId.slice(0, 8)}`)
    expect(commit.ok && commit.value !== null, '应有真实提交').toBe(true)

    const push = await git.push(repoId, taskId, remote)
    expect(push.ok, push.ok ? '' : `push 失败:${push.error.detail}`).toBe(true)
    if (!push.ok) return

    const headSha = await git.headSha(repoId, taskId)
    expect(headSha.ok).toBe(true)
    if (!headSha.ok) return

    const headBranch = `ai/task-${taskId.slice(0, 8)}`
    let prNumber: number | undefined
    try {
      // ── C. 真实创建 PR ──
      const created = await provider.createPullRequest({
        repoId,
        remoteUrl: remote,
        baseBranch: 'main',
        headBranch,
        title: `[keel-acc] ${taskId.slice(0, 8)}`,
        body: `Keel 真实 GitHub 验收测试。\n\ntask: \`${taskId}\`\nhead: ${headSha.value}`,
      })
      expect(created.ok, created.ok ? '' : `建 PR 失败:${created.error.detail}`).toBe(true)
      if (!created.ok) return
      expect(created.value.created, '首次应为新建').toBe(true)
      expect(created.value.url).toMatch(/\/pull\/\d+$/)
      prNumber = created.value.number

      // ── D. 幂等:再调一次必须复用,不得重复创建 ──
      const again = await provider.createPullRequest({
        repoId,
        remoteUrl: remote,
        baseBranch: 'main',
        headBranch,
        title: '[keel-acc] duplicate',
        body: 'should not create a second PR',
      })
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(again.value.created, '第二次应复用').toBe(false)
      expect(again.value.number).toBe(prNumber)

      // ── E. CI 回读:该仓库无 CI 配置 → passed(不卡死) ──
      const ci = await new GitHubProvider({
        token: requireToken(),
        pollIntervalMs: 2_000,
        pollTimeoutMs: 60_000,
      }).waitForCi({ repoId, remoteUrl: remote, headSha: headSha.value, prNumber })
      expect(ci.ok, ci.ok ? '' : `CI 查询失败:${ci.error.detail}`).toBe(true)
      if (!ci.ok) return
      expect(ci.value).toBe('passed')
    } finally {
      // 收尾:关 PR + 删远端分支,不留垃圾
      if (prNumber !== undefined) {
        try {
          execFileSync('gh', ['pr', 'close', String(prNumber), '--repo', 'jionpz/keel'], {
            stdio: 'pipe',
          })
        } catch {
          /* 已关闭则忽略 */
        }
      }
      cleanupBranch(remote, headBranch)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
