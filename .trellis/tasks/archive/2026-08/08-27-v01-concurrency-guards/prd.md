# v0.1 并发守卫（N2–N4）

> 父任务：`08-23-v01-closed-loop`
> 前置：`08-26-v01-budget-fuse` 已归档（确定性验收 2026-08-27）

## Goal

把 `docs/08-cross-cutting.md` §4.4 中 **N2–N4** 从「诚实缺口」变为**数据库/代码机械强制**，与 v0.1 同步单进程编排兼容。

## Background

- **N2**：`driver.advance` 更新 `task.status` 无 `WHERE status=期望值`，并发写者可能丢更新。
- **N3**：文档要求单 Task 至多一个 `RUNNING` Run，但当前 run 生命周期是 `PENDING → SUCCEEDED`，**从未置 `RUNNING`**。
- **N4**：无全局 `RUNNING` 上限；§4.3 建议起步 3。

AI 合并验收（`v01-criterion-github`）**由用户稍后自行执行** —— 本任务不依赖。

## Requirements

### R1 · N2 乐观锁（task.status）

`driver.advance` 内 status 更新改为：

```sql
UPDATE task SET status=$next, ... WHERE id=$1 AND status=$from
```

`rowCount === 0` → 返回 `CONFLICT`（retryable），写 `NoTransition` 或等价事件说明乐观锁失败。

### R2 · N3 RUNNING 语义 + 部分唯一索引

1. 新 migration：`CREATE UNIQUE INDEX run_one_running_per_task ON run (task_id) WHERE status = 'RUNNING'`
2. `executeRun` 开始时：`UPDATE run SET status='RUNNING', started_at=coalesce(started_at, now()) WHERE id=$1 AND status='PENDING'`（`rowCount=0` 即冲突）
3. 失败路径（若已有）也应离开 RUNNING；成功路径已有 `SUCCEEDED`

### R3 · N4 全局并发上限

- 常量 `DEFAULT_MAX_RUNNING_RUNS = 3`（单处，注释指向 `08-cross-cutting.md` §4.3）
- 在将 run 置为 `RUNNING` **之前**查 `SELECT count(*) FROM run WHERE status='RUNNING'`，若 `>= max` 返回可重试错误或由编排器正常停止（不静默吞掉）
- v0.1 单进程下主要价值是**约束被机械化** + 测试钉住

### R4 · 测试

- 乐观锁：模拟双 advance（或直调 driver）期望第二次 CONFLICT
- N3：同一 task 两个 RUNNING 插入/更新应失败（DB 或应用层）
- N4：超过上限时拒绝第三个 RUNNING
- `pnpm run check` 全绿

## Out of Scope

- durable timer / work queue / 多进程调度器
- 单 repo 活跃 Task 数（§4.3 第二行）—— v0.1 可 defer 并标注
- AI acceptance 重跑

## Acceptance Criteria

- [x] N2：`UPDATE task ... WHERE status=from` + CONFLICT 路径有测试
- [x] N3：migration 部分唯一索引 + executeRun 置 RUNNING + 测试
- [x] N4：全局上限常量 + 检查 + 测试
- [x] 父任务 prd N2–N4 更新勾选/标注
- [x] `pnpm run check` 全绿

## 验收记录（2026-08-27，确定性验收）

- `pnpm run check`：**181 passed** | 4 skipped（16 files）
- 新增 `limits.test.ts`（7）+ `concurrency-guards.test.ts`（4）
- AI 合并验收 deferred（用户自行执行）

## Notes

- 新 migration 文件序号接在 `1000000000000` 之后
- 不改 `transition/table.ts`
