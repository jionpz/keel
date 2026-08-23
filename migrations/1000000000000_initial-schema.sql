-- 初始 schema。
--
-- 事实来源：docs/03-domain-model.md
-- 本文件（含 GRANT）是 schema 的事实来源 —— 没有任何 TS ORM 能忠实建模授权，
-- 而本 schema 最重要的特性恰恰是授权。
--
-- 核心：docs/03-domain-model.md §3 的不变量 I1/I2/I3/I5/I6/I8 在此被**数据库强制**，
-- 而不是靠应用层自觉。§4 的写权限矩阵逐格对应下方的 GRANT。

-- Up Migration

-- ─────────────────────────────── 角色 ───────────────────────────────
-- 集群级对象，且 Postgres 不支持 CREATE ROLE IF NOT EXISTS，故用 DO 块。
-- NOLOGIN：应用以实际用户连接后 SET ROLE，避免为每个角色管理密码。

DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_control') THEN
    CREATE ROLE keel_control NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_execution') THEN
    CREATE ROLE keel_execution NOLOGIN;
  END IF;
END
$role$;

-- 让当前用户可以 SET ROLE 到这两个角色
DO $grant$
BEGIN
  EXECUTE format('GRANT keel_control, keel_execution TO %I', CURRENT_USER);
END
$grant$;

-- 默认拒绝：撤销 PUBLIC 的默认权限，避免意外放行
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO keel_control, keel_execution;

-- ─────────────────────────────── 表 ───────────────────────────────

CREATE TABLE repo (
  id              uuid PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('github', 'gitlab', 'local')),
  remote_url      text NOT NULL,
  default_branch  text NOT NULL,
  -- 指向密钥管理的引用，绝不存明文凭据（docs/08-cross-cutting.md §1.3）
  credential_ref  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 不可变原始输入（I6）
CREATE TABLE feedback (
  id            uuid PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('web', 'email', 'api', 'manual')),
  external_ref  text NOT NULL,
  -- ⚠️ 不可信输入，是 prompt injection 的主要入口
  body          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_ref)
);

-- Task 级状态机的宿主
CREATE TABLE task (
  id              uuid PRIMARY KEY,
  -- 15 个状态，与 src/shared/ids.ts 一致（由漂移测试比对）
  status          text NOT NULL CHECK (status IN (
                    'S-NEW', 'S-PM_ANALYZING', 'S-NEED_CLARIFICATION', 'S-BRAINSTORM',
                    'S-RFC_DRAFT', 'S-RFC_READY', 'S-HUMAN_REVIEW', 'S-DEVELOPING',
                    'S-QA', 'S-REVIEW', 'S-PR_OPEN',
                    'S-DONE', 'S-REJECTED', 'S-ABANDONED', 'S-FAILED')),
  -- 与 status 正交的维度：status 说业务走到哪，control_mode 说谁在驾驶
  control_mode    text NOT NULL DEFAULT 'auto' CHECK (control_mode IN ('auto', 'paused', 'human')),
  title           text NOT NULL,
  repo_id         uuid NOT NULL REFERENCES repo(id),
  base_branch     text NOT NULL,
  work_branch     text NOT NULL,
  risk            text CHECK (risk IN ('low', 'medium', 'high')),
  complexity      text CHECK (complexity IN ('low', 'medium', 'high')),
  budget_usd      numeric,
  current_run_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- 非空表示已到达终态；I8 触发器据此禁止后续 UPDATE
  terminal_at     timestamptz
);

CREATE TABLE task_feedback (
  task_id      uuid NOT NULL REFERENCES task(id),
  feedback_id  uuid NOT NULL REFERENCES feedback(id),
  PRIMARY KEY (task_id, feedback_id)
);

-- Run 级状态机的宿主。在其 Session 销毁后依然存在 —— 这正是失败可追溯的原因
CREATE TABLE run (
  id               uuid PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES task(id),
  stage            text NOT NULL CHECK (stage IN (
                     'pm', 'brainstorm', 'critic', 'rfc_draft', 'develop', 'qa', 'review')),
  role             text NOT NULL,
  attempt          int  NOT NULL CHECK (attempt >= 1),
  status           text NOT NULL CHECK (status IN (
                     'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED')),
  harness_id       text,
  harness_tier     text CHECK (harness_tier IN ('L0', 'L1', 'L2')),
  session_ref      text,
  -- I3：重放安全的落点。相同 key 的副作用至多发生一次
  idempotency_key  text NOT NULL UNIQUE,
  started_at       timestamptz,
  ended_at         timestamptz,
  error_kind       text,
  error_detail     text,
  tokens_in        bigint,
  tokens_out       bigint,
  cost_usd         numeric,
  -- 成本口径三态。禁止用 0 冒充 unavailable —— 两者在核算里是不同的事实
  cost_basis       text CHECK (cost_basis IN ('billed', 'estimated', 'unavailable')),
  UNIQUE (task_id, stage, attempt)
);

-- append-only 事件流。一表四用：审计 / 重放 / 可观测 / State 投影源
CREATE TABLE event (
  seq          bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES task(id),
  run_id       uuid REFERENCES run(id),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id     text,
  span_id      text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- 统一多态产物表（ADR-0004）。单表的理由：统一寻址、统一版本语义、
-- 以及最重要的 —— 单一写入路径，才好用授权把 I5 钉死
CREATE TABLE artifact (
  id               uuid PRIMARY KEY,
  task_id          uuid NOT NULL REFERENCES task(id),
  -- 7 个 kind。event 不在此列 —— 它有独立的表
  kind             text NOT NULL CHECK (kind IN (
                     'state', 'rfc', 'checkpoint', 'stage_outcome',
                     'critic_review', 'policy_decision', 'capability_request')),
  key              text NOT NULL DEFAULT '',
  version          int  NOT NULL CHECK (version >= 1),
  schema_version   text NOT NULL,
  body             jsonb NOT NULL,
  produced_by_run  uuid REFERENCES run(id),
  committed_at     timestamptz NOT NULL DEFAULT now(),
  -- getAsOf() 的支撑列。
  -- 不能用 committed_at 近似：event.seq 是全局单调的逻辑序，committed_at 是墙上时钟，
  -- 并发写入下两者会不一致 —— 而重放依赖的是 seq
  committed_at_seq bigint NOT NULL REFERENCES event(seq),
  superseded_by    uuid REFERENCES artifact(id),
  UNIQUE (task_id, kind, key, version)
);

-- ─────────────────────────── I8：终态不可变 ───────────────────────────

CREATE FUNCTION keel_reject_terminal_update() RETURNS trigger AS $fn$
BEGIN
  IF OLD.terminal_at IS NOT NULL THEN
    RAISE EXCEPTION 'I8 violated: task % 已于 % 到达终态，不可再修改',
      OLD.id, OLD.terminal_at
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER task_terminal_immutable
  BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION keel_reject_terminal_update();

-- ──────────────── 产物提交：唯一能写 superseded_by 的路径 ────────────────
--
-- 矛盾：I2 要求 artifact 只增不改（不授予 UPDATE），
--       但「新版取代旧版」需要回填旧行的 superseded_by。
--
-- 解法：SECURITY DEFINER 函数。属主有 UPDATE 权限，调用者没有 ——
-- 于是唯一能改 superseded_by 的路径就是这个函数，而它只做这一件事。
-- 这比「授予 UPDATE 然后指望大家只用来回填」强得多。

CREATE FUNCTION keel_commit_artifact(
  p_id               uuid,
  p_task_id          uuid,
  p_kind             text,
  p_key              text,
  p_version          int,
  p_schema_version   text,
  p_body             jsonb,
  p_produced_by_run  uuid,
  p_committed_at_seq bigint,
  p_supersedes       uuid
) RETURNS uuid AS $fn$
DECLARE
  v_current uuid;
BEGIN
  -- 硬检查一：supersedes 必须指向当前最新版（docs/05-contracts/artifact-store.md §1.1）
  IF p_supersedes IS NOT NULL THEN
    SELECT id INTO v_current
    FROM artifact
    WHERE task_id = p_task_id AND kind = p_kind AND key = p_key AND superseded_by IS NULL
    ORDER BY version DESC
    LIMIT 1;

    IF v_current IS NULL OR v_current <> p_supersedes THEN
      RAISE EXCEPTION 'CONFLICT: supersedes % 不是当前最新版（当前为 %）', p_supersedes, v_current
        USING ERRCODE = 'serialization_failure';
    END IF;
  END IF;

  -- 硬检查二：版本未被占用 —— 由 UNIQUE (task_id, kind, key, version) 兜底

  INSERT INTO artifact (
    id, task_id, kind, key, version, schema_version, body,
    produced_by_run, committed_at_seq, superseded_by
  ) VALUES (
    p_id, p_task_id, p_kind, p_key, p_version, p_schema_version, p_body,
    p_produced_by_run, p_committed_at_seq, NULL
  );

  IF p_supersedes IS NOT NULL THEN
    UPDATE artifact SET superseded_by = p_id WHERE id = p_supersedes;
  END IF;

  RETURN p_id;
END
$fn$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION keel_commit_artifact FROM PUBLIC;
GRANT EXECUTE ON FUNCTION keel_commit_artifact TO keel_control;

-- ─────────────────────────────── 索引 ───────────────────────────────
-- 依据 docs/03-domain-model.md §5

CREATE INDEX artifact_latest_idx ON artifact (task_id, kind, key, version DESC);
CREATE INDEX artifact_as_of_idx  ON artifact (task_id, kind, key, committed_at_seq);
CREATE INDEX event_replay_idx    ON event (task_id, seq);
CREATE INDEX run_stuck_idx       ON run (status, started_at) WHERE status = 'RUNNING';
CREATE INDEX run_cost_idx        ON run (task_id);

-- ──────────────────── 写权限矩阵（docs/03-domain-model.md §4）────────────────────
--
-- 矩阵中不存在「Execution Plane 可写 Fact Plane」的格子。
-- 这不是疏漏，是本架构的定义性约束。
--
-- 注意 keel_control 对 artifact / event 也只有 INSERT，没有 UPDATE / DELETE ——
-- 这就是 I1 / I2 的强制方式。

GRANT SELECT                 ON repo          TO keel_control, keel_execution;
GRANT SELECT                 ON feedback      TO keel_control;   -- I6：无 UPDATE / DELETE
GRANT SELECT, INSERT, UPDATE ON task          TO keel_control;
GRANT SELECT, INSERT         ON task_feedback TO keel_control;
GRANT SELECT, INSERT, UPDATE ON run           TO keel_control;
GRANT SELECT                 ON run           TO keel_execution;
GRANT SELECT, INSERT         ON artifact      TO keel_control;   -- I2：无 UPDATE / DELETE
GRANT SELECT, INSERT         ON event         TO keel_control;   -- I1：无 UPDATE / DELETE
GRANT USAGE                  ON SEQUENCE event_seq_seq TO keel_control;

-- keel_execution 对 feedback / task / task_feedback / artifact / event 一律无权限（I5）。
-- 它看到的一切都经由 Context Builder —— 这既是 token 控制，
-- 也是防止 Agent 绕过上下文预算去「自己翻库」。

-- Down Migration

DROP TABLE IF EXISTS artifact;
DROP TABLE IF EXISTS event;
DROP TABLE IF EXISTS run;
DROP TABLE IF EXISTS task_feedback;
DROP TABLE IF EXISTS task;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS repo;
DROP FUNCTION IF EXISTS keel_commit_artifact;
DROP FUNCTION IF EXISTS keel_reject_terminal_update CASCADE;
