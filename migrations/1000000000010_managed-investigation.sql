-- Up Migration

-- 与旧 Task/Run 分离，避免固定状态机/巡检误驱动新工作流。
CREATE TABLE managed_package (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE managed_task (
  id uuid PRIMARY KEY,
  repo_id uuid NOT NULL REFERENCES repo(id),
  package_digest text NOT NULL REFERENCES managed_package(digest),
  workspace_path text NOT NULL,
  question text NOT NULL,
  file_index jsonb NOT NULL,
  observations jsonb NOT NULL DEFAULT '[]',
  answers jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','RUNNING','WAITING_TIANWEN','WAITING_HUMAN','DONE','FAILED','CANCELLED')),
  phase text NOT NULL DEFAULT 'investigate' CHECK (phase IN ('investigate','tianwen')),
  pending_question_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 12 CHECK (max_attempts BETWEEN 1 AND 50),
  report jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_task_queue ON managed_task(status, updated_at);
CREATE TABLE managed_question (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_task(id),
  question text NOT NULL,
  options jsonb NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','WAITING_HUMAN','RESOLVED')),
  suggestion jsonb,
  answer text,
  answered_by text,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'RESOLVED') = (answer IS NOT NULL))
);
ALTER TABLE managed_task ADD CONSTRAINT managed_task_pending_question_fk
  FOREIGN KEY (pending_question_id) REFERENCES managed_question(id);
CREATE UNIQUE INDEX managed_question_open ON managed_question(task_id) WHERE status <> 'RESOLVED';
CREATE TABLE managed_attempt (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_task(id),
  phase text NOT NULL CHECK (phase IN ('investigate','tianwen')),
  lease_token uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','TIMEOUT')),
  context jsonb NOT NULL,
  result jsonb,
  error text,
  usage jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE TABLE managed_event (
  seq bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_task(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_event_task ON managed_event(task_id, seq);
GRANT SELECT, INSERT ON managed_package TO keel_control;
GRANT SELECT, INSERT, UPDATE ON managed_task, managed_question, managed_attempt TO keel_control;
GRANT SELECT, INSERT ON managed_event TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE managed_event_seq_seq TO keel_control;
-- execution/ingress 没有上述表的任何权限；真实操作者入口在可信 CLI 中。

-- Down Migration
ALTER TABLE managed_task DROP CONSTRAINT managed_task_pending_question_fk;
DROP TABLE managed_event, managed_attempt, managed_question, managed_task, managed_package;
