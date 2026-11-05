# 失败 run 落 harness_id

> 父任务 `11-05-run-reliability-remaining`，issue #73 第 1 项。

## Goal

超时 / 失败结算时把 `harness_id`（及 `harness_tier`）与终态**同事务**落库，
让事后追查不依赖已经消失的进程日志。

## Background

- 成功路径（`src/control/orchestrator/loop.ts`）：
  `UPDATE run SET harness_id=$2, harness_tier=$3, ... WHERE id=$1 AND status='SUCCEEDED'`
- 失败 / 超时路径（`failRunAndAdvance`）：
  `UPDATE run SET status, ended_at, error_kind, error_detail, tokens, cost ... WHERE id=$1 AND status='RUNNING'`
  —— **不写 `harness_id`**。
- `requested_model` 已由 `11-03-execution-model-routing` 在认领后写入，模型侧不缺。

后果：最需要事后追查的失败 run，恰恰不知道用的是哪个 harness。

## Requirements

- **R1** 失败 / 超时 / 撤回的结算与 `harness_id`、`harness_tier` 在同一个事务内写入。
- **R2** 保持现有 `status='RUNNING'` 围栏语义：0 行时不得再写、不得重复 emit 事件。
- **R3** 不改成功路径、不改表结构（列已存在）。
- **R4** 旧数据不回填，`harness_id` 为空的旧 run 是合法历史状态。

## Acceptance Criteria

- [ ] 构造一个超时 run（`RUN_STALLED` 或 wall clock），`run` 行能读到 `harness_id`。
- [ ] 构造一个失败 run（adapter 报错），`run` 行能读到 `harness_id`。
- [ ] 被巡检收割后 zombie 返回失败时，不覆盖终态（现有围栏测试保持绿）。
- [ ] `pnpm run check` 全绿。

## Out of Scope

- 模型是否被 harness 真正接受（探活）。
- 旧 run 的回填。
- 新增 run 列。
