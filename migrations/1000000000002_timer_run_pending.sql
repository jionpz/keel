-- run 级墙钟 timer 幂等索引(方案 B,issue #26)。
--
-- run 级 timer(wall_clock,run_id 非空)每 run 至多一个 pending;
-- 与 Task 级澄清 timer(run_id NULL,已有 timer_pending_key)不冲突。

-- Up Migration

CREATE UNIQUE INDEX timer_run_pending_key ON timer (run_id, kind)
  WHERE state = 'pending' AND run_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS timer_run_pending_key;