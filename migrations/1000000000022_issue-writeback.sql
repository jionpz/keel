-- Up Migration
ALTER TABLE repo ADD COLUMN issue_writeback text NOT NULL DEFAULT 'off'
  CHECK (issue_writeback IN ('off', 'comment', 'comment_and_close'));

CREATE TABLE issue_delivery (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES task(id),
  repo_id uuid NOT NULL REFERENCES repo(id),
  remote_url text NOT NULL,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  event_name text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  body text NOT NULL,
  close_reason text CHECK (close_reason IN ('completed', 'not_planned')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at timestamptz,
  comment_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON issue_delivery TO keel_control;
GRANT USAGE, SELECT ON SEQUENCE issue_delivery_id_seq TO keel_control;

-- Down Migration
DROP TABLE issue_delivery;
ALTER TABLE repo DROP COLUMN issue_writeback;
