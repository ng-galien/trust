CREATE TABLE trust_mobile_companion.conversations (
  project text PRIMARY KEY REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  pinned boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER conversations_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.conversations
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();

ALTER TABLE trust_mobile_companion.schema_version DROP CONSTRAINT schema_version_version_check;
UPDATE trust_mobile_companion.schema_version SET version = 4 WHERE version = 3;
ALTER TABLE trust_mobile_companion.schema_version
  ADD CONSTRAINT schema_version_version_check CHECK (version = 4);
