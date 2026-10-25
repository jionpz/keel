# R-009 墙钟语义 ADR

父任务：`.trellis/tasks/08-29-phase2-entry`。

## Goal

把「session 墙钟（`pipeline.ts` watchdog）」与「每轮 harness `--max-time`（`omp.ts`）」共用同一数值的不对称**文档化并决策**，消除 R-007 多轮重试时的预算误扣。

## Background

`08-27-github-issue-automation` 归档 prd 已记录：墙钟 600s 抬升后 rfc_draft 反而更多超时，因 4b 拒稿白烧 session 预算。涉及 R-009 语义（方案 B / issue #26），按纪律需 ADR 而非静默改配置。

## Requirements

- R1 新 ADR（建议 `docs/adr/0008-wall-clock-semantics.md`）描述现状、问题、选项、决策
- R2 选项至少包含：(A) per-round cap = session/N (B) 独立 session budget 字段 (C) 仅文档澄清不改代码
- R3 若改代码：反例测试 + `pnpm run check`；至少 1 次 issue-e2e 或五连单跑对比

## Acceptance Criteria

- [x] AC1：ADR 状态 Proposed 或 Accepted（含明确决策）—— `docs/adr/0008-wall-clock-semantics.md`，**Accepted**（选项 B）
- [x] AC2：若决策含代码变更，反例验证记录在设计/impl 文档 —— 代码已于 2026-08-26 落地（见 design.md「实现现状」），反例为 `src/e2e/timer-inflight.test.ts` / `timer.test.ts`
- [x] AC3：父任务 prd 遗留项「墙钟不对称」引用本 ADR —— 见父任务 Background 表

## 结项记录（2026-10-25）

本任务**没有产品代码产出**：选项 B 早在 `08-26-timer-*` 系列（`733103e` watchdog、
`e471d11` run 级 timer、`ee52945` in-flight 反例、`37bfb45` InterruptReason）
就进入了生产路径。本任务的实际交付是**把既成决策文档化**，并纠正
design.md 中已失效的代码锚点。

触发条件核对（implement.md 第 1 步）：五连第二次战役
`research/five-run-results.jsonl` 共 5 行，`failure_class` 全为 `null`
→ `timeout` 计数 **0**，低于「≥2 才改代码」的门槛。决策仍为 B，
理由不是超时计数，而是**预算归属**（见 ADR Consequences「诚实的边界」）。


## Out of Scope

- 改 Policy / 放宽超时
- 改 harness 协议（除非 ADR 明确）

## Dependency

建议在 `08-29-five-run-campaign` 第一次跑完后 start（根据 timeout 占比决定优先级）。
