# 设计 · 失败与超时 run 入账 token 消耗

> PRD 见 `prd.md`。本文只写技术设计与取舍。

## 1. 边界与数据流

```
Adapter（Execution）        SessionManager（Execution）        Pipeline（Control）        Loop（Control）
awaitResult()
  └ status=TIMEOUT
    usage=已见到的值  ──→  advance() 失败分支带 usage  ──→  累加出错轮  ──→  failRunAndAdvance
                                                                    UPDATE run SET tokens_* ...
```

三处丢失点各自修一层，契约形状在中间两层对齐。

## 2. 契约变更（`src/contracts/errors.ts` + `session-manager.ts`）

新增带 usage 的结果类型，与既有 `PipelineResult` 形状一致：

```ts
// contracts/errors.ts —— 与 Result<T> 同处，types.ts 保持叶子
export type ResultWithUsage<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: KeelError; readonly usage: Usage }
```

`SessionManager.advance()` 的返回改为 `Promise<ResultWithUsage<TurnOutcome>>`。

**为什么不用别的承载方式**：

- 塞进 `KeelError`：错误语义（kind/retryable/detail）与成本核算是两件事，
  混在一起会让每个错误构造点都被迫回答「花了多少钱」。
- Manager 暴露 `lastUsage` 之类的读取口：把状态藏在对象里，
  失败路径的调用方仍然可能忘读；返回值里带着，调用方没法忽略。
- `TurnOutcome` 增加 `status` 字段并把失败也返回 `ok`：会推翻
  `advance` 的 ok/err 语义，所有调用方都要改判据。

`ZERO_USAGE` 从 `pipeline.ts` 上移到 `contracts/types.ts`（Manager 在
Execution Plane，不能 import Control 的 pipeline；`pipeline.ts` 继续导出它，
`loop.ts` 的 import 不变）。

## 3. Adapter 修复

### 3.1 omp（`src/execution/adapters/omp.ts`）

增量解析器 `OmpStreamParser` 已经在 `turn_end` / `message_end` / `agent_end`
时记录 usage。abort 分支改为 `parser.end().usage`：

- 与 SUCCEEDED 路径同一口径（最后一次见到的值），不引入新语义；
- `end()` 会冲刷残留半行到 `nonJsonLines`，abort 后不再使用该解析器，无副作用；
- 流里从未出现 usage → `toUsage({})` → 全 null + `unavailable`（诚实口径）。

`session_ref` 保持 null（不扩大范围：中断后的会话可恢复性未验证）。

### 3.2 claude（`src/execution/adapters/claude-code-parse.ts`）

`stream-json` 的 `assistant` 事件带 `message.id` 与 `message.usage`
（`input_tokens` / `output_tokens`）；`type=result` 只在正常结束时出现。

解析器新增 `partialUsage`：

- 按 `message.id` 去重、同 id 取最后一次（`stream_event` 增量若开启也不会重复计数）；
- 无 `message.id` 时用出现序号作键（宁可少算也不重复算）；
- 累加各消息的 `input_tokens` / `output_tokens`；`assistant` 事件不带成本 →
  `cost_usd = null`、`cost_basis = 'unavailable'`。

abort 分支：

```ts
const parsed = parseClaudeStream(proc.stdout)   // stdout 由 run() 完整收集，中断后仍可解析
const usage = parsed.sawResult ? parsed.usage : parsed.partialUsage
```

有 result 且带聚合值就用它（避免与 assistant 求和重复计数）；
result 存在但用量三项全 null（畸形 / 被裁剪）时回退累加值 —— 聚合值不存在就没有重复计数风险。

## 4. SessionManager（`src/execution/session/manager.ts`）

非 SUCCEEDED 分支：

```ts
return { ok: false, error: makeError(RUN_STATUS_ERROR[status], ...), usage: res.value.usage }
```

其余错误路径（未知 session、`startRun` 失败、`awaitResult` 返回 err）
没有可信 usage 来源 → `usage: ZERO_USAGE`。ErrorKind 映射与 retryable 不动。

## 5. Pipeline（`src/control/proposal/pipeline.ts`）

两处失败返回都把出错轮的 usage 并入：

```ts
const turn = await sessions.advance(handle, {...})
if (!turn.ok) {
  const spent = addUsage(usage, turn.usage)      // 出错轮已上报的部分
  ... RUN_STALLED 映射 ...
  return { ok: false, error: turn.error, usage: spent }
}
```

成功路径不变（`usage = addUsage(usage, turn.value.usage)`）。

## 6. Loop（`src/control/orchestrator/loop.ts`）

**不改**。`failRunAndAdvance` 已按传入的 usage 写 `tokens_in/tokens_out/cost_*/`，
且有 `status='RUNNING'` 守卫防二次记账。本次修复只是让上游把值送到。

## 7. 测试策略

| 层 | 文件 | 断言 |
|---|---|---|
| omp adapter | `adapters.test.ts` | 注入 spawn：先吐 `turn_end`(带 usage) → `interrupt('timeout')` → `awaitResult` 的 usage 非空；未吐任何 usage 时保持 null |
| claude parser | `claude-code.test.ts` | 多个 `assistant` 事件（含重复 id）→ `partialUsage` 为去重求和；有 result 时 `usage` 仍以 result 为准 |
| claude adapter | `claude-code.test.ts` | abort 且有 assistant usage → 返回它；有 result → 用 result |
| manager | `manager.test.ts` | fake adapter 带 usage 返回 TIMEOUT → 失败分支 `usage` 等于该值 |
| 端到端 | `run-failure.test.ts` 用例 F | supervisor stalled → run 行 `tokens_in/out` 非空 |
| 反例 | 手工逐条回退 | 每处回退对应测试先红 |

`Fake` adapter 需要能声明 usage；现有 `usage: {null...}` 的地方按用例需要保留或参数化。

## 8. 兼容性与回滚

- **无 DB 迁移**：`run` 表列与语义不变，只是失败 run 开始有值。
- **事件流不变**：不新增事件类型；`RunFailed` / `RunStalled` payload 不动。
- **历史数据**：已经以 null 入账的失败 run 不回填（无法区分「没花」与「没记」）。
- **回滚**：单次 revert；回滚后失败 run 恢复为 null + unavailable，无数据损坏。
- **CI 约束**：`check:generated` / `check:transitions` / `check:purity` 不受影响；
  `boundaries` 需确认 `contracts` 内新增 import 不越界（errors.ts → types.ts 同层）。

## 9. 风险

- claude `assistant` 事件的 usage 字段**未经真机抓包验证**（现有 fixture 是文档形状，
  assistant 行没有 usage）。实现按「字段缺失则 null」处理，
  缺失时行为与今天一致 —— 不会因猜测而造假。
  真机若上报，自动生效；若不上报，claude 超时仍为 unavailable（omp 路径不受影响）。
- omp 的「最后一次见到」口径可能低估多轮消耗，但这是既有口径，本次不改。
