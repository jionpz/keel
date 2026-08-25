-- durable timer(方案 A,issue #24)。
--
-- v0.1 欠款:T-005 的 StartTimer 之前只 recordIntent,clarification 永不超时,
-- S-NEED_CLARIFICATION 永不进 S-ABANDONED(T-008)。本表让澄清定时器真正落地。
--
-- 关键决策(2026-08-25 已决,方案 A):
--   - timer 是 Fact 平面**可变状态机**(pending → fired | cancelled),不是 append-only
--     —— 与 event/artifact 的只增不改不同,写权限矩阵单独 GRANT。
--   - kind 含 wall_clock 以免下阶段再迁一次;本轮**不插入** wall_clock 行
--     (Run 墙钟超时走 harness --max-time → RUN_TIMEOUT → RunTimeout)。
--   - I9:state='fired' ⇒ fired_at IS NOT NULL。
--   - 幂等:同 (task_id, kind) 至多一个 pending。

-- Up Migration

CREATE TABLE timer (
  id         uuid PRIMARY KEY,
  task_id    uuid NOT NULL REFERENCES task(id),
  -- 预留 run 级 timer(wall_clock,方案 B);本轮 INSERT 恒 NULL
  run_id     uuid REFERENCES run(id),
  kind       text NOT NULL CHECK (kind IN ('clarification_ttl', 'wall_clock')),
  due_at     timestamptz NOT NULL,
  state      text NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','fired','cancelled')),
  fired_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timer_fired_at_i9 CHECK (state <> 'fired' OR fired_at IS NOT NULL)
);

-- 幂等:同 (task_id, kind) 至多一个 pending(重复 StartTimer 不重插)
CREATE UNIQUE INDEX timer_pending_key ON timer (task_id, kind) WHERE state = 'pending';

-- 到期扫描:claimDueTimers 查 pending 且 due_at 已过
CREATE INDEX timer_due_idx ON timer (due_at) WHERE state = 'pending';

GRANT SELECT, INSERT, UPDATE ON timer TO keel_control;

-- Down Migration

DROP TABLE IF EXISTS timer;