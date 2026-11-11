-- JT-03：项目记忆摘要、增量检索、回滚与规则提升。
-- 原始决定仍是事实源；摘要是可重建的读模型，回滚只切指针。

-- Up Migration

-- 变更日志补项目列，摘要水位才能按项目计算；旧行从实体表回填。
ALTER TABLE managed_decision_change ADD COLUMN project_id uuid REFERENCES repo(id);
UPDATE managed_decision_change c
SET project_id = d.project_id
FROM managed_project_decision d
WHERE c.entity_type = 'project_decision' AND d.id = c.entity_id;
UPDATE managed_decision_change c
SET project_id = p.project_id
FROM managed_delegation_policy p
WHERE c.entity_type = 'delegation_policy' AND p.id = c.entity_id;
ALTER TABLE managed_decision_change ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX managed_decision_change_project
  ON managed_decision_change (project_id, seq);

CREATE FUNCTION managed_decision_change_project() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.project_id IS NULL THEN
    IF NEW.entity_type = 'project_decision' THEN
      SELECT project_id INTO NEW.project_id
      FROM managed_project_decision WHERE id = NEW.entity_id;
    ELSE
      SELECT project_id INTO NEW.project_id
      FROM managed_delegation_policy WHERE id = NEW.entity_id;
    END IF;
  END IF;
  IF NEW.project_id IS NULL THEN
    RAISE EXCEPTION 'decision change project cannot be resolved';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_decision_change_project
  BEFORE INSERT ON managed_decision_change
  FOR EACH ROW EXECUTE FUNCTION managed_decision_change_project();

CREATE TABLE managed_project_memory_state (
  project_id uuid PRIMARY KEY REFERENCES repo(id),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  active_summary_id uuid,
  active_summary_version int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((active_summary_id IS NULL) = (active_summary_version IS NULL))
);

CREATE TABLE managed_project_memory_summary (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES repo(id),
  version int NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'REJECTED')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  covered_decision_count int NOT NULL CHECK (covered_decision_count >= 0),
  covered_change_seq bigint NOT NULL CHECK (covered_change_seq >= 0),
  memory_epoch bigint NOT NULL CHECK (memory_epoch >= 0),
  model_version text NOT NULL CHECK (length(model_version) BETWEEN 1 AND 300),
  generated_by text NOT NULL CHECK (length(generated_by) BETWEEN 1 AND 200),
  generated_at timestamptz NOT NULL,
  previous_summary_id uuid,
  rollback_of_summary_id uuid,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(validation) = 'object'),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  UNIQUE (id, project_id),
  FOREIGN KEY (previous_summary_id, project_id)
    REFERENCES managed_project_memory_summary(id, project_id),
  FOREIGN KEY (rollback_of_summary_id, project_id)
    REFERENCES managed_project_memory_summary(id, project_id),
  CHECK (previous_summary_id IS NULL OR previous_summary_id <> id),
  CHECK (rollback_of_summary_id IS NULL OR rollback_of_summary_id <> id)
);
CREATE INDEX managed_project_memory_summary_project
  ON managed_project_memory_summary (project_id, version DESC);

ALTER TABLE managed_project_memory_state
  ADD CONSTRAINT managed_project_memory_state_active_fk
  FOREIGN KEY (active_summary_id, project_id)
  REFERENCES managed_project_memory_summary(id, project_id);

CREATE TABLE managed_project_memory_event (
  seq bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES repo(id),
  kind text NOT NULL
    CHECK (kind IN (
      'summary_created', 'summary_published', 'summary_rejected',
      'rollback', 'epoch_bumped', 'rule_promoted'
    )),
  summary_id uuid,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  reason text,
  occurred_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  FOREIGN KEY (summary_id, project_id)
    REFERENCES managed_project_memory_summary(id, project_id)
);
CREATE INDEX managed_project_memory_event_project
  ON managed_project_memory_event (project_id, seq);

CREATE TABLE managed_project_memory_retrieval (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES repo(id),
  request_id uuid,
  query text NOT NULL CHECK (length(query) BETWEEN 1 AND 16000),
  query_context jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(query_context) = 'object'),
  summary_id uuid,
  summary_version int,
  summary_stale boolean NOT NULL,
  memory_epoch bigint NOT NULL CHECK (memory_epoch >= 0),
  candidate_count int NOT NULL CHECK (candidate_count >= 0),
  expanded boolean NOT NULL,
  expansion_reason text,
  escalation_reason text,
  omitted_count int NOT NULL DEFAULT 0 CHECK (omitted_count >= 0),
  referenced_decision_ids uuid[] NOT NULL DEFAULT '{}',
  budget_entries int NOT NULL CHECK (budget_entries >= 1),
  used_entries int NOT NULL CHECK (used_entries >= 0),
  budget_tokens int NOT NULL CHECK (budget_tokens >= 1),
  used_tokens int NOT NULL CHECK (used_tokens >= 0),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (used_entries <= budget_entries),
  CHECK (used_tokens <= budget_tokens),
  FOREIGN KEY (summary_id, project_id)
    REFERENCES managed_project_memory_summary(id, project_id)
);
CREATE INDEX managed_project_memory_retrieval_project
  ON managed_project_memory_retrieval (project_id, observed_at DESC);

CREATE FUNCTION managed_project_memory_ensure_state(target_project uuid, at timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO managed_project_memory_state(project_id, epoch, updated_at)
  VALUES(target_project, 0, at)
  ON CONFLICT (project_id) DO NOTHING;
END
$$;

CREATE FUNCTION managed_project_memory_lock(target_project uuid, at timestamptz)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_epoch bigint;
BEGIN
  PERFORM managed_project_memory_ensure_state(target_project, at);
  SELECT epoch INTO current_epoch
  FROM managed_project_memory_state
  WHERE project_id = target_project
  FOR UPDATE;
  IF current_epoch IS NULL THEN
    RAISE EXCEPTION 'memory state cannot be locked';
  END IF;
  RETURN current_epoch;
END
$$;

CREATE FUNCTION managed_project_memory_bump(
  target_project uuid, at timestamptz, actor text, reason text, details jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_epoch bigint;
BEGIN
  INSERT INTO managed_project_memory_state(project_id, epoch, updated_at)
  VALUES(target_project, 1, at)
  ON CONFLICT (project_id) DO UPDATE
  SET epoch = managed_project_memory_state.epoch + 1,
      updated_at = EXCLUDED.updated_at
  RETURNING epoch INTO next_epoch;

  INSERT INTO managed_project_memory_event(
    project_id, kind, actor, reason, occurred_at, details
  ) VALUES(
    target_project, 'epoch_bumped', actor, reason, at, COALESCE(details, '{}'::jsonb)
  );
  RETURN next_epoch;
END
$$;

CREATE FUNCTION managed_memory_bump_decision_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM managed_project_memory_bump(
    NEW.project_id,
    NEW.created_at,
    NEW.created_by,
    'project decision inserted',
    jsonb_build_object(
      'decision_id', NEW.id,
      'decision_key', NEW.decision_key,
      'version', NEW.version
    )
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_memory_bump_decision_insert
  AFTER INSERT ON managed_project_decision
  FOR EACH ROW EXECUTE FUNCTION managed_memory_bump_decision_insert();

CREATE FUNCTION managed_memory_bump_policy_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM managed_project_memory_bump(
    NEW.project_id,
    NEW.approved_at,
    NEW.approved_by_owner,
    'delegation policy inserted',
    jsonb_build_object(
      'policy_id', NEW.id,
      'policy_key', NEW.policy_id,
      'version', NEW.version
    )
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_memory_bump_policy_insert
  AFTER INSERT ON managed_delegation_policy
  FOR EACH ROW EXECUTE FUNCTION managed_memory_bump_policy_insert();

CREATE FUNCTION managed_memory_bump_decision_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM managed_project_memory_bump(
    NEW.project_id,
    NEW.changed_at,
    NEW.actor,
    NEW.change_type,
    jsonb_build_object(
      'entity_type', NEW.entity_type,
      'entity_id', NEW.entity_id,
      'entity_version', NEW.entity_version,
      'seq', NEW.seq
    )
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_memory_bump_decision_change
  AFTER INSERT ON managed_decision_change
  FOR EACH ROW EXECUTE FUNCTION managed_memory_bump_decision_change();

CREATE FUNCTION managed_publish_memory_summary(
  target_project uuid,
  target_summary uuid,
  expected_epoch bigint,
  actor text,
  at timestamptz,
  validation_report jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  summary_row managed_project_memory_summary%ROWTYPE;
  state_row managed_project_memory_state%ROWTYPE;
  previous_summary uuid;
BEGIN
  PERFORM managed_project_memory_ensure_state(target_project, at);
  SELECT * INTO state_row
  FROM managed_project_memory_state
  WHERE project_id = target_project
  FOR UPDATE;
  IF state_row.epoch <> expected_epoch THEN
    RAISE EXCEPTION 'memory epoch changed: expected %, current %',
      expected_epoch, state_row.epoch;
  END IF;
  SELECT * INTO summary_row
  FROM managed_project_memory_summary
  WHERE id = target_summary AND project_id = target_project
  FOR UPDATE;
  IF summary_row.id IS NULL THEN
    RAISE EXCEPTION 'memory summary not found in project';
  END IF;
  IF summary_row.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'memory summary is not DRAFT';
  END IF;
  IF summary_row.memory_epoch <> state_row.epoch THEN
    RAISE EXCEPTION 'memory summary was built at epoch %, current epoch %',
      summary_row.memory_epoch, state_row.epoch;
  END IF;

  previous_summary := state_row.active_summary_id;
  IF previous_summary IS NOT NULL THEN
    UPDATE managed_project_memory_summary
    SET status = 'SUPERSEDED'
    WHERE id = previous_summary AND project_id = target_project;
  END IF;
  UPDATE managed_project_memory_summary
  SET status = 'ACTIVE',
      validation = COALESCE(validation_report, '{}'::jsonb)
  WHERE id = target_summary AND project_id = target_project;
  UPDATE managed_project_memory_state
  SET active_summary_id = target_summary,
      active_summary_version = summary_row.version,
      updated_at = at
  WHERE project_id = target_project;

  INSERT INTO managed_project_memory_event(
    project_id, kind, summary_id, actor, occurred_at, details
  ) VALUES(
    target_project, 'summary_published', target_summary, actor, at,
    jsonb_build_object(
      'version', summary_row.version,
      'previous_summary_id', previous_summary,
      'memory_epoch', state_row.epoch
    )
  );
  RETURN state_row.epoch;
END
$$;

CREATE FUNCTION managed_rollback_memory_summary(
  target_project uuid,
  target_summary uuid,
  expected_epoch bigint,
  actor text,
  reason text,
  at timestamptz
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  summary_row managed_project_memory_summary%ROWTYPE;
  state_row managed_project_memory_state%ROWTYPE;
  previous_summary uuid;
BEGIN
  PERFORM managed_project_memory_ensure_state(target_project, at);
  SELECT * INTO state_row
  FROM managed_project_memory_state
  WHERE project_id = target_project
  FOR UPDATE;
  IF state_row.epoch <> expected_epoch THEN
    RAISE EXCEPTION 'memory epoch changed: expected %, current %',
      expected_epoch, state_row.epoch;
  END IF;
  SELECT * INTO summary_row
  FROM managed_project_memory_summary
  WHERE id = target_summary AND project_id = target_project
  FOR UPDATE;
  IF summary_row.id IS NULL THEN
    RAISE EXCEPTION 'memory summary not found in project';
  END IF;
  IF summary_row.status NOT IN ('ACTIVE', 'SUPERSEDED', 'ROLLED_BACK') THEN
    RAISE EXCEPTION 'memory summary has never been published';
  END IF;
  IF state_row.active_summary_id = target_summary THEN
    RAISE EXCEPTION 'memory summary is already active';
  END IF;

  previous_summary := state_row.active_summary_id;
  IF previous_summary IS NOT NULL THEN
    UPDATE managed_project_memory_summary
    SET status = 'ROLLED_BACK'
    WHERE id = previous_summary AND project_id = target_project;
  END IF;
  UPDATE managed_project_memory_summary
  SET status = 'ACTIVE',
      rollback_of_summary_id = previous_summary
  WHERE id = target_summary AND project_id = target_project;
  UPDATE managed_project_memory_state
  SET active_summary_id = target_summary,
      active_summary_version = summary_row.version,
      updated_at = at
  WHERE project_id = target_project;

  INSERT INTO managed_project_memory_event(
    project_id, kind, summary_id, actor, reason, occurred_at, details
  ) VALUES(
    target_project, 'rollback', target_summary, actor, reason, at,
    jsonb_build_object(
      'version', summary_row.version,
      'previous_summary_id', previous_summary,
      'memory_epoch', state_row.epoch
    )
  );
  RETURN state_row.epoch;
END
$$;

CREATE FUNCTION managed_reject_memory_summary(
  target_project uuid,
  target_summary uuid,
  p_actor text,
  p_reason text,
  at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  summary_row managed_project_memory_summary%ROWTYPE;
BEGIN
  SELECT * INTO summary_row
  FROM managed_project_memory_summary
  WHERE id = target_summary AND project_id = target_project
  FOR UPDATE;
  IF summary_row.id IS NULL THEN
    RAISE EXCEPTION 'memory summary not found in project';
  END IF;
  IF summary_row.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only DRAFT memory summary can be rejected';
  END IF;
  UPDATE managed_project_memory_summary
  SET status = 'REJECTED', reason = p_reason
  WHERE id = target_summary;
  INSERT INTO managed_project_memory_event(
    project_id, kind, summary_id, actor, reason, occurred_at, details
  ) VALUES(
    target_project, 'summary_rejected', target_summary, p_actor, p_reason, at,
    jsonb_build_object('version', summary_row.version)
  );
END
$$;

GRANT SELECT ON managed_project_memory_state TO keel_control;
GRANT SELECT, INSERT ON managed_project_memory_summary TO keel_control;
GRANT SELECT, INSERT ON managed_project_memory_event TO keel_control;
GRANT SELECT, INSERT ON managed_project_memory_retrieval TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE managed_project_memory_event_seq_seq TO keel_control;
GRANT EXECUTE ON FUNCTION managed_project_memory_lock(uuid, timestamptz) TO keel_control;
GRANT EXECUTE ON FUNCTION managed_publish_memory_summary(
  uuid, uuid, bigint, text, timestamptz, jsonb
)
  TO keel_control;
GRANT EXECUTE ON FUNCTION managed_rollback_memory_summary(
  uuid, uuid, bigint, text, text, timestamptz
) TO keel_control;
GRANT EXECUTE ON FUNCTION managed_reject_memory_summary(uuid, uuid, text, text, timestamptz)
  TO keel_control;
REVOKE ALL ON FUNCTION managed_publish_memory_summary(
  uuid, uuid, bigint, text, timestamptz, jsonb
)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_project_memory_ensure_state(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_project_memory_lock(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_project_memory_bump(uuid, timestamptz, text, text, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_rollback_memory_summary(
  uuid, uuid, bigint, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION managed_reject_memory_summary(uuid, uuid, text, text, timestamptz)
  FROM PUBLIC;
-- keel_execution / keel_ingress 无记忆表权限。

-- Down Migration
DROP FUNCTION managed_reject_memory_summary(uuid, uuid, text, text, timestamptz);
DROP FUNCTION managed_rollback_memory_summary(uuid, uuid, bigint, text, text, timestamptz);
DROP FUNCTION managed_publish_memory_summary(uuid, uuid, bigint, text, timestamptz, jsonb);
DROP FUNCTION managed_project_memory_lock(uuid, timestamptz);
DROP TRIGGER managed_memory_bump_decision_change ON managed_decision_change;
DROP FUNCTION managed_memory_bump_decision_change();
DROP TRIGGER managed_memory_bump_policy_insert ON managed_delegation_policy;
DROP FUNCTION managed_memory_bump_policy_insert();
DROP TRIGGER managed_memory_bump_decision_insert ON managed_project_decision;
DROP FUNCTION managed_memory_bump_decision_insert();
DROP FUNCTION managed_project_memory_bump(uuid, timestamptz, text, text, jsonb);
DROP FUNCTION managed_project_memory_ensure_state(uuid, timestamptz);
DROP TABLE managed_project_memory_retrieval;
DROP TABLE managed_project_memory_event;
ALTER TABLE managed_project_memory_state DROP CONSTRAINT managed_project_memory_state_active_fk;
DROP TABLE managed_project_memory_state;
DROP TABLE managed_project_memory_summary;
DROP TRIGGER managed_decision_change_project ON managed_decision_change;
DROP FUNCTION managed_decision_change_project();
DROP INDEX managed_decision_change_project;
ALTER TABLE managed_decision_change DROP COLUMN project_id;
