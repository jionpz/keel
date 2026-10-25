# R-009 墙钟语义 · 设计

## 现状（代码锚点）

> ⚠️ 2026-08-29 起草时的锚点已部分失效（`src/execution/session/pipeline.ts` 不存在）。
> 下表为 2026-10-25 核对后的实际位置。

| 层 | 文件 | 行为 |
|---|---|---|
| Session watchdog | `src/control/proposal/pipeline.ts` → `runSessionUntilValid({ wallClockMs })` | 覆盖整个 run（全部 R-007 轮），到期 `interrupt(handle,'timeout')` |
| Run 级持久化 timer | `src/control/orchestrator/loop.ts` → `createRunWallClockTimer` / `cancelRunWallClockTimer` | `timer(kind='wall_clock')`，due = now + wallClockS，进程崩溃后仍可收割 |
| Timer 收割方 | `src/timer/worker.ts` / `src/timer/reap.ts` | 到期 `wall_clock` timer |
| Harness 每轮 | `src/execution/adapters/omp.ts` | `--max-time` = `limits.wall_clock_s`（兜底） |
| 传入 | `src/cli/run-issue.ts` / `run-task.ts` → `loop.ts:382` | `wallClockS` 透传，缺省 180 |

**结论：选项 B 已在 2026-08-26 实现**，本任务不再改代码。

## 问题

第 1 轮可合法消耗全部 session 墙钟 → 4b 拒稿重试 → 后续轮无预算 → T-031。

## 选项

| 选项 | 改动面 | 风险 |
|---|---|---|
| A. per-round = floor(session / maxRetries) | pipeline + omp | 需定义 maxRetries 来源 |
| B. 分离 `session_wall_s` 与 `round_max_s` CLI 参数 | cli + loop | 用户面变复杂 |
| C. 仅文档：4b+提示词已减拒稿，观察五连 | 无代码 | 可能不够 |

## 推荐

五连结果若 timeout≥2 → 选 A 或 B；若 0–1 → 选 C 转 Accepted（观察）。

## 实际决策（2026-10-25）

**B**，且已实现。与"0–1 次超时 → 选 C"的预设分支**不同**，理由：

- C 只澄清、不改变预算归属；第 1 轮吃光 run 预算的结构性问题仍在。
- B 的增量价值不是"少超时"，而是**崩溃后 run 仍被收割**（持久化 timer），
  以及超时变成有记录的状态流转（T-030 / T-031）。
- 五连 5 行全部 `failure_class=null`，说明当时没有触发"必须改"的痛感 ——
  但这不构成否决 B 的理由，因为 B 已在生产路径上跑了两周且五连通过。

已知未解决项（ADR Consequences 已记录）：三层共用同一数值，
单轮仍可耗尽整个 run 预算；若出现实测案例，继任方案为 A，需新 ADR。
