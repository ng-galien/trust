CREATE TABLE trust_mobile_companion.subjects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  project text NOT NULL REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.subject_links (
  subject text NOT NULL REFERENCES trust_mobile_companion.subjects(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  kind text NOT NULL CHECK (kind IN ('article', 'document', 'plan', 'decision')),
  relation text NOT NULL CHECK (length(btrim(relation)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  item text NOT NULL REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  target_identity text NOT NULL CHECK (length(btrim(target_identity)) BETWEEN 1 AND 2048),
  provenance text NOT NULL CHECK (length(btrim(provenance)) BETWEEN 1 AND 500),
  PRIMARY KEY (subject,id),
  UNIQUE (subject,position)
);
CREATE TRIGGER subjects_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.subjects
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER subject_links_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.subject_links
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
ALTER TABLE trust_mobile_companion.schema_version DROP CONSTRAINT schema_version_version_check;
UPDATE trust_mobile_companion.schema_version SET version = 5 WHERE version = 4;
ALTER TABLE trust_mobile_companion.schema_version
  ADD CONSTRAINT schema_version_version_check CHECK (version = 5);
