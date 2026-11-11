-- JT-06：统一后台服务的角色健康、检查点与恢复边界。
--
-- worker_health 原本只记录“最后一次出现”和错误；服务需要区分
-- RUNNING / DEGRADED / STOPPED / BLOCKED、稳定原因码和可恢复检查点。
-- 这里只增量扩列，保留既有 patrol / timer-worker 的三参数写路径。

-- Up Migration

ALTER TABLE worker_health
  ADD COLUMN instance_id uuid,
  ADD COLUMN pid int CHECK (pid IS NULL OR pid > 0),
  ADD COLUMN status text NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPING', 'STOPPED', 'BLOCKED')),
  ADD COLUMN reason_code text
    CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{0,95}$'),
  ADD COLUMN detail text CHECK (detail IS NULL OR length(detail) <= 2000),
  ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(checkpoint) = 'object'),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN last_success_at timestamptz;

CREATE INDEX worker_health_status_seen
  ON worker_health (status, last_seen_at);

-- Down Migration

DROP INDEX IF EXISTS worker_health_status_seen;

ALTER TABLE worker_health
  DROP COLUMN last_success_at,
  DROP COLUMN started_at,
  DROP COLUMN checkpoint,
  DROP COLUMN detail,
  DROP COLUMN reason_code,
  DROP COLUMN status,
  DROP COLUMN pid,
  DROP COLUMN instance_id;
