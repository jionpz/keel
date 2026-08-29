# R-009 墙钟语义 · 设计

## 现状（代码锚点）

| 层 | 文件 | 行为 |
|---|---|---|
| Session watchdog | `src/execution/session/pipeline.ts` | `wallClockMs` 覆盖整个 session（全部 R-007 轮） |
| Harness 每轮 | `src/execution/adapters/omp.ts` | `--max-time` = `limits.wall_clock_s` |
| 传入 | `src/cli/run-issue.ts` / `run-task.ts` | `--wallClockS` 透传同一数 |

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
