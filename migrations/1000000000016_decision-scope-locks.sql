-- Up Migration

-- keel_control 对决定/策略只有 SELECT、INSERT，不能直接 SELECT ... FOR SHARE。
-- 接纳器需要锁住当前作用域，和撤销/替代路径的 FOR UPDATE 串行化；因此把锁封装成
-- SECURITY DEFINER 单入口，调用者只获得“加锁”能力，不获得直接 UPDATE 权限。
CREATE FUNCTION managed_lock_decision_scope(target_project uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
  FROM managed_project_decision
  WHERE project_id = target_project
  FOR SHARE;

  PERFORM 1
  FROM managed_delegation_policy
  WHERE project_id = target_project
    AND revoked_at IS NULL
    AND superseded_by IS NULL
  FOR SHARE;
END
$$;

REVOKE ALL ON FUNCTION managed_lock_decision_scope(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION managed_lock_decision_scope(uuid) TO keel_control;

-- Down Migration
DROP FUNCTION managed_lock_decision_scope(uuid);
