# OMP 模型可配

父任务：`.trellis/tasks/08-29-phase2-entry`。
替代优先级：本任务优先于 `08-29-second-harness`（已推迟，见该任务 D0）。

## Goal

让 Keel 在 **不换 Harness** 的前提下指定 OMP 所用模型。缺省行为与今天完全一致（`deepseek-v4-flash`），避免五连基线漂移。

## Background

- `OmpAdapter` 已有 `opts.model`，`buildArgv` 已传 `--model`。
- `run-task` / `run-issue` **未透传**，生产路径永远 deepseek。
- 产品判断：换模型测的是推理质量；换 Claude Code 测的是另一家 CLI，杠杆更低。

## Requirements

- R1 CLI：`keel run-task` / `run-issue` 支持 `--model <id>`
- R2 Env：`KEEL_MODEL`；优先级 **CLI > env > 缺省 `deepseek-v4-flash`**
- R3 空字符串 / 仅空白 → 启动失败（`CAPABILITY_UNSUPPORTED` 或明确错误），不静默回退缺省
- R4 `OmpAdapter` 构造使用解析后的模型；argv 单测钉住 `--model`
- R5 缺省不变：不设 flag/env 时 argv 仍含 `deepseek-v4-flash`
- R6 文档：README 或 `src/acceptance/README.md` 一行说明如何换模型跑验收

## Acceptance Criteria

- [x] AC1：`pnpm run check` 全绿（351 passed / 4 skipped）
- [x] AC2：单测：缺省 / `--model` / `KEEL_MODEL` / CLI 覆盖 env / 空白拒绝
- [x] AC3：`run-issue` 把同一 `model` 传进 `runTask`（组合不丢字段）
- [x] AC4：不改默认模型；不把第二 Harness 当作本任务范围

## Out of Scope

- Claude Code Adapter
- 模型白名单（非法 id 交给 omp 失败并记入 run error）
- 按 stage 不同模型
- 改五连默认模型

## Key Decisions

| # | 选择 |
|---|---|
| D0 | 推迟第二 Harness，先做本任务 |
| D1 | 透传字符串，不做 Keel 侧模型目录 |
| D2 | 缺省保持 `deepseek-v4-flash` |
