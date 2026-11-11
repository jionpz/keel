-- JT-02E：required checks 与准确 PR head SHA 的 pr_ready 门禁。
-- check 结论只来自 GitHub 外部事实；执行器/模型的 completed 自报不进入本路径。

-- Up Migration

ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_status_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_status_check
  CHECK (status IN (
    'READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY','PAUSED','PR_OPENED',
    'CHECKING','PR_READY','PR_CHECKS_FAILED','DONE','FAILED','CANCELLED'
  ));

ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_completion_target_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_completion_target_check
  CHECK (completion_target IN ('branch_ready','pr_ready'));

ALTER TABLE managed_execution_permit
  ADD COLUMN required_checks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE managed_execution_permit
  ADD CONSTRAINT managed_execution_permit_required_checks_shape
  CHECK (
    jsonb_typeof(required_checks) = 'array'
    AND jsonb_array_length(required_checks) <= 16
  );
ALTER TABLE managed_execution_permit
  ADD CONSTRAINT managed_execution_permit_id_intent_unique
  UNIQUE (id, action_intent_id);

CREATE OR REPLACE FUNCTION managed_execution_permit_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.action_intent_id <> OLD.action_intent_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.repo_id <> OLD.repo_id
     OR NEW.action <> OLD.action
     OR NEW.authorization_kind <> OLD.authorization_kind
     OR NEW.authorization_id <> OLD.authorization_id
     OR NEW.authorization_version <> OLD.authorization_version
     OR NEW.authorization_rule_id <> OLD.authorization_rule_id
     OR NEW.authorization_digest <> OLD.authorization_digest
     OR NEW.expected_sha <> OLD.expected_sha
     OR NEW.diff_digest <> OLD.diff_digest
     OR NEW.target_digest <> OLD.target_digest
     OR NEW.required_checks IS DISTINCT FROM OLD.required_checks
     OR NEW.environment <> OLD.environment
     OR NEW.fencing_token <> OLD.fencing_token
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'execution permit identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'VALID' AND NEW.status IN ('CONSUMED','REVOKED','EXPIRED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal execution permit transition % -> %', OLD.status, NEW.status;
END
$$;

CREATE TABLE managed_check_target (
  id uuid PRIMARY KEY,
  action_intent_id uuid NOT NULL UNIQUE REFERENCES managed_action_intent(id),
  permit_id uuid NOT NULL UNIQUE,
  task_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES repo(id),
  repo_id uuid NOT NULL REFERENCES repo(id),
  remote_url text NOT NULL CHECK (length(remote_url) BETWEEN 1 AND 2048),
  base_branch text NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 300),
  head_branch text NOT NULL
    CHECK (head_branch ~ '^ai/[A-Za-z0-9._/-]+$' AND length(head_branch) <= 300),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  authorization_id uuid NOT NULL REFERENCES managed_delegation_policy(id),
  authorization_version int NOT NULL CHECK (authorization_version >= 1),
  pr_number int NOT NULL CHECK (pr_number > 0),
  pr_url text NOT NULL CHECK (length(pr_url) BETWEEN 1 AND 2048),
  required_checks jsonb NOT NULL
    CHECK (
      jsonb_typeof(required_checks) = 'array'
      AND jsonb_array_length(required_checks) <= 16
    ),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CHECKING','READY','FAILED')),
  lease_token uuid,
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_observed_at timestamptz,
  deadline_at timestamptz NOT NULL,
  evidence_digest text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, task_id),
  CHECK (project_id = repo_id),
  CHECK (deadline_at > created_at),
  FOREIGN KEY (permit_id, action_intent_id)
    REFERENCES managed_execution_permit(id, action_intent_id),
  FOREIGN KEY (task_id, project_id) REFERENCES managed_ticket_task(id, repo_id)
);
CREATE INDEX managed_check_target_queue
  ON managed_check_target(status, next_attempt_at, created_at)
  WHERE status IN ('PENDING','CHECKING');

CREATE FUNCTION managed_check_target_bind_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  permit_value managed_execution_permit%ROWTYPE;
  intent_value managed_action_intent%ROWTYPE;
BEGIN
  SELECT * INTO permit_value
  FROM managed_execution_permit
  WHERE id = NEW.permit_id AND action_intent_id = NEW.action_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'check target permit does not match action intent';
  END IF;
  SELECT * INTO intent_value FROM managed_action_intent WHERE id = NEW.action_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'check target action intent does not exist';
  END IF;
  IF NEW.task_id <> intent_value.task_id
     OR NEW.project_id <> permit_value.project_id
     OR NEW.repo_id <> permit_value.repo_id
     OR NEW.remote_url <> intent_value.remote_url
     OR NEW.base_branch <> intent_value.base_branch
     OR NEW.head_branch <> intent_value.head_branch
     OR NEW.head_sha <> permit_value.expected_sha
     OR NEW.head_sha <> intent_value.head_sha
     OR NEW.diff_digest <> permit_value.diff_digest
     OR NEW.authorization_id <> permit_value.authorization_id
     OR NEW.authorization_version <> permit_value.authorization_version
     OR NEW.required_checks IS DISTINCT FROM permit_value.required_checks THEN
    RAISE EXCEPTION 'check target does not match action intent and execution permit';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_check_target_bind_guard
  BEFORE INSERT ON managed_check_target
  FOR EACH ROW EXECUTE FUNCTION managed_check_target_bind_guard();

CREATE FUNCTION managed_check_target_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.action_intent_id <> OLD.action_intent_id
     OR NEW.permit_id <> OLD.permit_id
     OR NEW.task_id <> OLD.task_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.repo_id <> OLD.repo_id
     OR NEW.remote_url <> OLD.remote_url
     OR NEW.base_branch <> OLD.base_branch
     OR NEW.head_branch <> OLD.head_branch
     OR NEW.head_sha <> OLD.head_sha
     OR NEW.diff_digest <> OLD.diff_digest
     OR NEW.authorization_id <> OLD.authorization_id
     OR NEW.authorization_version <> OLD.authorization_version
     OR NEW.pr_number <> OLD.pr_number
     OR NEW.pr_url <> OLD.pr_url
     OR NEW.required_checks IS DISTINCT FROM OLD.required_checks
     OR NEW.deadline_at <> OLD.deadline_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'check target binding is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('CHECKING','FAILED'))
    OR (OLD.status = 'CHECKING' AND NEW.status IN ('CHECKING','READY','FAILED'))
  ) THEN
    RAISE EXCEPTION 'illegal check target transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_check_target_guard
  BEFORE UPDATE ON managed_check_target
  FOR EACH ROW EXECUTE FUNCTION managed_check_target_guard();

CREATE TABLE managed_check_observation (
  id uuid PRIMARY KEY,
  target_id uuid NOT NULL REFERENCES managed_check_target(id),
  attempt int NOT NULL CHECK (attempt >= 1),
  repo text NOT NULL CHECK (length(repo) BETWEEN 1 AND 300),
  repo_url text NOT NULL CHECK (length(repo_url) BETWEEN 1 AND 2048),
  pr_number int NOT NULL CHECK (pr_number > 0),
  pr_url text NOT NULL CHECK (length(pr_url) BETWEEN 1 AND 2048),
  pr_state text NOT NULL CHECK (pr_state IN ('open','closed')),
  head_branch text NOT NULL CHECK (length(head_branch) BETWEEN 1 AND 300),
  base_branch text NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 300),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  check_name text NOT NULL CHECK (length(check_name) BETWEEN 1 AND 200),
  source text NOT NULL CHECK (source IN ('check_run','commit_status','none')),
  conclusion text NOT NULL CHECK (length(conclusion) BETWEEN 1 AND 100),
  external_id text,
  details_url text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, attempt, check_name, source)
);
CREATE INDEX managed_check_observation_target
  ON managed_check_observation(target_id, attempt, check_name);

CREATE FUNCTION managed_check_observation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_value managed_check_target%ROWTYPE;
BEGIN
  SELECT * INTO target_value FROM managed_check_target WHERE id = NEW.target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'check observation target does not exist';
  END IF;
  IF NEW.repo_url <> target_value.remote_url THEN
    RAISE EXCEPTION 'check observation target mismatch';
  END IF;
  IF NEW.observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'check observation time is in the future';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_check_observation_guard
  BEFORE INSERT ON managed_check_observation
  FOR EACH ROW EXECUTE FUNCTION managed_check_observation_guard();

GRANT SELECT, INSERT, UPDATE ON managed_check_target TO keel_control;
GRANT SELECT, INSERT ON managed_check_observation TO keel_control;

-- Down Migration

DROP TRIGGER managed_check_observation_guard ON managed_check_observation;
DROP FUNCTION managed_check_observation_guard();
DROP INDEX managed_check_observation_target;
DROP TABLE managed_check_observation;
DROP TRIGGER managed_check_target_guard ON managed_check_target;
DROP FUNCTION managed_check_target_guard();
DROP TRIGGER managed_check_target_bind_guard ON managed_check_target;
DROP FUNCTION managed_check_target_bind_guard();
DROP INDEX managed_check_target_queue;
DROP TABLE managed_check_target;
ALTER TABLE managed_execution_permit DROP CONSTRAINT managed_execution_permit_id_intent_unique;
ALTER TABLE managed_execution_permit DROP CONSTRAINT managed_execution_permit_required_checks_shape;
ALTER TABLE managed_execution_permit DROP COLUMN required_checks;

CREATE OR REPLACE FUNCTION managed_execution_permit_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.action_intent_id <> OLD.action_intent_id
     OR NEW.project_id <> OLD.project_id
     OR NEW.repo_id <> OLD.repo_id
     OR NEW.action <> OLD.action
     OR NEW.authorization_kind <> OLD.authorization_kind
     OR NEW.authorization_id <> OLD.authorization_id
     OR NEW.authorization_version <> OLD.authorization_version
     OR NEW.authorization_rule_id <> OLD.authorization_rule_id
     OR NEW.authorization_digest <> OLD.authorization_digest
     OR NEW.expected_sha <> OLD.expected_sha
     OR NEW.diff_digest <> OLD.diff_digest
     OR NEW.target_digest <> OLD.target_digest
     OR NEW.environment <> OLD.environment
     OR NEW.fencing_token <> OLD.fencing_token
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.issued_at <> OLD.issued_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'execution permit identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'VALID' AND NEW.status IN ('CONSUMED','REVOKED','EXPIRED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal execution permit transition % -> %', OLD.status, NEW.status;
END
$$;

UPDATE managed_ticket_task SET status='PR_OPENED'
WHERE status IN ('CHECKING','PR_READY','PR_CHECKS_FAILED');
UPDATE managed_ticket_task SET completion_target='branch_ready'
WHERE completion_target='pr_ready';
ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_status_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_status_check
  CHECK (status IN (
    'READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY','PAUSED','PR_OPENED','DONE','FAILED','CANCELLED'
  ));
ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_completion_target_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_completion_target_check
  CHECK (completion_target = 'branch_ready');
