# ADR-0008 · 墙钟语义：Run 级预算，Harness 级兜底

**Status**: **Accepted** — 决策已落地于生产路径并经五连验证（2026-10-25 追认）
**Date**: 2026-08-29（起草）/ 2026-10-25（定稿）
**Related**: R-009 / issue #26；R-007（多轮提案重试）；`08-29-wallclock-adr`

## Context

Keel 上原本只有一个墙钟数字（`limits.wall_clock_s`），它同时承担两种**不同粒度**的职责：

| 层 | 代码锚点（决策时） | 语义 |
|---|---|---|
| Session watchdog | `runSessionUntilValid` 的 `wallClockMs` | 覆盖整个 run 的**全部 R-007 轮次** |
| Harness 单轮 | `OmpAdapter` → `--max-time=<wall_clock_s>` | 每次 `advance`（单轮）的硬超时 |

两者共用同一数值，于是出现不对称：**第 1 轮可以合法吃掉整个 run 的预算**。
一旦 4b 校验拒稿（`validate.ts` 第 4b 步）触发重试，后续轮次已无预算，
表现为 `rfc_draft` 阶段超时 —— 而把墙钟从 300s 抬到 600s 后，
超时**反而更多**，因为每轮上限也跟着抬高，单轮烧掉的预算同比放大。

这不是"超时设小了"的问题，而是**预算归属**问题：谁有权在什么粒度上收割一个 run。

## Options

| 选项 | 改动面 | 评价 |
|---|---|---|
| **A. per-round = floor(session / maxRetries)** | pipeline + adapter | 粒度正确，但需要定义 `maxRetries` 的权威来源（Policy？stage？），且每轮变短会误杀合法的长轮 |
| **B. Run 级预算由 Keel 拥有，Harness 上限降为兜底** | orchestrator + timer | 预算归属上移到一个**知道 run 生命周期**的层；harness 的 `--max-time` 退回"防止单次调用永久挂死"的兜底角色 |
| **C. 仅文档澄清，不改代码** | 无 | 承认不对称但不处理；无法解决第 1 轮吃光预算 |

## Decision

**B。**

同一个 `wallClockS` 仍作为 run 级预算的**唯一数值来源**，但权威从 Harness 移到 Keel，
形成三层，职责不再重叠：

| # | 机制 | 位置 | 职责 |
|---|---|---|---|
| 1 | 进程内 watchdog | `runSessionUntilValid({ wallClockMs })` | 到期 `interrupt(handle, 'timeout')`，收敛正在跑的轮次（含 R-007 重试） |
| 2 | 持久化 timer | `timer(kind='wall_clock')`，`due_at = now + wallClockS` | 进程崩溃/挂死时仍能被 `timer/worker` 收割 —— 这是选项 B 相对 watchdog 的**增量价值** |
| 3 | Harness `--max-time` | `RunSpec.limits.wall_clock_s` | 单次调用兜底，不再承担 run 预算语义 |

实现锚点（当前 main）：

- `src/control/orchestrator/loop.ts` — `wallClockS = deps.wallClockS ?? 180`；
  `createRunWallClockTimer` / `cancelRunWallClockTimer`（幂等键 `(run_id, kind)`，
  run 终态即置 `cancelled`，防残留误触发）。
- `src/control/proposal/pipeline.ts` — `runSessionUntilValid` 的 watchdog，
  声明在函数顶层以便 `finally` 可见。
- `src/timer/worker.ts` / `src/timer/reap.ts` — 到期 `wall_clock` timer 的收割方。
- `src/execution/adapters/omp.ts` — `--max-time` 退化为兜底。

超时的后果是**正常状态流转**，不是异常：`TIMEOUT` → `advance` 返错 →
T-030（重试）或 T-031（升人工），由转移表决定，不经由编排器 `return err` 旁路。

默认值保持 `180s`；五连等长任务由 `wallClockS` 显式抬升（见下）。

## Consequences

### 已验证

- 反例/边界测试：`src/e2e/timer-inflight.test.ts`（in-flight 收割 + 可注入 `wallClockS`）、
  `src/e2e/timer.test.ts`、`src/e2e/budget-fuse.test.ts`。
- 五连第二次战役（2026-08-29，`wallClockS: 600`）：**5/5 S-DONE**，`ci_verified` 全真，
  `human_intervention=false`，`failure_class=null`；耗时 180 / 182 / 248 / 273 / 341s。
  混合轮次（含 T-030 重试的 run 1、4）均在总预算内收敛。
- 首次五连的失败（run 4）归因为 ingest 标签可见性竞态（commit `cfca381`），**不是墙钟**。

### 诚实的边界

1. **归因不孤立**：同一窗口内还落了 `9a26b16`（把反馈里的显式约束写进 `rfc_draft` 提示词）。
   五连的改善不能全部记在选项 B 账上。B 的**结构性**收益是可证的那部分：
   进程崩溃后 run 仍会被收割，且超时变成有记录的状态流转。
2. **A 想解决的问题并未被 B 完整解决**：单轮仍可合法耗尽 run 预算，
   因为三层用的是同一个数字。B 保证的是"预算不会被无限期占用"，
   而不是"预算按轮次公平分配"。若后续出现"第 1 轮吃掉 90% 预算"的实测案例，
   继任方案是 A（或 B+A 混合），需新的 ADR，不在此处静默改配置。
3. `wallClockS` 是 run 级注入参数，**不是** `TIMER_DURATIONS` 常量
   （`src/shared/timers.ts` 明确不提供 `wall_clock` 常量）。

### 其他

- 该数值目前由 CLI / acceptance 透传，尚未暴露为面向用户的策略字段；
  多 stage 差异化预算属于阶段三 Agent Pool 范畴。
