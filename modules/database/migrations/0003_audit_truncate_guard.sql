CREATE TRIGGER audit_events_append_only_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();
