CREATE FUNCTION invalidate_document_reviews() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS DISTINCT FROM NEW.approved_at THEN
    DELETE FROM submission_approvals WHERE application_id IN (
      SELECT id FROM applications WHERE NEW.job_id IS NULL OR job_id=NEW.job_id
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER document_reviews ON documents;
CREATE TRIGGER document_reviews AFTER UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION invalidate_document_reviews();
