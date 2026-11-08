/**
 * Task 的 WorkflowDriver 构造 —— 人工裁决与自动对账共用的接线。
 *
 * 三条路径需要同一件事：把「有没有真实工作区」翻译成一个 driver。
 * 两份接线一旦分叉，「驳回能清工作树、对账清理不了」这种只有一条路径成立的事实
 * 就会长期存在，所以这里只留一份。
 */

import { existsSync } from 'node:fs'
import { ok, type Result } from '../contracts/errors.js'
import { WorkflowDriver } from '../control/driver/driver.js'
import type { WorkspaceBinding } from '../control/driver/effects.js'
import { RuleBasedPolicyEngine } from '../control/policy/engine.js'
import { DEFAULT_RULESET } from '../control/policy/ruleset.js'
import { GitWorkspace } from '../fact/git-workspace.js'
import { loadTaskWorkspace } from './task-workspace.js'

/**
 * 不注入工作区的 driver：CreateBranch / CleanWorkspace 只记一条意图。
 *
 * 用于「这一步本来就不需要真实工作区」的转移，以及工作区准备失败时
 * **不阻断**已经成立的决定（例如驳回、issue 关闭）。
 */
export function plainDriver(humanReviewTtlMs: number | null): WorkflowDriver {
  return new WorkflowDriver(
    new RuleBasedPolicyEngine(DEFAULT_RULESET),
    undefined,
    undefined,
    humanReviewTtlMs,
  )
}

/** 注入真实工作区 —— CreateBranch 会真的建分支，CleanWorkspace 会真的移除工作树 */
export async function workspaceDriver(
  taskId: string,
  humanReviewTtlMs: number | null,
): Promise<Result<WorkflowDriver>> {
  const loaded = await loadTaskWorkspace(taskId)
  if (!loaded.ok) return loaded
  const binding: WorkspaceBinding = loaded.value
  return ok(
    new WorkflowDriver(
      new RuleBasedPolicyEngine(DEFAULT_RULESET),
      binding,
      undefined,
      humanReviewTtlMs,
    ),
  )
}

/**
 * 终态清理需要工作区，但**只在已经有工作树时**才准备。
 *
 * 一件事都还没做的任务不该为它去 clone / fetch。准备失败（仓库不可达等）
 * 返回 undefined，由调用方退回 `plainDriver` —— 此时 CleanWorkspace
 * 会如实记一条 `SideEffectIntent`，而不是假装清理完成。
 */
export async function cleanupDriverIfNeeded(
  taskId: string,
  humanReviewTtlMs: number | null,
): Promise<WorkflowDriver | undefined> {
  if (!existsSync(new GitWorkspace().preservePath(taskId))) return undefined
  const built = await workspaceDriver(taskId, humanReviewTtlMs)
  return built.ok ? built.value : undefined
}
