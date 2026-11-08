-- 运行 liveness 遥测与巡检健康。
--
-- 事实来源：docs/archive/tasks/2026-11/11-04-run-liveness-patrol/design.md §4.3。
--
-- 这两张表是**运行遥测**，不是 Fact：
--   - 删除 run_liveness 不影响事件流重放得到的 Task 状态；
--   - 决策仍以 RunStalled / RunTimeout 事件为准。
--
-- run_liveness 只授予 keel_control；keel_execution 不得写（Execution 不写 Fact，
-- 进展回调由 Control Plane 落库）。worker_health 也只给 keel_control。

-- Up Migration

CREATE TABLE run_liveness (
  run_id             uuid PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  last_progress_at   timestamptz,
  progress_seq       bigint NOT NULL DEFAULT 0,
  last_kind          text,
  -- 该 run 的有效沉默阈值；NULL = 不做沉默判定（human / 无进展信号）。
  -- 巡检按这一列判定，而不是按 stage 重算 —— 否则会把 human run 当卡死。
  silence_ms         int,
  owner_pid          int,
  owner_heartbeat_at timestamptz,
  harness_pid        int,
  harness_pgid       int,
  harness_started_at timestamptz,
  stall_reported_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 巡检按 owner_heartbeat_at 过期筛候选；按 last_progress_at 应用 stage 阈值。
CREATE INDEX run_liveness_owner_idx ON run_liveness (owner_heartbeat_at);
CREATE INDEX run_liveness_progress_idx ON run_liveness (last_progress_at);

CREATE TABLE worker_health (
  name         text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  last_error   text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON run_liveness TO keel_control;
GRANT SELECT, INSERT, UPDATE ON worker_health TO keel_control;
-- 刻意不授予 keel_execution：进展写入属 Control Plane。

-- Down Migration

DROP TABLE IF EXISTS worker_health;
DROP TABLE IF EXISTS run_liveness;
