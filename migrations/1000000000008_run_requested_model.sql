-- 执行面模型路由：记录每次 run 请求的模型。
--
-- 事实来源：docs/archive/tasks/2026-11/11-03-execution-model-routing/design.md §2.3。
--
-- 可空：模型路由上线前的旧 run 不知道请求了什么模型，NULL 是合法状态。
-- 不允许用缺省模型回填 —— 那会把「不知道」伪装成「就是 deepseek」。
--
-- 写入方是 Control Plane（keel_control 已可 UPDATE run 的既有状态字段）；
-- 授权矩阵不变，不新增任何 GRANT。

-- Up Migration

ALTER TABLE run ADD COLUMN requested_model text;

-- Down Migration

ALTER TABLE run DROP COLUMN IF EXISTS requested_model;
