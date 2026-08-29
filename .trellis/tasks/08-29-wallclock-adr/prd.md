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

- [ ] AC1：ADR 状态 Proposed 或 Accepted（含明确决策）
- [ ] AC2：若决策含代码变更，反例验证记录在设计/impl 文档
- [ ] AC3：父任务 prd 遗留项「墙钟不对称」引用本 ADR

## Out of Scope

- 改 Policy / 放宽超时
- 改 harness 协议（除非 ADR 明确）

## Dependency

建议在 `08-29-five-run-campaign` 第一次跑完后 start（根据 timeout 占比决定优先级）。
