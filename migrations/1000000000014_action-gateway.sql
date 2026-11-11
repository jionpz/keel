-- JT-02D：受控 action intent / ExecutionPermit / outbox。
-- 执行器只写 intent；只有独立 gateway 进程能签发 permit 并执行外部写动作。

-- Up Migration

ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_status_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_status_check
  CHECK (status IN (
    'READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY','PAUSED','PR_OPENED','DONE','FAILED','CANCELLED'
  ));

CREATE TABLE managed_action_intent (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES managed_ticket_task(id),
  project_id uuid NOT NULL REFERENCES repo(id),
  repo_id uuid NOT NULL REFERENCES repo(id),
  action text NOT NULL CHECK (action = 'push_and_pr'),
  remote_url text NOT NULL CHECK (length(remote_url) BETWEEN 1 AND 2048),
  base_branch text NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 300),
  head_branch text NOT NULL
    CHECK (head_branch ~ '^ai/[A-Za-z0-9._/-]+$' AND length(head_branch) <= 300),
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40}$'),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL
    CHECK (environment IN ('local','test','staging','production')),
  reversibility text NOT NULL
    CHECK (reversibility IN ('reversible','partially_reversible','irreversible')),
  affected_resources jsonb NOT NULL
    CHECK (jsonb_typeof(affected_resources) = 'array'
      AND jsonb_array_length(affected_resources) BETWEEN 1 AND 64),
  pr_title text NOT NULL CHECK (length(pr_title) BETWEEN 1 AND 1000),
  pr_body text NOT NULL CHECK (length(pr_body) BETWEEN 1 AND 16000),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, action),
  UNIQUE (id, project_id),
  CHECK (project_id = repo_id),
  FOREIGN KEY (task_id, project_id) REFERENCES managed_ticket_task(id, repo_id)
);
CREATE INDEX managed_action_intent_task ON managed_action_intent(task_id, created_at);

CREATE FUNCTION managed_action_intent_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'managed action intent is immutable';
END
$$;
CREATE TRIGGER managed_action_intent_guard
  BEFORE UPDATE OR DELETE ON managed_action_intent
  FOR EACH ROW EXECUTE FUNCTION managed_action_intent_guard();

CREATE SEQUENCE managed_execution_permit_fence_seq AS bigint;

CREATE TABLE managed_execution_permit (
  id uuid PRIMARY KEY,
  action_intent_id uuid NOT NULL REFERENCES managed_action_intent(id),
  project_id uuid NOT NULL REFERENCES repo(id),
  repo_id uuid NOT NULL REFERENCES repo(id),
  action text NOT NULL CHECK (action = 'push_and_pr'),
  authorization_kind text NOT NULL CHECK (authorization_kind = 'delegation_policy'),
  authorization_id uuid NOT NULL REFERENCES managed_delegation_policy(id),
  authorization_version int NOT NULL CHECK (authorization_version >= 1),
  authorization_rule_id text NOT NULL CHECK (length(authorization_rule_id) BETWEEN 1 AND 128),
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  expected_sha text NOT NULL CHECK (expected_sha ~ '^[a-f0-9]{40}$'),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  target_digest text NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL
    CHECK (environment IN ('local','test','staging','production')),
  fencing_token bigint NOT NULL DEFAULT nextval('managed_execution_permit_fence_seq'),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID','CONSUMED','REVOKED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_intent_id, fencing_token),
  UNIQUE (id, project_id),
  CHECK (project_id = repo_id),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (action_intent_id, project_id) REFERENCES managed_action_intent(id, project_id)
);
CREATE INDEX managed_execution_permit_intent
  ON managed_execution_permit(action_intent_id, issued_at DESC);

CREATE FUNCTION managed_action_policy_available(
  target_id uuid,
  target_project uuid,
  target_version int,
  at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_value managed_delegation_policy%ROWTYPE;
BEGIN
  SELECT * INTO row_value FROM managed_delegation_policy WHERE id = target_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN row_value.project_id = target_project
    AND row_value.version = target_version
    AND row_value.revoked_at IS NULL
    AND row_value.superseded_by IS NULL
    AND row_value.valid_from <= at
    AND (row_value.valid_until IS NULL OR row_value.valid_until > at);
END
$$;
GRANT EXECUTE ON FUNCTION managed_action_policy_available(uuid, uuid, int, timestamptz)
  TO keel_control;

CREATE FUNCTION managed_execution_permit_guard() RETURNS trigger
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
CREATE TRIGGER managed_execution_permit_guard
  BEFORE UPDATE ON managed_execution_permit
  FOR EACH ROW EXECUTE FUNCTION managed_execution_permit_guard();

CREATE TABLE managed_action_outbox (
  id uuid PRIMARY KEY,
  action_intent_id uuid NOT NULL UNIQUE REFERENCES managed_action_intent(id),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','LEASED','EXECUTING','SUCCEEDED','FAILED','BLOCKED','UNCERTAIN')),
  lease_token uuid,
  lease_until timestamptz,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  permit_id uuid REFERENCES managed_execution_permit(id),
  remote_kind text CHECK (remote_kind IS NULL OR remote_kind IN ('pull_request')),
  remote_id text,
  remote_url text,
  result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_action_outbox_ready
  ON managed_action_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('PENDING','LEASED','EXECUTING','UNCERTAIN');

CREATE FUNCTION managed_action_outbox_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.action_intent_id <> OLD.action_intent_id
     OR NEW.fence < OLD.fence
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'action outbox identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('LEASED','BLOCKED'))
    OR (OLD.status = 'LEASED' AND NEW.status IN ('PENDING','EXECUTING','BLOCKED'))
    OR (OLD.status = 'EXECUTING' AND NEW.status IN ('SUCCEEDED','FAILED','UNCERTAIN'))
    OR (OLD.status = 'UNCERTAIN' AND NEW.status IN ('PENDING','SUCCEEDED','FAILED'))
    OR (OLD.status = 'BLOCKED' AND NEW.status = 'PENDING')
    OR (OLD.status = 'FAILED' AND NEW.status = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'illegal action outbox transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_action_outbox_guard
  BEFORE UPDATE ON managed_action_outbox
  FOR EACH ROW EXECUTE FUNCTION managed_action_outbox_guard();

GRANT SELECT, INSERT ON managed_action_intent TO keel_control;
GRANT SELECT, INSERT, UPDATE ON managed_execution_permit TO keel_control;
GRANT SELECT, INSERT, UPDATE ON managed_action_outbox TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE managed_execution_permit_fence_seq TO keel_control;

-- Down Migration

DROP TRIGGER managed_action_outbox_guard ON managed_action_outbox;
DROP FUNCTION managed_action_outbox_guard();
DROP INDEX managed_action_outbox_ready;
DROP TABLE managed_action_outbox;
DROP TRIGGER managed_execution_permit_guard ON managed_execution_permit;
DROP FUNCTION managed_execution_permit_guard();
DROP FUNCTION managed_action_policy_available(uuid, uuid, int, timestamptz);
DROP INDEX managed_execution_permit_intent;
DROP TABLE managed_execution_permit;
DROP SEQUENCE managed_execution_permit_fence_seq;
DROP TRIGGER managed_action_intent_guard ON managed_action_intent;
DROP FUNCTION managed_action_intent_guard();
DROP INDEX managed_action_intent_task;
DROP TABLE managed_action_intent;

UPDATE managed_ticket_task SET status='PAUSED' WHERE status='WAITING_GATEWAY';
UPDATE managed_ticket_task SET status='DONE' WHERE status='PR_OPENED';
ALTER TABLE managed_ticket_task DROP CONSTRAINT managed_ticket_task_status_check;
ALTER TABLE managed_ticket_task ADD CONSTRAINT managed_ticket_task_status_check
  CHECK (status IN ('READY','RUNNING','WAITING_HUMAN','PAUSED','DONE','FAILED','CANCELLED'));
