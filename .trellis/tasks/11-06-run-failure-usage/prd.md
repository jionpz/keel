# 失败与超时 run 入账 token 消耗（#74 第 1 条）

> 对应 GitHub issue [#74](https://github.com/jionpz/keel/issues/74) 第 1 条。

## Goal

失败 / 超时 / 撤回的 run 把 **Harness 已上报的** token 与成本写回 run 行，
让 C-002 预算熔断与成本核算看见「最烧钱的那些重试」。

## Background

`src/control/orchestrator/loop.ts` 的失败分支注释写着「失败分支带已累计的 usage，
调用方必须把它写回 run 行」，`failRunAndAdvance` 也确实有这个 UPDATE ——
但 usage 在到达那里之前就丢了，一共丢在三处：

1. **Adapter 层**（根因）：`omp.ts` / `claude-code.ts` 的 abort 分支
   （`state.aborted`）硬编码返回全 null 的 usage。而 omp 的流解析器其实
   已经见过 `turn_end` / `message_end` 里的 usage，claude 的流里 `assistant`
   事件也带 `message.usage` —— 这些已产生的钱被直接丢弃。
2. **SessionManager 层**：`manager.ts` 在 run 非 SUCCEEDED 时
   `return err(...)`，`Result` 的失败分支没有位置放 usage，`res.value.usage` 丢掉。
3. **Pipeline 层**：`runSessionUntilValid` 的失败分支只带出**之前各轮**的累计，
   不含出错这一轮的 usage。

实测证据（issue 原文）：六次 `TIMEOUT` 的 `tokens_in` / `tokens_out` 全为空，
只有成功 run 有数；C-002 对这批花费完全失明。

## Requirements

- **R1 Adapter 上报已见到的 usage**：run 被中断（TIMEOUT / CANCELLED）时，
  Adapter 返回**流里已经出现过的** usage，而不是硬编码的 null。
  - omp：复用增量解析器已记录的 usage（与 SUCCEEDED 路径同一口径）。
  - claude：`assistant` 事件的 `message.usage` 按消息 id 去重后累加；
    若流里已有 `type=result`，以 result 的聚合值为准（不重复计数）。
- **R2 诚实口径不变**：没见过任何 usage 时保持 `null` + `cost_basis='unavailable'`，
  **不得用 0 冒充**（`docs/08-cross-cutting.md` §3.1）。
- **R3 SessionManager 失败也带 usage**：`advance` 的失败分支携带本轮 usage，
  与 `PipelineResult` 的既有形状一致。
- **R4 Pipeline 累加出错轮**：失败 / 卡死两条返回路径都把出错轮的 usage
  并入累计值；成功路径行为不变。
- **R5 不改变既有语义**：ErrorKind 映射（CANCELLED→RUN_CANCELLED、
  TIMEOUT→RUN_TIMEOUT、FAILED→PROTOCOL_ERROR）、可重试标记、状态机转移一律不动。
- **R6 契约文档同步**：`docs/05-contracts/session-manager.md` 的 `advance()`
  签名与 `docs/05-contracts/harness-adapter.md` 的 `awaitResult()` 语义同步更新。

## Acceptance Criteria

- [ ] omp run 超时前流里出现过 usage → run 行 `tokens_in` / `tokens_out` 非空。
- [ ] claude run 超时且无 `result` 行、但 `assistant` 事件带 usage → 入账为各消息之和。
- [ ] claude run 超时且已有 `result` 行 → 用 result 的聚合值，不与 assistant 求和重复。
- [ ] 流里从未出现 usage → run 行保持 null + `unavailable`（禁止 0）。
- [ ] `manager.advance` 失败分支返回的 usage 等于 Adapter 上报值。
- [ ] 端到端：一次 TIMEOUT 的 run，`run` 行与 `failRunAndAdvance` 写入的 tokens 非空。
- [ ] SUCCEEDED 路径行为完全不变（现有断言不改也应通过）。
- [ ] 反例验证：逐条回退修复，对应测试先红。
- [ ] `pnpm run check` 全绿。

## Out of Scope

- **Adapter 返回 `err` 的路径**（如非零退出码的 `HARNESS_UNAVAILABLE`）——
  当前 `awaitResult` 的失败分支同样没有位置放 usage。改动面是
  `HarnessAdapter` 契约的另一个方法，留给单独任务。
- omp 的 usage 语义本身（现有实现取「最后一次见到的值」而非累计）——
  本次只复用同一口径，不重定义。
- 外部收割路径（timer reap 的 `RunTimeout`）：进程内已无 Adapter，
  没有可信 usage 来源，保持 null。
- 人工 Harness（无 token 概念）与成本换算。

## Key Decisions

- **失败分支带 usage 的承载方式**：新增 `TurnResult`（`ok` 分支带 `TurnOutcome`，
  失败分支带 `error` + `usage`），而不是把 usage 塞进 `KeelError`。
  错误语义与成本核算是两件事；`PipelineResult` 已有同一先例。
- **claude 的 assistant 计数按消息 id 去重**：`stream_event` 增量若将来开启，
  同一 message id 会多次出现，取最后值可避免重复计数。

## References

- issue #74；`src/control/orchestrator/loop.ts`（失败结算）、
  `src/control/proposal/pipeline.ts`（累计）、`src/execution/session/manager.ts`
- `.trellis/spec/backend/harness-adapter.md`、`.trellis/spec/backend/orchestrator-loop.md`
- `docs/08-cross-cutting.md` §3.1（成本口径三态）
