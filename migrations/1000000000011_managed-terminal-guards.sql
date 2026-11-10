-- Up Migration
ALTER TABLE managed_task ADD COLUMN failures int NOT NULL DEFAULT 0 CHECK (failures >= 0);

CREATE FUNCTION keel_guard_managed_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_TABLE_NAME='managed_task' AND OLD.status IN ('DONE','FAILED','CANCELLED'))
     OR (TG_TABLE_NAME='managed_attempt' AND OLD.status <> 'RUNNING')
     OR (TG_TABLE_NAME='managed_question' AND OLD.status='RESOLVED') THEN
    RAISE EXCEPTION 'managed terminal record is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER managed_task_terminal BEFORE UPDATE ON managed_task
  FOR EACH ROW EXECUTE FUNCTION keel_guard_managed_terminal();
CREATE TRIGGER managed_attempt_terminal BEFORE UPDATE ON managed_attempt
  FOR EACH ROW EXECUTE FUNCTION keel_guard_managed_terminal();
CREATE TRIGGER managed_question_terminal BEFORE UPDATE ON managed_question
  FOR EACH ROW EXECUTE FUNCTION keel_guard_managed_terminal();

-- Down Migration
DROP TRIGGER managed_question_terminal ON managed_question;
DROP TRIGGER managed_attempt_terminal ON managed_attempt;
DROP TRIGGER managed_task_terminal ON managed_task;
DROP FUNCTION keel_guard_managed_terminal();
ALTER TABLE managed_task DROP COLUMN failures;
