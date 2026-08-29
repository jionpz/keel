# 第二个 AI Harness（Claude Code）

父任务：`.trellis/tasks/08-29-phase2-entry`。

## Goal

实现 **ClaudeCodeAdapter** MVP，验证 ADR-0005 核心主张：Harness 可替换，且切换不改 Control/Fact 契约。

## Background

- v0.1 实际 AI harness：OMP（L2）+ Human（L0）
- ADR-0005：Claude Code L2 已调研；**Adapter 未实现**
- 阶段二 #1：`docs/09-roadmap.md` §4.2

## Requirements

- R1 本机实测文档 `research/claude-code-interface.md`（argv、NDJSON、resume、cost）
- R2 `ClaudeCodeAdapter` 实现 `HarnessAdapter`：HEADLESS + STREAM + RESUME + COST 最小集
- R3 无 native schema → 共用 `post_validate`（同 OMP）
- R4 编排器可按配置选择 harness（env 或 run spec，最小侵入）
- R5 opt-in acceptance：同一低风险 Issue 模板，Claude Code 跑 `run-issue --ci real` 到 S-DONE 或诚实 AC6

## Acceptance Criteria

- [ ] AC1：`pnpm run check` 全绿（含 adapter 单测）
- [ ] AC2：至少 1 次 opt-in 真实验收到合法终态（S-DONE 优先）
- [ ] AC3：切换 harness 不改变 event  schema / transition 表
- [ ] AC4：`research/claude-code-interface.md` 每项能力有实测依据

## Out of Scope

- Codex / OpenCode / TRAE
- CAP-STRUCTURED_OUTPUT 原生路径（仍 post_validate）
- 多 harness 并行同 Task

## Dependency

**阻塞**：`08-29-five-run-campaign` ≥3/5 成功。
