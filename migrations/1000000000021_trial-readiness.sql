-- JT-07：单 owner 试运行账本。
--
-- 试运行是否满足时间与样本门槛必须来自真实库中已经发生的代决和完成任务。
-- 这里只记录“从何时、对哪些项目开始观察”，不授予任何自动扩权能力；
-- 是否扩大动作范围仍由 owner 在看完 trial-status 后显式决定。

-- Up Migration

CREATE TABLE managed_trial (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  stop_reason text CHECK (stop_reason IS NULL OR length(stop_reason) BETWEEN 1 AND 2000),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (stop_reason IS NULL))
);

-- 单用户产品只允许一个进行中的试运行；停止后才能开始下一轮。
CREATE UNIQUE INDEX managed_trial_one_active
  ON managed_trial ((true))
  WHERE ended_at IS NULL;

CREATE TABLE managed_trial_project (
  trial_id uuid NOT NULL REFERENCES managed_trial(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES repo(id),
  PRIMARY KEY (trial_id, project_id)
);
CREATE INDEX managed_trial_project_project
  ON managed_trial_project (project_id, trial_id);

GRANT SELECT, INSERT, UPDATE ON managed_trial TO keel_control;
GRANT SELECT, INSERT ON managed_trial_project TO keel_control;

-- Down Migration

REVOKE ALL ON managed_trial_project FROM keel_control;
REVOKE ALL ON managed_trial FROM keel_control;
DROP TABLE managed_trial_project;
DROP TABLE managed_trial;
