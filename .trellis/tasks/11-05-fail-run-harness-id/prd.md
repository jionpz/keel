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
- **R5（check 阶段补充）** 身份必须在 **claim（PENDING→RUNNING）时**就落库，
  而不是等结算：编排进程死掉后由 timer worker / patrol 收割的 run 拿不到 adapter，
  若只在结算写，最需要追查的场景反而仍然是 NULL。结算路径继续写同样的值，
  属无害重复，但 claim 之后的任何终态路径都必须能看到身份。

## Acceptance Criteria

- [ ] 构造一个超时 run（`RUN_STALLED` 或 wall clock），`run` 行能读到 `harness_id`。
- [ ] 构造一个失败 run（adapter 报错），`run` 行能读到 `harness_id`。
- [ ] 被巡检收割后 zombie 返回失败时，不覆盖终态（现有围栏测试保持绿）。
- [ ] **外部收割路径**：claim 之后模拟编排进程死亡，分别经 `reapTimeoutRun` 与
      `patrolStalledRuns` 收割，`run` 行仍能读到 `harness_id` 与正确的 `harness_tier`。
- [ ] claim 被并发守卫拒绝（N4）时，run 仍是 PENDING 且不写身份。
- [ ] `pnpm run check` 全绿。

## Out of Scope

- 模型是否被 harness 真正接受（探活）。
- 旧 run 的回填。
- 新增 run 列。
