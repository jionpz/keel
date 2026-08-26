/**
 * keel run-task —— 驱动单 task 到终态(issue #27)。
 *
 * 组装 worktree workspace(临时 git 根 + ensureBareRepo from remote_url),
 * 接线 runTaskToCompletion,输出终态 + 转移轨迹。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowDriver } from '../control/driver/driver.js'
import { runTaskToCompletion } from '../control/orchestrator/loop.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { OmpAdapter } from '../execution/adapters/omp.js'
import { HarnessSessionManager } from '../execution/session/manager.js'
import { asOwner } from '../fact/db.js'
import { GitWorkspace } from '../fact/git-workspace.js'
import { parseArgs } from './argv.js'

export async function runTaskMain(argv: readonly string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv)
  if (flags.help === true || positionals.length === 0) {
    console.log(`用法: keel run-task <taskId> [--max-steps N] [--ci passed|failed]

驱动单 task 到终态(真实 OMP + worktree)。--ci 缺省 passed(模拟 CI 结果)。`)
    return
  }
  const taskId = positionals[0] as string
  const maxSteps =
    typeof flags['max-steps'] === 'number'
      ? flags['max-steps']
      : typeof flags['max-steps'] === 'string'
        ? Number(flags['max-steps'])
        : 30
  const ci = typeof flags.ci === 'string' ? flags.ci : 'passed'

  // 读 task + repo(remote_url)
  const info = await asOwner((c) =>
    c.query<{ repo_id: string; base_branch: string; remote_url: string }>(
      `SELECT t.repo_id, t.base_branch, r.remote_url
       FROM task t JOIN repo r ON r.id = t.repo_id WHERE t.id = $1`,
      [taskId],
    ),
  )
  const row = info.rows[0]
  if (row === undefined) {
    console.error(`run-task: 找不到 task ${taskId}`)
    process.exitCode = 1
    return
  }

  // 临时 git 根 → 从 remote 克隆裸仓库 → worktree binding
  const root = mkdtempSync(join(tmpdir(), 'keel-cli-'))
  const git = new GitWorkspace({ root })
  const bare = await git.ensureBareRepo(row.repo_id, row.remote_url)

  const binding = { git, repoId: row.repo_id, baseBranch: row.base_branch }
  const now = () => new Date().toISOString()

  const result = await runTaskToCompletion(
    taskId,
    {
      driver: new WorkflowDriver(new RuleBasedPolicyEngine(DEFAULT_RULESET), binding),
      sessions: new HarnessSessionManager(),
      adapter: new OmpAdapter(),
      workspace: { mode: 'worktree', ...binding },
      now,
    },
    {
      maxSteps,
      ...(ci === 'passed' || ci === 'failed'
        ? { externalCi: async () => (ci === 'passed' ? 'passed' : 'failed') }
        : {}),
    },
  )
  void bare

  if (!result.ok) {
    console.error(`run-task: ${result.error.detail}`)
    process.exitCode = 1
    return
  }
  console.log(`finalStatus: ${result.value.finalStatus}`)
  console.log('steps:')
  for (const s of result.value.steps) {
    console.log(`  ${s.status_before} -${s.transition ?? '?'}-> ${s.status_after} [${s.note}]`)
  }
}
