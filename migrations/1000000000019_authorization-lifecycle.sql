-- JT-05：授权生命周期、任务控制代次与执行许可的决定/epoch 绑定。
-- 许可只在签发时和每次外部副作用前通过同一确定性函数复核。

-- Up Migration

ALTER TABLE managed_ticket_task
  ADD COLUMN control_generation int NOT NULL DEFAULT 0
  CHECK (control_generation >= 0);

CREATE OR REPLACE FUNCTION managed_ticket_task_guard() RETURNS trigger
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
     OR NEW.completion_target <> OLD.completion_target
     OR NEW.control_generation < OLD.control_generation THEN
    RAISE EXCEPTION 'managed ticket binding is immutable';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE managed_action_intent
  ADD COLUMN decision_request_id uuid,
  ADD COLUMN decision_request_revision int,
  ADD COLUMN decision_resolution_id uuid,
  ADD COLUMN decision_digest text
    CHECK (decision_digest IS NULL OR decision_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE managed_action_intent
  ADD CONSTRAINT managed_action_intent_decision_shape CHECK (
    (decision_request_id IS NULL
      AND decision_request_revision IS NULL
      AND decision_resolution_id IS NULL
      AND decision_digest IS NULL)
    OR
    (decision_request_id IS NOT NULL
      AND decision_request_revision IS NOT NULL
      AND decision_resolution_id IS NOT NULL
      AND decision_digest IS NOT NULL)
  ),
  ADD CONSTRAINT managed_action_intent_decision_request_fk
    FOREIGN KEY (decision_request_id, decision_request_revision)
    REFERENCES managed_decision_request(id, revision),
  ADD CONSTRAINT managed_action_intent_decision_resolution_fk
    FOREIGN KEY (decision_resolution_id)
    REFERENCES managed_decision_resolution(id);

ALTER TABLE managed_execution_permit
  ADD COLUMN authorization_epoch bigint NOT NULL DEFAULT 0
    CHECK (authorization_epoch >= 0),
  ADD COLUMN task_control_generation bigint NOT NULL DEFAULT 0
    CHECK (task_control_generation >= 0),
  ADD COLUMN budget jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(budget) = 'object'),
  ADD COLUMN decision_request_id uuid,
  ADD COLUMN decision_request_revision int,
  ADD COLUMN decision_resolution_id uuid,
  ADD COLUMN decision_digest text
    CHECK (decision_digest IS NULL OR decision_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE managed_execution_permit
  ADD CONSTRAINT managed_execution_permit_decision_shape CHECK (
    (decision_request_id IS NULL
      AND decision_request_revision IS NULL
      AND decision_resolution_id IS NULL
      AND decision_digest IS NULL)
    OR
    (decision_request_id IS NOT NULL
      AND decision_request_revision IS NOT NULL
      AND decision_resolution_id IS NOT NULL
      AND decision_digest IS NOT NULL)
  ),
  ADD CONSTRAINT managed_execution_permit_budget_shape CHECK (
    budget ? 'max_attempts' OR budget ? 'max_cost_usd' OR budget ? 'max_tokens'
    OR budget = '{}'::jsonb
  );

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
     OR NEW.authorization_epoch <> OLD.authorization_epoch
     OR NEW.task_control_generation <> OLD.task_control_generation
     OR NEW.budget IS DISTINCT FROM OLD.budget
     OR NEW.decision_request_id IS DISTINCT FROM OLD.decision_request_id
     OR NEW.decision_request_revision IS DISTINCT FROM OLD.decision_request_revision
     OR NEW.decision_resolution_id IS DISTINCT FROM OLD.decision_resolution_id
     OR NEW.decision_digest IS DISTINCT FROM OLD.decision_digest
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

CREATE FUNCTION managed_execution_permit_available(
  target_permit uuid,
  at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  permit_value managed_execution_permit%ROWTYPE;
  policy_value managed_delegation_policy%ROWTYPE;
  task_value managed_ticket_task%ROWTYPE;
  request_value managed_decision_request%ROWTYPE;
  resolution_value managed_decision_resolution%ROWTYPE;
  memory_epoch bigint;
  authority_ref jsonb;
  decision_value managed_project_decision%ROWTYPE;
  referenced_policy managed_delegation_policy%ROWTYPE;
BEGIN
  SELECT * INTO permit_value
  FROM managed_execution_permit
  WHERE id = target_permit
  FOR SHARE;
  IF NOT FOUND OR permit_value.status <> 'VALID' OR permit_value.expires_at <= at THEN
    RETURN false;
  END IF;

  SELECT * INTO policy_value
  FROM managed_delegation_policy
  WHERE id = permit_value.authorization_id
  FOR SHARE;
  IF NOT FOUND
     OR policy_value.project_id <> permit_value.project_id
     OR policy_value.version <> permit_value.authorization_version
     OR policy_value.revoked_at IS NOT NULL
     OR policy_value.superseded_by IS NOT NULL
     OR policy_value.valid_from > at
     OR (policy_value.valid_until IS NOT NULL AND policy_value.valid_until <= at) THEN
    RETURN false;
  END IF;

  SELECT * INTO task_value
  FROM managed_ticket_task
  WHERE id = (
    SELECT task_id FROM managed_action_intent WHERE id = permit_value.action_intent_id
  )
  FOR SHARE;
  IF NOT FOUND
     OR task_value.status <> 'WAITING_GATEWAY'
     OR task_value.control_generation <> permit_value.task_control_generation THEN
    RETURN false;
  END IF;

  SELECT epoch INTO memory_epoch
  FROM managed_project_memory_state
  WHERE project_id = permit_value.project_id
  FOR SHARE;
  IF memory_epoch IS NULL OR memory_epoch <> permit_value.authorization_epoch THEN
    RETURN false;
  END IF;

  IF permit_value.decision_request_id IS NOT NULL THEN
    SELECT * INTO request_value
    FROM managed_decision_request
    WHERE id = permit_value.decision_request_id
      AND revision = permit_value.decision_request_revision
    FOR SHARE;
    IF NOT FOUND
       OR request_value.project_id <> permit_value.project_id
       OR request_value.managed_ticket_task_id IS DISTINCT FROM task_value.id
       OR request_value.status <> 'RESOLVED' THEN
      RETURN false;
    END IF;

    SELECT * INTO resolution_value
    FROM managed_decision_resolution
    WHERE id = permit_value.decision_resolution_id
      AND request_id = permit_value.decision_request_id
      AND request_revision = permit_value.decision_request_revision
    FOR SHARE;
    IF NOT FOUND
       OR resolution_value.input_digest <> request_value.input_digest
       OR resolution_value.context_digest <> permit_value.decision_digest
       OR resolution_value.disposition NOT IN ('delegated', 'human_confirmed') THEN
      RETURN false;
    END IF;

    FOR authority_ref IN SELECT value FROM jsonb_array_elements(resolution_value.authority_refs)
    LOOP
      IF authority_ref->>'kind' = 'project_decision' THEN
        SELECT * INTO decision_value
        FROM managed_project_decision
        WHERE id = (authority_ref->>'id')::uuid
        FOR SHARE;
        IF NOT FOUND
           OR decision_value.project_id <> permit_value.project_id
           OR decision_value.version <> (authority_ref->>'version')::int
           OR decision_value.revoked_at IS NOT NULL
           OR decision_value.superseded_by IS NOT NULL
           OR decision_value.valid_from > at
           OR (decision_value.valid_until IS NOT NULL AND decision_value.valid_until <= at) THEN
          RETURN false;
        END IF;
      ELSIF authority_ref->>'kind' = 'delegation_policy' THEN
        SELECT * INTO referenced_policy
        FROM managed_delegation_policy
        WHERE id = (authority_ref->>'id')::uuid
        FOR SHARE;
        IF NOT FOUND
           OR referenced_policy.project_id <> permit_value.project_id
           OR referenced_policy.version <> (authority_ref->>'version')::int
           OR referenced_policy.revoked_at IS NOT NULL
           OR referenced_policy.superseded_by IS NOT NULL
           OR referenced_policy.valid_from > at
           OR (referenced_policy.valid_until IS NOT NULL AND referenced_policy.valid_until <= at) THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
      END IF;
    END LOOP;
  END IF;

  RETURN true;
END
$$;

GRANT EXECUTE ON FUNCTION managed_execution_permit_available(uuid, timestamptz)
  TO keel_control;
REVOKE ALL ON FUNCTION managed_execution_permit_available(uuid, timestamptz) FROM PUBLIC;

-- Down Migration

DROP FUNCTION managed_execution_permit_available(uuid, timestamptz);

ALTER TABLE managed_execution_permit
  DROP CONSTRAINT managed_execution_permit_budget_shape,
  DROP CONSTRAINT managed_execution_permit_decision_shape,
  DROP COLUMN decision_digest,
  DROP COLUMN decision_resolution_id,
  DROP COLUMN decision_request_revision,
  DROP COLUMN decision_request_id,
  DROP COLUMN budget,
  DROP COLUMN task_control_generation,
  DROP COLUMN authorization_epoch;

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

ALTER TABLE managed_action_intent
  DROP CONSTRAINT managed_action_intent_decision_resolution_fk,
  DROP CONSTRAINT managed_action_intent_decision_request_fk,
  DROP CONSTRAINT managed_action_intent_decision_shape,
  DROP COLUMN decision_digest,
  DROP COLUMN decision_resolution_id,
  DROP COLUMN decision_request_revision,
  DROP COLUMN decision_request_id;

CREATE OR REPLACE FUNCTION managed_ticket_task_guard() RETURNS trigger
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

ALTER TABLE managed_ticket_task DROP COLUMN control_generation;
