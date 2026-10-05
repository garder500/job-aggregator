ALTER TABLE connectors ADD COLUMN submission_mode text NOT NULL DEFAULT 'review_required' CHECK(submission_mode IN ('review_required','automatic'));
ALTER TABLE documents ADD COLUMN viewed_at timestamptz;
CREATE TABLE operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, idempotency_key text UNIQUE NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE operation_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL REFERENCES operations(id), application_id uuid REFERENCES applications(id), job_id uuid REFERENCES jobs(id), state text NOT NULL DEFAULT 'queued', message text, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE submission_approvals (application_id uuid PRIMARY KEY REFERENCES applications(id), snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE diagnostics (integration text PRIMARY KEY, state text NOT NULL, message text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE maintenance (id boolean PRIMARY KEY DEFAULT true CHECK(id), active boolean NOT NULL DEFAULT false);
INSERT INTO maintenance DEFAULT VALUES;
CREATE TABLE operational_checks (kind text PRIMARY KEY, state text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION invalidate_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='profiles' THEN
    DELETE FROM submission_approvals;
  ELSIF TG_TABLE_NAME='jobs' THEN
    IF OLD.data IS DISTINCT FROM NEW.data THEN
      UPDATE documents SET approved_at=NULL,viewed_at=NULL WHERE job_id=NEW.id;
      DELETE FROM submission_approvals WHERE application_id IN (SELECT id FROM applications WHERE job_id=NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='connectors' THEN
    IF (OLD.config,OLD.enabled,OLD.authorized,OLD.auto_submit,OLD.submission_mode) IS DISTINCT FROM (NEW.config,NEW.enabled,NEW.authorized,NEW.auto_submit,NEW.submission_mode) THEN
      DELETE FROM submission_approvals WHERE application_id IN (SELECT id FROM applications WHERE connector_id=NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME='documents' THEN
    IF OLD.approved_at IS DISTINCT FROM NEW.approved_at THEN
      DELETE FROM submission_approvals WHERE application_id IN (SELECT id FROM applications WHERE NEW.job_id IS NULL OR job_id=NEW.job_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_reviews AFTER INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION invalidate_reviews();
CREATE TRIGGER job_reviews AFTER UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION invalidate_reviews();
CREATE TRIGGER connector_reviews AFTER UPDATE ON connectors FOR EACH ROW EXECUTE FUNCTION invalidate_reviews();
CREATE TRIGGER document_reviews AFTER UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION invalidate_reviews();
