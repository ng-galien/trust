CREATE TABLE trust_mobile_companion.post_templates (
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 16000),
  data_schema jsonb NOT NULL CHECK (jsonb_typeof(data_schema) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE TRIGGER templates_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.post_templates
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();

ALTER TABLE trust_mobile_companion.items ALTER COLUMN body DROP NOT NULL;
ALTER TABLE trust_mobile_companion.items
  ADD COLUMN template_id text,
  ADD COLUMN template_version integer,
  ADD COLUMN data jsonb,
  ADD COLUMN rendered_markdown text CHECK (length(btrim(rendered_markdown)) BETWEEN 1 AND 16000),
  ADD COLUMN rendered_sha256 text CHECK (rendered_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN renderer text,
  ADD COLUMN supersedes text REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  ADD CONSTRAINT items_supersedes_unique UNIQUE (supersedes),
  ADD CONSTRAINT items_source_xor CHECK (
    (body IS NOT NULL AND template_id IS NULL AND template_version IS NULL AND data IS NULL
      AND rendered_markdown IS NULL AND rendered_sha256 IS NULL AND renderer IS NULL)
    OR
    (body IS NULL AND template_id IS NOT NULL AND template_version IS NOT NULL AND data IS NOT NULL
      AND jsonb_typeof(data) = 'object' AND rendered_markdown IS NOT NULL
      AND rendered_sha256 IS NOT NULL AND renderer IS NOT NULL)
  ),
  ADD CONSTRAINT items_template_version_fk FOREIGN KEY (template_id, template_version)
    REFERENCES trust_mobile_companion.post_templates(id, version) ON DELETE RESTRICT;

CREATE FUNCTION trust_mobile_companion.validate_supersedes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes IS NOT NULL AND (
    NEW.supersedes = NEW.id OR
    NOT EXISTS (SELECT 1 FROM trust_mobile_companion.items
      WHERE id = NEW.supersedes AND project = NEW.project)
  ) THEN
    RAISE EXCEPTION 'Revision must supersede another item in the same project';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_supersedes BEFORE INSERT ON trust_mobile_companion.items
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.validate_supersedes();

CREATE TABLE trust_mobile_companion.article_versions (
  article_id text NOT NULL REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 500),
  raw_markdown text CHECK (length(btrim(raw_markdown)) BETWEEN 1 AND 16000),
  template_id text,
  template_version integer,
  data jsonb,
  rendered_markdown text CHECK (length(btrim(rendered_markdown)) BETWEEN 1 AND 16000),
  rendered_sha256 text CHECK (rendered_sha256 ~ '^[a-f0-9]{64}$'),
  renderer text,
  author text NOT NULL CHECK (length(btrim(author)) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  source_item text REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, version),
  CHECK (
    (raw_markdown IS NOT NULL AND template_id IS NULL AND template_version IS NULL AND data IS NULL
      AND rendered_markdown IS NULL AND rendered_sha256 IS NULL AND renderer IS NULL)
    OR
    (raw_markdown IS NULL AND template_id IS NOT NULL AND template_version IS NOT NULL AND data IS NOT NULL
      AND jsonb_typeof(data) = 'object' AND rendered_markdown IS NOT NULL
      AND rendered_sha256 IS NOT NULL AND renderer IS NOT NULL)
  ),
  FOREIGN KEY (template_id, template_version)
    REFERENCES trust_mobile_companion.post_templates(id, version) ON DELETE RESTRICT
);
CREATE TRIGGER article_versions_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.article_versions
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TABLE trust_mobile_companion.article_aliases (
  alias_id text PRIMARY KEY REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  article_id text NOT NULL REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  imported_version integer NOT NULL,
  FOREIGN KEY (article_id, imported_version)
    REFERENCES trust_mobile_companion.article_versions(article_id, version) ON DELETE RESTRICT,
  CHECK (alias_id <> article_id)
);
CREATE TRIGGER article_aliases_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.article_aliases
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
INSERT INTO trust_mobile_companion.article_versions
  (article_id,version,title,summary,raw_markdown,author,reason,source_item,published_at)
SELECT id,1,title,summary,body,'unknown','Imported from existing mobile feed',id,created_at
FROM trust_mobile_companion.items WHERE kind='explanation';

CREATE FUNCTION trust_mobile_companion.notify_feed_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('trust_mobile_companion_feed_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER projects_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.projects
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER items_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.items
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER forms_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.forms
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER form_fields_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.form_fields
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER form_options_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.form_options
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER responses_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.responses
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER response_values_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.response_values
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER article_versions_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.article_versions
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER article_aliases_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.article_aliases
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();

ALTER TABLE trust_mobile_companion.schema_version DROP CONSTRAINT schema_version_version_check;
UPDATE trust_mobile_companion.schema_version SET version = 3 WHERE version = 2;
ALTER TABLE trust_mobile_companion.schema_version
  ADD CONSTRAINT schema_version_version_check CHECK (version = 3);
