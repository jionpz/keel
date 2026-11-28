-- Up Migration
ALTER TABLE repo ADD COLUMN verification_contract jsonb;
ALTER TABLE managed_ticket_task ADD COLUMN project_verification jsonb;
ALTER TABLE managed_workflow ADD COLUMN verification_contract jsonb;
ALTER TABLE task ADD COLUMN project_verification jsonb;
ALTER TABLE managed_action_intent ADD COLUMN project_required_checks jsonb;

-- Down Migration
ALTER TABLE managed_action_intent DROP COLUMN project_required_checks;
ALTER TABLE task DROP COLUMN project_verification;
ALTER TABLE managed_workflow DROP COLUMN verification_contract;
ALTER TABLE managed_ticket_task DROP COLUMN project_verification;
ALTER TABLE repo DROP COLUMN verification_contract;
