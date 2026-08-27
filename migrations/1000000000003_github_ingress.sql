-- GitHub Issue ingress: feedback.source 加 github + keel_ingress 角色。
--
-- 事实来源：docs/03-domain-model.md §4 外部 Ingress 列 = keel_ingress 角色。

-- Up Migration

ALTER TABLE feedback DROP CONSTRAINT feedback_source_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_source_check
  CHECK (source IN ('web', 'email', 'api', 'manual', 'github'));

DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keel_ingress') THEN
    CREATE ROLE keel_ingress NOLOGIN;
  END IF;
END
$role$;

DO $grant$
BEGIN
  EXECUTE format('GRANT keel_ingress TO %I', CURRENT_USER);
END
$grant$;

GRANT USAGE ON SCHEMA public TO keel_ingress;
GRANT SELECT, INSERT ON feedback TO keel_ingress;

-- Down Migration

REVOKE SELECT, INSERT ON feedback FROM keel_ingress;
REVOKE USAGE ON SCHEMA public FROM keel_ingress;

ALTER TABLE feedback DROP CONSTRAINT feedback_source_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_source_check
  CHECK (source IN ('web', 'email', 'api', 'manual'));
