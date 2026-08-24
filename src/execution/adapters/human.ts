/**
 * HumanAdapter —— 人工作为一种 Harness（L0）。
 *
 * 定义处：docs/05-contracts/harness-adapter.md §5
 *
 * 它的价值不在代码量（很薄），而在于让「人工与 AI 使用同一套工程规范」
 * 成为**类型系统层面的事实**，而不是一句需要靠纪律维持的约定：
 * 人和 AI 走同一个 Run 记账、同一个 Proposal 通道、同一套 attempt 计数。
 *
 * 首批必须包含一个 L0（ADR-0005）：只有 L2 的话，降级路径在 v0.1 期间
 * 完全不会被执行 —— 等接入第一个弱 harness 时才会发现降级逻辑从没跑通过。
 */

import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type {
  DisposeReport,
  HarnessAdapter,
  HarnessDescriptor,
  InterruptReason,
  RunHandle,
  RunResult,
  RunSpec,
  WorkspaceDiff,
} from '../../contracts/harness-adapter.js'
import type { CapabilityId } from '../../shared/ids.js'
import { collectGitDiff } from './git-diff.js'
import { tierOf } from './tier.js'

/**
 * 人工的能力集。
 *
 * CAP-UNTRUSTED_WORKSPACE 对人工成立的理由与机器不同：
 * 人不会因为仓库里有个 .mcp.json 就自动去执行它。
 */
export const HUMAN_CAPABILITIES: readonly CapabilityId[] = [
  'CAP-HEADLESS',
  'CAP-UNTRUSTED_WORKSPACE',
  'CAP-INTERRUPT',
]

/** 人工提交结果的通道。可注入 —— 生产是 UI/CLI，测试是同步桩 */
export interface HumanInbox {
  /** 通知有待办 */
  notify(spec: RunSpec): Promise<void>
  /** 等待人提交结果。返回 null 表示被撤回 */
  await(runId: string): Promise<{ text: string } | null>
  /** 撤回待办 */
  withdraw(runId: string): Promise<void>
}

export class HumanAdapter implements HarnessAdapter {
  private readonly runs = new Map<string, RunSpec>()

  constructor(private readonly inbox: HumanInbox) {}

  describe(): HarnessDescriptor {
    return {
      harness_id: 'human',
      version: '1',
      tier: tierOf(HUMAN_CAPABILITIES),
      capabilities: HUMAN_CAPABILITIES,
      // 人工的成本不以 token 计。禁止用 0 冒充 —— 0 与「不知道」是不同的事实
      cost_basis: 'unavailable',
      limits: { max_input_bytes: null, max_wall_clock_s: null },
    }
  }

  async startRun(spec: RunSpec): Promise<Result<RunHandle>> {
    if (spec.output_contract.mode === 'native') {
      return err(
        makeError('CAPABILITY_UNSUPPORTED', '人工无 CAP-STRUCTURED_OUTPUT，请用 post_validate'),
      )
    }
    const existing = this.runs.get(spec.idempotency_key)
    if (existing !== undefined) {
      return ok({ run_id: existing.run.run_id, harness_id: 'human' })
    }
    this.runs.set(spec.idempotency_key, spec)
    await this.inbox.notify(spec)
    return ok({ run_id: spec.run.run_id, harness_id: 'human' })
  }

  async awaitResult(handle: RunHandle): Promise<Result<RunResult>> {
    const submitted = await this.inbox.await(handle.run_id)
    if (submitted === null) {
      return ok({
        status: 'CANCELLED',
        text: null,
        proposals: [],
        usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
        session_ref: null,
      })
    }
    return ok({
      status: 'SUCCEEDED',
      text: submitted.text,
      proposals: [],
      usage: { tokens_in: null, tokens_out: null, cost_usd: null, cost_basis: 'unavailable' },
      // 无 CAP-RESUME：人工没有可恢复的会话句柄
      session_ref: null,
    })
  }

  /**
   * 读工作区 git 状态 —— **与 AI 路径完全相同的实现**。
   *
   * 人改的、模型改的,都落在同一个 git 工作树里(#1-06):
   * collectChanges 必须看到同一份脏树,否则人工轮的改动会丢。
   */
  async collectChanges(handle: RunHandle): Promise<Result<WorkspaceDiff>> {
    let spec: RunSpec | undefined
    for (const v of this.runs.values()) {
      if (v.run.run_id === handle.run_id) {
        spec = v
        break
      }
    }
    if (spec === undefined) {
      return err(makeError('NOT_FOUND', `未知 run ${handle.run_id}`))
    }
    return collectGitDiff(spec.workspace.path)
  }

  async interrupt(handle: RunHandle, _reason: InterruptReason): Promise<Result<void>> {
    await this.inbox.withdraw(handle.run_id)
    return ok(undefined)
  }

  async dispose(handle: RunHandle): Promise<Result<DisposeReport>> {
    for (const [k, v] of this.runs) {
      if (v.run.run_id === handle.run_id) this.runs.delete(k)
    }
    return ok({ session_ref_retained: false, workspace_cleaned: false })
  }
}
