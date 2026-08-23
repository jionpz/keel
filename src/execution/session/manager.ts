/**
 * SessionManager —— 属 Execution Plane。
 *
 * 硬约束（docs/02-glossary.md §1）：**绝不直接写 Fact Plane**。
 * 因此本文件不 import `src/fact`，也不做任何校验或提交 ——
 * 它只负责驱动 Adapter、把输出变成 Proposal 交出去。
 *
 * 校验与提交是 Control Plane 的事，见 `src/control/proposal/`。
 * 这个分工不是风格选择：`.dependency-cruiser.cjs` 的
 * execution-must-not-write-fact 规则会拦住反向依赖。
 */

import { randomUUID } from 'node:crypto'
import { err, makeError, ok, type Result } from '../../contracts/errors.js'
import type { HarnessAdapter, RunSpec } from '../../contracts/harness-adapter.js'
import type { Proposal, Usage } from '../../contracts/types.js'
import { extractJson } from './extract.js'

export interface SessionHandle {
  readonly session_id: string
  readonly run_id: string
  readonly harness_id: string
}

export interface TurnInput {
  readonly text: string
  /** R-007 回灌：上一轮提案被拒的理由 */
  readonly rejected_violations?: readonly string[]
}

export interface TurnOutcome {
  readonly proposals: readonly Proposal[]
  readonly usage: Usage
  readonly session_ref: string | null
  /** 原始文本 —— 提取失败时供诊断 */
  readonly raw: string
  /** 提取失败的原因；成功时为 null */
  readonly extract_error: string | null
}

export interface SessionSpec {
  readonly runSpec: RunSpec
  readonly adapter: HarnessAdapter
  /** 期望产出的产物 kind */
  readonly expect: { readonly kind: string; readonly key: string }
}

export class HarnessSessionManager {
  private readonly sessions = new Map<string, SessionSpec>()
  /** 每个 session 已推进的轮次 —— 用于构造单次调用的幂等键 */
  private readonly turns = new Map<string, number>()

  /**
   * 开会话 —— **只登记，不启动执行**。
   *
   * 早先的版本在这里就调 adapter.startRun，结果被 Run 级幂等键挡住：
   * advance() 再调时拿回的是 open() 那次用空 context 起的运行，
   * 模型收到的是空提示词。真实调用才暴露出来。
   */
  async open(spec: SessionSpec): Promise<Result<SessionHandle>> {
    const handle: SessionHandle = {
      session_id: randomUUID(),
      run_id: spec.runSpec.run.run_id,
      harness_id: spec.adapter.describe().harness_id,
    }
    this.sessions.set(handle.session_id, spec)
    this.turns.set(handle.session_id, 0)
    return ok(handle)
  }

  /**
   * 推进一轮。
   *
   * v0.1 的每一轮都是一次完整的 Adapter 调用 —— OMP 的 `-p` 本身就是一次性的。
   * 多轮对话靠 `--resume`（`CAP-RESUME`），属 `restore()` 的范围。
   */
  async advance(handle: SessionHandle, input: TurnInput): Promise<Result<TurnOutcome>> {
    const spec = this.sessions.get(handle.session_id)
    if (spec === undefined) {
      return err(makeError('NOT_FOUND', `未知 session ${handle.session_id}`))
    }

    // Run 级幂等键标识「这个 Task 的这个阶段的第几次尝试」，
    // 但 R-007 的重试发生在**同一个 Run 内** —— 它们是不同的调用，不该被挡住。
    // 因此给 Adapter 的键要带上轮次。
    const turn = (this.turns.get(handle.session_id) ?? 0) + 1
    this.turns.set(handle.session_id, turn)

    const runSpec = withPrompt(
      { ...spec.runSpec, idempotency_key: `${spec.runSpec.idempotency_key}#turn${turn}` },
      buildPrompt(input, spec),
    )
    const started = await spec.adapter.startRun(runSpec)
    if (!started.ok) return err(started.error)

    const res = await spec.adapter.awaitResult(started.value)
    if (!res.ok) return err(res.error)
    if (res.value.status !== 'SUCCEEDED') {
      return err(makeError('PROTOCOL_ERROR', `Run 状态 ${res.value.status}`))
    }

    // Adapter 已声明无 CAP-STRUCTURED_OUTPUT，走 post_validate：从自由文本提取
    const raw = res.value.text ?? ''
    const extracted = extractJson(raw)

    if (!extracted.ok) {
      return ok({
        proposals: [],
        usage: res.value.usage,
        session_ref: res.value.session_ref,
        raw,
        extract_error: extracted.reason,
      })
    }

    const proposal: Proposal = {
      proposal_id: randomUUID(),
      task_id: spec.runSpec.run.task_id,
      kind: spec.expect.kind,
      key: spec.expect.key,
      body: extracted.value,
      supersedes: null,
      produced_by_run: spec.runSpec.run.run_id,
    }

    return ok({
      proposals: [proposal],
      usage: res.value.usage,
      session_ref: res.value.session_ref,
      raw,
      extract_error: null,
    })
  }

  async close(handle: SessionHandle): Promise<Result<void>> {
    const spec = this.sessions.get(handle.session_id)
    if (spec !== undefined) {
      await spec.adapter.dispose({ run_id: handle.run_id, harness_id: handle.harness_id })
      this.sessions.delete(handle.session_id)
      this.turns.delete(handle.session_id)
    }
    return ok(undefined)
  }
}

/**
 * 提示词是**实现的一部分**，写在这里而不是测试里。
 *
 * 写在测试里会让「模型能不能产出合法提案」变成测试的属性而非系统的属性 ——
 * 那样即使里程碑测试通过，真实运行时也未必成立。
 */
function buildPrompt(input: TurnInput, spec: SessionSpec): string {
  const parts = [input.text]

  parts.push(
    '',
    '## 输出要求',
    '',
    `完成后，**只输出一个 JSON 对象**，用 \`\`\`json 围栏包起来，符合 ${spec.expect.kind} 的形状。`,
    '不要输出围栏之外的解释文字。',
  )

  // R-007：把上一轮的拒绝理由具体地回灌。
  // 只说「格式错误」等于让模型猜 —— 必须说清哪个字段违反了什么。
  if (input.rejected_violations !== undefined && input.rejected_violations.length > 0) {
    parts.push(
      '',
      '## 上一次提交被拒绝，原因如下，请修正后重新输出',
      '',
      ...input.rejected_violations.map((v) => `- ${v}`),
    )
  }

  return parts.join('\n')
}

/** 把提示词塞回 RunSpec 的 context —— v0.1 简单替换单个 section */
function withPrompt(spec: RunSpec, prompt: string): RunSpec {
  return {
    ...spec,
    context: {
      ...spec.context,
      sections: [
        {
          id: 'prompt',
          source_ref: 'derived:session-manager',
          source_kind: 'derived',
          priority: 'required',
          content: prompt,
          tokens: Math.ceil(prompt.length / 4),
        },
      ],
    },
  }
}
