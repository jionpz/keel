-- Up Migration

CREATE TABLE managed_ticket_task (
  id uuid PRIMARY KEY,
  repo_id uuid NOT NULL REFERENCES repo(id),
  package_digest text NOT NULL REFERENCES managed_package(digest),
  ticket_id text NOT NULL CHECK (length(ticket_id) BETWEEN 1 AND 200),
  ticket_title text NOT NULL CHECK (length(ticket_title) BETWEEN 1 AND 1000),
  baseline_commit text NOT NULL CHECK (baseline_commit ~ '^[a-f0-9]{7,64}$'),
  worktree_path text NOT NULL,
  current_stage text NOT NULL CHECK (current_stage IN ('execute','verify','review','land')),
  status text NOT NULL DEFAULT 'READY'
    CHECK (status IN ('READY','RUNNING','WAITING_HUMAN','PAUSED','DONE','FAILED','CANCELLED')),
  completion_target text NOT NULL DEFAULT 'branch_ready'
    CHECK (completion_target = 'branch_ready'),
  lease_token uuid,
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 30 CHECK (max_attempts BETWEEN 1 AND 100),
  rework_count int NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  pending_decision_id uuid,
  pending_decision_revision int,
  last_error text,
  handoff jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, repo_id)
);
CREATE INDEX managed_ticket_task_queue ON managed_ticket_task(status, updated_at);

CREATE TABLE managed_ticket_stage (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_ticket_task(id),
  stage text NOT NULL CHECK (stage IN ('execute','verify','review','land')),
  attempt int NOT NULL CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','REWORK','FAILED','MUST_STOP')),
  package_digest text NOT NULL CHECK (package_digest ~ '^[a-f0-9]{64}$'),
  baseline_commit text NOT NULL,
  input_commit text NOT NULL,
  output_commit text,
  input_digest text NOT NULL,
  output_digest text,
  evidence_digest text,
  result jsonb,
  evidence jsonb,
  usage jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (task_id, stage, attempt)
);
CREATE INDEX managed_ticket_stage_task ON managed_ticket_stage(task_id, started_at);

CREATE TABLE managed_ticket_event (
  seq bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_ticket_task(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_ticket_event_task ON managed_ticket_event(task_id, seq);

ALTER TABLE managed_decision_request ADD COLUMN managed_ticket_task_id uuid;
ALTER TABLE managed_decision_request
  ADD CONSTRAINT managed_decision_request_ticket_project_fk
  FOREIGN KEY (managed_ticket_task_id, project_id) REFERENCES managed_ticket_task(id, repo_id);
CREATE UNIQUE INDEX managed_decision_request_ticket_active
  ON managed_decision_request (managed_ticket_task_id)
  WHERE managed_ticket_task_id IS NOT NULL
    AND status IN ('OPEN', 'PROCESSING', 'WAITING_HUMAN');
CREATE UNIQUE INDEX managed_decision_request_ticket_dedup_active
  ON managed_decision_request (project_id, managed_ticket_task_id, decision_key, input_digest)
  WHERE managed_ticket_task_id IS NOT NULL
    AND status IN ('OPEN', 'PROCESSING', 'WAITING_HUMAN');

ALTER TABLE managed_ticket_task
  ADD CONSTRAINT managed_ticket_task_pending_decision_fk
  FOREIGN KEY (pending_decision_id, pending_decision_revision)
  REFERENCES managed_decision_request(id, revision);

CREATE OR REPLACE FUNCTION managed_decision_request_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.revision <> OLD.revision
     OR NEW.input_digest <> OLD.input_digest
     OR NEW.project_id <> OLD.project_id
     OR NEW.repo_id <> OLD.repo_id
     OR NEW.managed_task_id IS DISTINCT FROM OLD.managed_task_id
     OR NEW.managed_question_id IS DISTINCT FROM OLD.managed_question_id
     OR NEW.managed_ticket_task_id IS DISTINCT FROM OLD.managed_ticket_task_id
     OR NEW.decision_key <> OLD.decision_key
     OR NEW.question <> OLD.question
     OR NEW.options IS DISTINCT FROM OLD.options
     OR NEW.impact IS DISTINCT FROM OLD.impact
     OR NEW.action_category <> OLD.action_category THEN
    RAISE EXCEPTION 'decision request identity and input are immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('PROCESSING', 'WAITING_HUMAN', 'RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('WAITING_HUMAN', 'RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'WAITING_HUMAN' AND NEW.status IN ('RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'RESOLVED' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'illegal decision request transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM managed_decision_resolution
    WHERE request_id = NEW.id AND request_revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'decision request cannot resolve without a resolution';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION managed_ticket_task_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status IN ('DONE','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'managed ticket terminal record is immutable';
  END IF;
  IF NEW.repo_id <> OLD.repo_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.ticket_id <> OLD.ticket_id
     OR NEW.ticket_title <> OLD.ticket_title
     OR NEW.baseline_commit <> OLD.baseline_commit
     OR NEW.worktree_path <> OLD.worktree_path
     OR NEW.completion_target <> OLD.completion_target THEN
    RAISE EXCEPTION 'managed ticket binding is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_ticket_task_guard
  BEFORE UPDATE ON managed_ticket_task
  FOR EACH ROW EXECUTE FUNCTION managed_ticket_task_guard();

CREATE FUNCTION managed_ticket_stage_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'managed ticket stage record is immutable';
  END IF;
  IF NEW.task_id <> OLD.task_id
     OR NEW.stage <> OLD.stage
     OR NEW.attempt <> OLD.attempt
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.baseline_commit <> OLD.baseline_commit
     OR NEW.input_commit <> OLD.input_commit
     OR NEW.input_digest <> OLD.input_digest THEN
    RAISE EXCEPTION 'managed ticket stage identity is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_ticket_stage_guard
  BEFORE UPDATE ON managed_ticket_stage
  FOR EACH ROW EXECUTE FUNCTION managed_ticket_stage_guard();

GRANT SELECT, INSERT, UPDATE ON managed_ticket_task, managed_ticket_stage TO keel_control;
GRANT SELECT, INSERT ON managed_ticket_event TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE managed_ticket_event_seq_seq TO keel_control;
-- keel_execution / keel_ingress 没有 ticket 执行表的权限。

-- Down Migration
ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_pending_decision_fk;
DROP INDEX managed_decision_request_ticket_dedup_active;
DROP INDEX managed_decision_request_ticket_active;
ALTER TABLE managed_decision_request DROP CONSTRAINT managed_decision_request_ticket_project_fk;
ALTER TABLE managed_decision_request DROP COLUMN managed_ticket_task_id;
DROP TRIGGER managed_ticket_stage_guard ON managed_ticket_stage;
DROP FUNCTION managed_ticket_stage_guard();
DROP TRIGGER managed_ticket_task_guard ON managed_ticket_task;
DROP FUNCTION managed_ticket_task_guard();
DROP TABLE managed_ticket_event, managed_ticket_stage, managed_ticket_task;
CREATE OR REPLACE FUNCTION managed_decision_request_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.revision <> OLD.revision
     OR NEW.input_digest <> OLD.input_digest
     OR NEW.project_id <> OLD.project_id
     OR NEW.repo_id <> OLD.repo_id
     OR NEW.managed_task_id IS DISTINCT FROM OLD.managed_task_id
     OR NEW.managed_question_id IS DISTINCT FROM OLD.managed_question_id
     OR NEW.decision_key <> OLD.decision_key
     OR NEW.question <> OLD.question
     OR NEW.options IS DISTINCT FROM OLD.options
     OR NEW.impact IS DISTINCT FROM OLD.impact
     OR NEW.action_category <> OLD.action_category THEN
    RAISE EXCEPTION 'decision request identity and input are immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('PROCESSING', 'WAITING_HUMAN', 'RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('WAITING_HUMAN', 'RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'WAITING_HUMAN' AND NEW.status IN ('RESOLVED', 'CANCELLED', 'SUPERSEDED'))
    OR (OLD.status = 'RESOLVED' AND NEW.status = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'illegal decision request transition % -> %', OLD.status, NEW.status;
  END IF;
  IF NEW.status = 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM managed_decision_resolution
    WHERE request_id = NEW.id AND request_revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'decision request cannot resolve without a resolution';
  END IF;
  RETURN NEW;
END
$$;
