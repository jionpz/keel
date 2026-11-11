-- Up Migration

-- v0.1 继续以 repo 作为项目边界；project_id 即受管 repo 的稳定 ID。
-- 核心列只允许 INSERT；替代/撤销只能经 SECURITY DEFINER 单入口回填并留审计。
CREATE TABLE managed_project_decision (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES repo(id),
  decision_key text NOT NULL CHECK (decision_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  version int NOT NULL CHECK (version >= 1),
  statement text NOT NULL CHECK (length(statement) BETWEEN 1 AND 16000),
  selected_option_id text NOT NULL,
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 1),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  source_type text NOT NULL CHECK (source_type IN ('owner_confirmed', 'imported_candidate', 'policy_default')),
  source_ref text NOT NULL,
  created_by text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  supersedes_id uuid REFERENCES managed_project_decision(id),
  superseded_by uuid REFERENCES managed_project_decision(id),
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, decision_key, version),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK (superseded_by IS NULL OR revoked_at IS NULL),
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX managed_project_decision_scope
  ON managed_project_decision (project_id, decision_key, version DESC);

CREATE TABLE managed_delegation_policy (
  id uuid PRIMARY KEY,
  policy_id text NOT NULL CHECK (policy_id ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  version int NOT NULL CHECK (version >= 1),
  project_id uuid NOT NULL REFERENCES repo(id),
  approved_by_owner text NOT NULL,
  approved_at timestamptz NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) >= 1),
  supersedes_id uuid REFERENCES managed_delegation_policy(id),
  superseded_by uuid REFERENCES managed_delegation_policy(id),
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, policy_id, version),
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (superseded_by IS NULL OR superseded_by <> id),
  CHECK (superseded_by IS NULL OR revoked_at IS NULL),
  CHECK (revoked_at IS NULL OR (revoked_by IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX managed_delegation_policy_head
  ON managed_delegation_policy (project_id, policy_id, version DESC);

CREATE TABLE managed_decision_change (
  seq bigserial PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('project_decision', 'delegation_policy')),
  entity_id uuid NOT NULL,
  entity_version int NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('superseded', 'revoked')),
  actor text NOT NULL,
  reason text,
  changed_at timestamptz NOT NULL,
  previous_state jsonb NOT NULL CHECK (jsonb_typeof(previous_state) = 'object'),
  new_state jsonb NOT NULL CHECK (jsonb_typeof(new_state) = 'object')
);
CREATE INDEX managed_decision_change_entity
  ON managed_decision_change (entity_type, entity_id, seq);

CREATE TABLE managed_decision_request (
  id uuid NOT NULL,
  revision int NOT NULL CHECK (revision >= 1),
  idempotency_key text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES repo(id),
  repo_id uuid NOT NULL REFERENCES repo(id),
  managed_task_id uuid REFERENCES managed_task(id),
  managed_question_id uuid REFERENCES managed_question(id),
  task_id uuid REFERENCES task(id),
  node_id text,
  attempt_id text,
  decision_key text NOT NULL CHECK (decision_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('clarification', 'preference', 'design', 'approval', 'recovery', 'budget')),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 16000),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) >= 2),
  suggested_option_id text,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(constraints) = 'array'),
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_information) = 'array'),
  impact jsonb NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
  action_category text NOT NULL,
  workflow_digest text CHECK (workflow_digest IS NULL OR workflow_digest ~ '^[a-f0-9]{64}$'),
  observed_memory_epoch bigint CHECK (observed_memory_epoch IS NULL OR observed_memory_epoch >= 0),
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PROCESSING', 'WAITING_HUMAN', 'RESOLVED', 'CANCELLED', 'SUPERSEDED')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, revision),
  CHECK (project_id = repo_id)
);
ALTER TABLE managed_task ADD CONSTRAINT managed_task_id_repo_unique UNIQUE (id, repo_id);
ALTER TABLE managed_question ADD CONSTRAINT managed_question_id_task_unique UNIQUE (id, task_id);
ALTER TABLE task ADD CONSTRAINT task_id_repo_unique UNIQUE (id, repo_id);
ALTER TABLE managed_decision_request
  ADD CONSTRAINT managed_decision_request_task_project_fk
  FOREIGN KEY (managed_task_id, project_id) REFERENCES managed_task(id, repo_id);
ALTER TABLE managed_decision_request
  ADD CONSTRAINT managed_decision_request_question_task_fk
  FOREIGN KEY (managed_question_id, managed_task_id) REFERENCES managed_question(id, task_id);
ALTER TABLE managed_decision_request
  ADD CONSTRAINT managed_decision_request_jstack_task_fk
  FOREIGN KEY (task_id, project_id) REFERENCES task(id, repo_id);

CREATE UNIQUE INDEX managed_decision_request_question_active
  ON managed_decision_request (managed_question_id)
  WHERE managed_question_id IS NOT NULL
    AND status IN ('OPEN', 'PROCESSING', 'WAITING_HUMAN');
CREATE UNIQUE INDEX managed_decision_request_dedup_active
  ON managed_decision_request (project_id, managed_task_id, decision_key, input_digest)
  WHERE managed_task_id IS NOT NULL
    AND status IN ('OPEN', 'PROCESSING', 'WAITING_HUMAN');
CREATE INDEX managed_decision_request_queue
  ON managed_decision_request (project_id, status, created_at);

CREATE FUNCTION managed_decision_request_guard() RETURNS trigger
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
CREATE TRIGGER managed_decision_request_guard
  BEFORE UPDATE ON managed_decision_request
  FOR EACH ROW EXECUTE FUNCTION managed_decision_request_guard();

CREATE TABLE managed_tianwen_proposal (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  request_revision int NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  actor_type text NOT NULL DEFAULT 'tianwen' CHECK (actor_type = 'tianwen'),
  source text NOT NULL DEFAULT 'model_proposal' CHECK (source = 'model_proposal'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, request_revision)
    REFERENCES managed_decision_request(id, revision),
  CHECK (payload->>'request_id' = request_id::text),
  CHECK (payload->>'request_revision' = request_revision::text),
  CHECK (payload->>'schema_version' = '1.0'),
  CHECK (payload->>'input_digest' = input_digest)
);
CREATE INDEX managed_tianwen_proposal_request
  ON managed_tianwen_proposal (request_id, request_revision, created_at);

CREATE TABLE managed_decision_resolution (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  request_revision int NOT NULL,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('delegated', 'human_confirmed', 'owner_required', 'denied')),
  answer_option_id text,
  answer text,
  rationale text NOT NULL,
  evidence_grade text NOT NULL CHECK (evidence_grade IN ('E0', 'E1', 'E2', 'E3')),
  basis_refs jsonb NOT NULL CHECK (jsonb_typeof(basis_refs) = 'array'),
  actor jsonb NOT NULL CHECK (jsonb_typeof(actor) = 'object'),
  authority_refs jsonb NOT NULL CHECK (jsonb_typeof(authority_refs) = 'array'),
  validity_conditions jsonb NOT NULL CHECK (jsonb_typeof(validity_conditions) = 'array'),
  memory_epoch bigint CHECK (memory_epoch IS NULL OR memory_epoch >= 0),
  delegation_policy_id uuid REFERENCES managed_delegation_policy(id),
  delegation_policy_version int,
  context_digest text NOT NULL CHECK (context_digest ~ '^[a-f0-9]{64}$'),
  resolved_at timestamptz NOT NULL,
  FOREIGN KEY (request_id, request_revision)
    REFERENCES managed_decision_request(id, revision),
  UNIQUE (request_id, request_revision),
  CHECK ((answer_option_id IS NULL) = (answer IS NULL)),
  CHECK ((disposition IN ('delegated', 'human_confirmed')) = (answer_option_id IS NOT NULL)),
  CHECK ((delegation_policy_id IS NULL) = (delegation_policy_version IS NULL))
);
CREATE INDEX managed_decision_resolution_actor
  ON managed_decision_resolution ((actor->>'type'), resolved_at);

CREATE TABLE managed_question_correction (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES managed_question(id),
  request_id uuid NOT NULL,
  request_revision int NOT NULL,
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 16000),
  actor text NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (request_id, request_revision)
    REFERENCES managed_decision_request(id, revision),
  UNIQUE (question_id, request_id, request_revision)
);
CREATE INDEX managed_question_correction_latest
  ON managed_question_correction (question_id, created_at DESC);

CREATE FUNCTION managed_decision_resolution_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_options jsonb;
  request_project uuid;
BEGIN
  SELECT options, project_id INTO request_options, request_project
  FROM managed_decision_request
  WHERE id = NEW.request_id AND revision = NEW.request_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution request revision does not exist';
  END IF;
  IF NEW.answer_option_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(request_options) AS option
    WHERE option->>'id' = NEW.answer_option_id AND option->>'text' = NEW.answer
  ) THEN
    RAISE EXCEPTION 'resolution answer does not match a request option';
  END IF;
  IF (NEW.disposition = 'human_confirmed' AND NEW.actor->>'type' <> 'human')
     OR (NEW.disposition = 'delegated' AND NEW.actor->>'type' NOT IN ('tianwen', 'policy'))
     OR (NEW.disposition IN ('owner_required', 'denied') AND NEW.actor->>'type' <> 'policy') THEN
    RAISE EXCEPTION 'resolution disposition and actor type do not match';
  END IF;
  IF NEW.delegation_policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_delegation_policy
    WHERE id = NEW.delegation_policy_id
      AND version = NEW.delegation_policy_version
      AND project_id = request_project
  ) THEN
    RAISE EXCEPTION 'resolution delegation policy does not belong to request project';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_decision_resolution_guard
  BEFORE INSERT ON managed_decision_resolution
  FOR EACH ROW EXECUTE FUNCTION managed_decision_resolution_guard();

CREATE FUNCTION managed_supersede_decision(old_id uuid, new_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_row managed_project_decision%ROWTYPE;
  new_row managed_project_decision%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM managed_project_decision WHERE id = old_id FOR UPDATE;
  SELECT * INTO new_row FROM managed_project_decision WHERE id = new_id;
  IF old_row.id IS NULL OR new_row.id IS NULL THEN
    RAISE EXCEPTION 'supersede decision row missing';
  END IF;
  IF new_row.supersedes_id IS DISTINCT FROM old_id
     OR old_row.project_id <> new_row.project_id
     OR old_row.decision_key <> new_row.decision_key
     OR old_row.superseded_by IS NOT NULL
     OR old_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'supersede decision scope or state mismatch';
  END IF;
  UPDATE managed_project_decision SET superseded_by = new_id WHERE id = old_id;
  INSERT INTO managed_decision_change(
    entity_type, entity_id, entity_version, change_type, actor, reason,
    changed_at, previous_state, new_state
  ) VALUES(
    'project_decision', old_id, old_row.version, 'superseded',
    new_row.created_by, 'superseded by ' || new_id::text,
    now(), to_jsonb(old_row), to_jsonb(new_row)
  );
END
$$;

CREATE FUNCTION managed_revoke_decision(
  target_id uuid, actor text, reason text, changed_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_row managed_project_decision%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM managed_project_decision WHERE id = target_id FOR UPDATE;
  IF old_row.id IS NULL OR old_row.superseded_by IS NOT NULL OR old_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'decision row is missing, superseded, or already revoked';
  END IF;
  UPDATE managed_project_decision
  SET revoked_at = changed_at, revoked_by = actor, revocation_reason = reason
  WHERE id = target_id;
  INSERT INTO managed_decision_change(
    entity_type, entity_id, entity_version, change_type, actor, reason,
    changed_at, previous_state, new_state
  ) VALUES(
    'project_decision', target_id, old_row.version, 'revoked',
    actor, reason, changed_at, to_jsonb(old_row),
    jsonb_build_object(
      'revoked_at', changed_at, 'revoked_by', actor, 'revocation_reason', reason
    )
  );
END
$$;

CREATE FUNCTION managed_supersede_policy(old_id uuid, new_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_row managed_delegation_policy%ROWTYPE;
  new_row managed_delegation_policy%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM managed_delegation_policy WHERE id = old_id FOR UPDATE;
  SELECT * INTO new_row FROM managed_delegation_policy WHERE id = new_id;
  IF old_row.id IS NULL OR new_row.id IS NULL THEN
    RAISE EXCEPTION 'supersede policy row missing';
  END IF;
  IF new_row.supersedes_id IS DISTINCT FROM old_id
     OR old_row.project_id <> new_row.project_id
     OR old_row.policy_id <> new_row.policy_id
     OR old_row.superseded_by IS NOT NULL
     OR old_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'supersede policy scope or state mismatch';
  END IF;
  UPDATE managed_delegation_policy SET superseded_by = new_id WHERE id = old_id;
  INSERT INTO managed_decision_change(
    entity_type, entity_id, entity_version, change_type, actor, reason,
    changed_at, previous_state, new_state
  ) VALUES(
    'delegation_policy', old_id, old_row.version, 'superseded',
    new_row.approved_by_owner, 'superseded by ' || new_id::text,
    now(), to_jsonb(old_row), to_jsonb(new_row)
  );
END
$$;

CREATE FUNCTION managed_revoke_policy(
  target_id uuid, actor text, reason text, changed_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_row managed_delegation_policy%ROWTYPE;
BEGIN
  SELECT * INTO old_row FROM managed_delegation_policy WHERE id = target_id FOR UPDATE;
  IF old_row.id IS NULL OR old_row.superseded_by IS NOT NULL OR old_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'policy row is missing, superseded, or already revoked';
  END IF;
  UPDATE managed_delegation_policy
  SET revoked_at = changed_at, revoked_by = actor, revocation_reason = reason
  WHERE id = target_id;
  INSERT INTO managed_decision_change(
    entity_type, entity_id, entity_version, change_type, actor, reason,
    changed_at, previous_state, new_state
  ) VALUES(
    'delegation_policy', target_id, old_row.version, 'revoked',
    actor, reason, changed_at, to_jsonb(old_row),
    jsonb_build_object(
      'revoked_at', changed_at, 'revoked_by', actor, 'revocation_reason', reason
    )
  );
END
$$;

GRANT SELECT, INSERT ON managed_project_decision, managed_delegation_policy TO keel_control;
GRANT SELECT, INSERT ON managed_decision_request TO keel_control;
GRANT UPDATE (status, updated_at) ON managed_decision_request TO keel_control;
GRANT SELECT, INSERT ON managed_tianwen_proposal, managed_decision_resolution TO keel_control;
GRANT SELECT, INSERT ON managed_question_correction TO keel_control;
GRANT SELECT ON managed_decision_change TO keel_control;
GRANT EXECUTE ON FUNCTION managed_supersede_decision(uuid, uuid) TO keel_control;
GRANT EXECUTE ON FUNCTION managed_revoke_decision(uuid, text, text, timestamptz) TO keel_control;
GRANT EXECUTE ON FUNCTION managed_supersede_policy(uuid, uuid) TO keel_control;
GRANT EXECUTE ON FUNCTION managed_revoke_policy(uuid, text, text, timestamptz) TO keel_control;
REVOKE ALL ON FUNCTION managed_supersede_decision(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_revoke_decision(uuid, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_supersede_policy(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_revoke_policy(uuid, text, text, timestamptz) FROM PUBLIC;
-- keel_execution / keel_ingress 无这些表的任何权限。

-- Down Migration
DROP FUNCTION managed_revoke_policy(uuid, text, text, timestamptz);
DROP FUNCTION managed_supersede_policy(uuid, uuid);
DROP FUNCTION managed_revoke_decision(uuid, text, text, timestamptz);
DROP FUNCTION managed_supersede_decision(uuid, uuid);
DROP TRIGGER managed_decision_resolution_guard ON managed_decision_resolution;
DROP FUNCTION managed_decision_resolution_guard();
DROP TRIGGER managed_decision_request_guard ON managed_decision_request;
DROP FUNCTION managed_decision_request_guard();
DROP TABLE managed_question_correction;
DROP TABLE managed_decision_resolution, managed_tianwen_proposal;
DROP TABLE managed_decision_request;
DROP TABLE managed_decision_change;
DROP TABLE managed_delegation_policy, managed_project_decision;
ALTER TABLE task DROP CONSTRAINT task_id_repo_unique;
ALTER TABLE managed_question DROP CONSTRAINT managed_question_id_task_unique;
ALTER TABLE managed_task DROP CONSTRAINT managed_task_id_repo_unique;
