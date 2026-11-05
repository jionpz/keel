-- 人工裁决超时自动收尾(11-05-human-review-ttl)。
--
-- S-HUMAN_REVIEW 之前有 5 条入边、0 条超时出边 —— 人不在 keel decide 上出现,
-- 任务就永久停住。本迁移只扩 timer.kind 的取值域,复用 clarification_ttl
-- 的整套机制(pending → fired | cancelled),不新表、不加状态。
--
-- Down 里先删 human_review_ttl 行是刻意的:直接加回窄约束会因存量行而失败。
-- timer 是可变状态机,删历史行不破坏 event 的 append-only 事实。

-- Up Migration

ALTER TABLE timer DROP CONSTRAINT IF EXISTS timer_kind_check;
ALTER TABLE timer ADD CONSTRAINT timer_kind_check
  CHECK (kind IN ('clarification_ttl', 'wall_clock', 'human_review_ttl'));

-- Down Migration

DELETE FROM timer WHERE kind = 'human_review_ttl';
ALTER TABLE timer DROP CONSTRAINT IF EXISTS timer_kind_check;
ALTER TABLE timer ADD CONSTRAINT timer_kind_check
  CHECK (kind IN ('clarification_ttl', 'wall_clock'));
