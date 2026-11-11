-- JT-04：jstack 路线、多 ticket 图、证据复用与归档门。
-- 与旧 task/run 状态机分离；不迁移 legacy-v01 任务。

-- Up Migration

CREATE TABLE managed_workflow (
  id uuid PRIMARY KEY,
  repo_id uuid NOT NULL REFERENCES repo(id),
  package_digest text NOT NULL REFERENCES managed_package(digest),
  repo_config_digest text NOT NULL CHECK (repo_config_digest ~ '^[a-f0-9]{64}$'),
  baseline_commit text NOT NULL CHECK (baseline_commit ~ '^[a-f0-9]{7,64}$'),
  worktree_root text NOT NULL CHECK (worktree_root LIKE '/%'),
  request text NOT NULL CHECK (length(request) BETWEEN 1 AND 16000),
  scope_paths jsonb NOT NULL
    CHECK (jsonb_typeof(scope_paths) = 'array'
      AND jsonb_array_length(scope_paths) BETWEEN 1 AND 50),
  external_issue text CHECK (external_issue IS NULL OR length(external_issue) BETWEEN 1 AND 300),
  completion_target text NOT NULL
    CHECK (completion_target IN ('branch_ready', 'pr_ready')),
  status text NOT NULL DEFAULT 'ROUTING'
    CHECK (status IN (
      'ROUTING','READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY',
      'PR_READY','PAUSED','DONE','FAILED','CANCELLED'
    )),
  current_graph_version int NOT NULL DEFAULT 0 CHECK (current_graph_version >= 0),
  lease_token uuid,
  lease_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 500 CHECK (max_attempts BETWEEN 1 AND 1000),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_workflow_queue ON managed_workflow(status, updated_at);

CREATE TABLE managed_workflow_graph (
  workflow_id uuid NOT NULL REFERENCES managed_workflow(id),
  version int NOT NULL CHECK (version >= 1),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  status text NOT NULL DEFAULT 'COMMITTED'
    CHECK (status IN ('COMMITTED','SUPERSEDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz NOT NULL DEFAULT now(),
  invalidated_reason text,
  PRIMARY KEY (workflow_id, version)
);

CREATE TABLE managed_workflow_node (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL,
  graph_version int NOT NULL,
  node_key text NOT NULL CHECK (node_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  ticket_id text NOT NULL CHECK (length(ticket_id) BETWEEN 1 AND 200),
  external_issue text CHECK (external_issue IS NULL OR length(external_issue) BETWEEN 1 AND 300),
  ticket_title text NOT NULL CHECK (length(ticket_title) BETWEEN 1 AND 1000),
  ticket_size text NOT NULL CHECK (ticket_size IN ('XS','S','M')),
  depends_on jsonb NOT NULL CHECK (jsonb_typeof(depends_on) = 'array'),
  scope_paths jsonb NOT NULL CHECK (jsonb_typeof(scope_paths) = 'array'),
  acceptance jsonb NOT NULL CHECK (jsonb_typeof(acceptance) = 'array'),
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING','READY','RUNNING','WAITING_HUMAN','WAITING_GATEWAY',
      'PR_READY','ARCHIVED','FAILED','CANCELLED'
    )),
  ticket_task_id uuid REFERENCES managed_ticket_task(id),
  base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[a-f0-9]{7,64}$'),
  worktree_path text,
  output_commit text CHECK (output_commit IS NULL OR output_commit ~ '^[a-f0-9]{7,64}$'),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, graph_version, node_key),
  UNIQUE (workflow_id, graph_version, ticket_id),
  UNIQUE (ticket_task_id),
  FOREIGN KEY (workflow_id, graph_version)
    REFERENCES managed_workflow_graph(workflow_id, version)
);
CREATE INDEX managed_workflow_node_ready
  ON managed_workflow_node(workflow_id, status, updated_at);
CREATE UNIQUE INDEX managed_workflow_node_external_issue
  ON managed_workflow_node(workflow_id, graph_version, external_issue)
  WHERE external_issue IS NOT NULL;

CREATE TABLE managed_workflow_evidence (
  id uuid PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES managed_workflow(id),
  graph_version int NOT NULL,
  node_id uuid NOT NULL REFERENCES managed_workflow_node(id),
  source_node_id uuid REFERENCES managed_workflow_node(id),
  stage text NOT NULL CHECK (stage IN ('execute','verify','review','land','archive')),
  input_commit text NOT NULL CHECK (input_commit ~ '^[a-f0-9]{7,64}$'),
  diff_digest text NOT NULL CHECK (diff_digest ~ '^[a-f0-9]{64}$'),
  stage_digest text NOT NULL CHECK (stage_digest ~ '^[a-f0-9]{64}$'),
  branch text NOT NULL DEFAULT '',
  target_digest text NOT NULL CHECK (target_digest ~ '^[a-f0-9]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[a-f0-9]{64}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  result jsonb,
  evidence jsonb,
  status text NOT NULL DEFAULT 'VALID'
    CHECK (status IN ('VALID','INVALIDATED')),
  invalidated_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  FOREIGN KEY (workflow_id, graph_version)
    REFERENCES managed_workflow_graph(workflow_id, version)
);
CREATE UNIQUE INDEX managed_workflow_evidence_valid_target
  ON managed_workflow_evidence(workflow_id, stage, target_digest)
  WHERE status = 'VALID';
CREATE INDEX managed_workflow_evidence_node
  ON managed_workflow_evidence(node_id, stage, created_at DESC);

CREATE TABLE managed_workflow_event (
  seq bigserial PRIMARY KEY,
  workflow_id uuid NOT NULL REFERENCES managed_workflow(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_workflow_event_workflow ON managed_workflow_event(workflow_id, seq);

CREATE TABLE managed_issue_claim (
  id uuid PRIMARY KEY,
  repo_id uuid NOT NULL REFERENCES repo(id),
  issue_ref text NOT NULL CHECK (length(issue_ref) BETWEEN 1 AND 300),
  owner_kind text NOT NULL CHECK (owner_kind IN ('managed_workflow','managed_node')),
  owner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL))
);
CREATE UNIQUE INDEX managed_issue_claim_active
  ON managed_issue_claim(repo_id, issue_ref)
  WHERE status = 'ACTIVE';

ALTER TABLE managed_ticket_stage
  ADD COLUMN reused_from_evidence_id uuid REFERENCES managed_workflow_evidence(id);
ALTER TABLE managed_ticket_stage
  ADD COLUMN gate_digest text CHECK (gate_digest IS NULL OR gate_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE managed_ticket_stage DROP CONSTRAINT managed_ticket_stage_status_check;
ALTER TABLE managed_ticket_stage ADD CONSTRAINT managed_ticket_stage_status_check
  CHECK (status IN ('RUNNING','SUCCEEDED','REUSED','REWORK','FAILED','MUST_STOP'));

CREATE FUNCTION managed_workflow_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status IN ('DONE','FAILED','CANCELLED') THEN
    RAISE EXCEPTION 'managed workflow terminal record is immutable';
  END IF;
  IF NEW.repo_id <> OLD.repo_id
     OR NEW.package_digest <> OLD.package_digest
     OR NEW.repo_config_digest <> OLD.repo_config_digest
     OR NEW.baseline_commit <> OLD.baseline_commit
     OR NEW.worktree_root <> OLD.worktree_root
     OR NEW.request <> OLD.request
     OR NEW.scope_paths IS DISTINCT FROM OLD.scope_paths
     OR NEW.external_issue IS DISTINCT FROM OLD.external_issue
     OR NEW.completion_target <> OLD.completion_target THEN
    RAISE EXCEPTION 'managed workflow binding is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_workflow_guard
  BEFORE UPDATE ON managed_workflow
  FOR EACH ROW EXECUTE FUNCTION managed_workflow_guard();

CREATE FUNCTION managed_workflow_graph_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.workflow_id <> OLD.workflow_id
     OR NEW.version <> OLD.version
     OR NEW.plan_digest <> OLD.plan_digest
     OR NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.created_at <> OLD.created_at
     OR NEW.committed_at <> OLD.committed_at THEN
    RAISE EXCEPTION 'workflow graph identity is immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'COMMITTED' AND NEW.status = 'SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal workflow graph transition % -> %', OLD.status, NEW.status;
END
$$;
CREATE TRIGGER managed_workflow_graph_guard
  BEFORE UPDATE ON managed_workflow_graph
  FOR EACH ROW EXECUTE FUNCTION managed_workflow_graph_guard();

CREATE FUNCTION managed_workflow_node_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status IN ('ARCHIVED','CANCELLED') THEN
    RAISE EXCEPTION 'managed workflow node terminal record is immutable';
  END IF;
  IF OLD.status='FAILED' AND NEW.status<>'READY' THEN
    RAISE EXCEPTION 'failed workflow node can only be retried to READY';
  END IF;
  IF NEW.workflow_id <> OLD.workflow_id
     OR NEW.graph_version <> OLD.graph_version
     OR NEW.node_key <> OLD.node_key
     OR NEW.ticket_id <> OLD.ticket_id
     OR NEW.external_issue IS DISTINCT FROM OLD.external_issue
     OR NEW.ticket_title <> OLD.ticket_title
     OR NEW.ticket_size <> OLD.ticket_size
     OR NEW.depends_on IS DISTINCT FROM OLD.depends_on
     OR NEW.scope_paths IS DISTINCT FROM OLD.scope_paths
     OR NEW.acceptance IS DISTINCT FROM OLD.acceptance THEN
    RAISE EXCEPTION 'managed workflow node identity is immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER managed_workflow_node_guard
  BEFORE UPDATE ON managed_workflow_node
  FOR EACH ROW EXECUTE FUNCTION managed_workflow_node_guard();

GRANT SELECT, INSERT, UPDATE ON managed_workflow, managed_workflow_graph,
  managed_workflow_node, managed_workflow_evidence, managed_issue_claim TO keel_control;
GRANT SELECT, INSERT ON managed_workflow_event TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE managed_workflow_event_seq_seq TO keel_control;
-- keel_execution / keel_ingress 不读写这些编排队列表。

-- Down Migration

ALTER TABLE managed_ticket_stage DROP CONSTRAINT managed_ticket_stage_status_check;
UPDATE managed_ticket_stage SET status='SUCCEEDED' WHERE status='REUSED';
ALTER TABLE managed_ticket_stage ADD CONSTRAINT managed_ticket_stage_status_check
  CHECK (status IN ('RUNNING','SUCCEEDED','REWORK','FAILED','MUST_STOP'));
ALTER TABLE managed_ticket_stage DROP COLUMN gate_digest;
ALTER TABLE managed_ticket_stage DROP COLUMN reused_from_evidence_id;
DROP TRIGGER managed_workflow_node_guard ON managed_workflow_node;
DROP FUNCTION managed_workflow_node_guard();
DROP TRIGGER managed_workflow_graph_guard ON managed_workflow_graph;
DROP FUNCTION managed_workflow_graph_guard();
DROP TRIGGER managed_workflow_guard ON managed_workflow;
DROP FUNCTION managed_workflow_guard();
DROP TABLE managed_issue_claim;
DROP TABLE managed_workflow_event;
DROP TABLE managed_workflow_evidence;
DROP TABLE managed_workflow_node;
DROP TABLE managed_workflow_graph;
DROP TABLE managed_workflow;
