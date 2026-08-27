-- 并发守卫（N3）：单 Task 同时至多一个 RUNNING Run。
--
-- 事实来源：docs/08-cross-cutting.md §4.3/§4.4。
-- 这是硬约束 —— 一个 Task 的两个 Run 同时跑，会让 attempt 计数、
-- 成本归属和工作区状态全部失去确定含义。
--
-- 用部分唯一索引由数据库强制，而不是靠应用层自觉：
-- 应用层再怎么写错，第二个 RUNNING 也进不去（与 I1/I2 的强制方式同一哲学）。
-- 终态 Run（SUCCEEDED/FAILED/...）不受限 —— 历史尝试可以有任意多条。

-- Up Migration

CREATE UNIQUE INDEX IF NOT EXISTS run_one_running_per_task ON run (task_id) WHERE status = 'RUNNING';

-- Down Migration

DROP INDEX IF EXISTS run_one_running_per_task;
