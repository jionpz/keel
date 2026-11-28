-- Up Migration

ALTER TABLE managed_check_target
  ADD COLUMN failure_kind text CHECK (failure_kind IN ('CHECK_RED','CHECK_TIMEOUT','BLOCKED')),
  ADD COLUMN reobserve_deadline_at timestamptz;

CREATE OR REPLACE FUNCTION managed_check_target_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'status','lease_token','lease_until','attempts','next_attempt_at','last_observed_at',
        'evidence_digest','last_error','updated_at','failure_kind','reobserve_deadline_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'status','lease_token','lease_until','attempts','next_attempt_at','last_observed_at',
        'evidence_digest','last_error','updated_at','failure_kind','reobserve_deadline_at'
      ]) THEN
    RAISE EXCEPTION 'check target binding is immutable';
  END IF;
  IF OLD.status = 'FAILED' AND NEW.status = 'CHECKING'
     AND OLD.reobserve_deadline_at IS NULL AND NEW.reobserve_deadline_at > NEW.updated_at THEN
    RETURN NEW;
  END IF;
  IF NEW.reobserve_deadline_at IS DISTINCT FROM OLD.reobserve_deadline_at THEN
    RAISE EXCEPTION 'check target reobservation budget is immutable after use';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'PENDING' AND NEW.status IN ('CHECKING','FAILED'))
     OR (OLD.status = 'CHECKING' AND NEW.status IN ('READY','FAILED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal check target transition % -> %', OLD.status, NEW.status;
END
$$;

-- Down Migration

CREATE OR REPLACE FUNCTION managed_check_target_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY[
        'status','lease_token','lease_until','attempts','next_attempt_at','last_observed_at',
        'evidence_digest','last_error','updated_at'
      ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
        'status','lease_token','lease_until','attempts','next_attempt_at','last_observed_at',
        'evidence_digest','last_error','updated_at'
      ]) THEN
    RAISE EXCEPTION 'check target binding is immutable';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'PENDING' AND NEW.status IN ('CHECKING','FAILED'))
     OR (OLD.status = 'CHECKING' AND NEW.status IN ('READY','FAILED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal check target transition % -> %', OLD.status, NEW.status;
END
$$;

ALTER TABLE managed_check_target
  DROP COLUMN reobserve_deadline_at,
  DROP COLUMN failure_kind;
