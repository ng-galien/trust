CREATE SCHEMA trust_mobile_companion;
CREATE TABLE trust_mobile_companion.schema_version (
  version integer PRIMARY KEY CHECK (version = 5)
);
INSERT INTO trust_mobile_companion.schema_version VALUES (5);

CREATE TABLE trust_mobile_companion.push_keys (
  id integer PRIMARY KEY CHECK (id = 1),
  public_key text NOT NULL,
  private_key text NOT NULL
);
CREATE TABLE trust_mobile_companion.push_subscriptions (
  endpoint text PRIMARY KEY CHECK (length(endpoint) BETWEEN 1 AND 4096),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.push_deliveries (
  item text NOT NULL,
  endpoint text NOT NULL REFERENCES trust_mobile_companion.push_subscriptions(endpoint) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  PRIMARY KEY (item, endpoint)
);

CREATE TABLE trust_mobile_companion.projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(description) <= 1000),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'unavailable')),
  route text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.conversations (
  project text PRIMARY KEY REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  pinned boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.subjects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  project text NOT NULL REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.post_templates (
  id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 16000),
  data_schema jsonb NOT NULL CHECK (jsonb_typeof(data_schema) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);
CREATE TABLE trust_mobile_companion.items (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  project text NOT NULL REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('progress', 'explanation', 'question', 'decision', 'confirmation', 'review', 'document')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 500),
  body text CHECK (length(btrim(body)) BETWEEN 1 AND 16000),
  template_id text,
  template_version integer,
  data jsonb,
  rendered_markdown text CHECK (length(btrim(rendered_markdown)) BETWEEN 1 AND 16000),
  rendered_sha256 text CHECK (rendered_sha256 ~ '^[a-f0-9]{64}$'),
  renderer text,
  supersedes text REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  UNIQUE (supersedes),
  document_url text,
  plan text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'document') = (document_url IS NOT NULL)),
  CHECK (
    (body IS NOT NULL AND template_id IS NULL AND template_version IS NULL AND data IS NULL
      AND rendered_markdown IS NULL AND rendered_sha256 IS NULL AND renderer IS NULL)
    OR
    (body IS NULL AND template_id IS NOT NULL AND template_version IS NOT NULL AND data IS NOT NULL
      AND jsonb_typeof(data) = 'object' AND rendered_markdown IS NOT NULL
      AND rendered_sha256 IS NOT NULL AND renderer IS NOT NULL)
  ),
  FOREIGN KEY (template_id, template_version)
    REFERENCES trust_mobile_companion.post_templates(id, version) ON DELETE RESTRICT
);
ALTER TABLE trust_mobile_companion.push_deliveries ADD CONSTRAINT push_delivery_item
  FOREIGN KEY (item) REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT;
CREATE INDEX items_by_project_time ON trust_mobile_companion.items(project, created_at DESC, id DESC);
CREATE INDEX items_by_time ON trust_mobile_companion.items(created_at DESC, id DESC);

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
CREATE TABLE trust_mobile_companion.article_aliases (
  alias_id text PRIMARY KEY REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  article_id text NOT NULL REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  imported_version integer NOT NULL,
  FOREIGN KEY (article_id, imported_version)
    REFERENCES trust_mobile_companion.article_versions(article_id, version) ON DELETE RESTRICT,
  CHECK (alias_id <> article_id)
);

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

CREATE TABLE trust_mobile_companion.forms (
  item text PRIMARY KEY REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  ui_schema jsonb
);

CREATE TABLE trust_mobile_companion.form_fields (
  item text NOT NULL REFERENCES trust_mobile_companion.forms(item) ON DELETE RESTRICT,
  field_id text NOT NULL CHECK (field_id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 11),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 160),
  field_type text NOT NULL CHECK (field_type IN ('text', 'multiline', 'choice', 'boolean', 'number')),
  required boolean NOT NULL,
  minimum numeric,
  maximum numeric,
  CHECK ((field_type = 'number') OR (minimum IS NULL AND maximum IS NULL)),
  CHECK (minimum IS NULL OR maximum IS NULL OR minimum <= maximum),
  PRIMARY KEY (item, field_id),
  UNIQUE (item, position)
);
CREATE TABLE trust_mobile_companion.form_options (
  item text NOT NULL,
  field_id text NOT NULL,
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 160),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 19),
  PRIMARY KEY (item, field_id, value),
  UNIQUE (item, field_id, position),
  FOREIGN KEY (item, field_id) REFERENCES trust_mobile_companion.form_fields(item, field_id) ON DELETE RESTRICT
);
CREATE TABLE trust_mobile_companion.responses (
  item text PRIMARY KEY REFERENCES trust_mobile_companion.forms(item) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.response_values (
  item text NOT NULL REFERENCES trust_mobile_companion.responses(item) ON DELETE RESTRICT,
  field_id text NOT NULL,
  text_value text CHECK (text_value IS NULL OR length(text_value) BETWEEN 1 AND 8000),
  bool_value boolean,
  choice_value text,
  number_value numeric,
  PRIMARY KEY (item, field_id),
  CHECK ((text_value IS NOT NULL)::integer + (bool_value IS NOT NULL)::integer +
    (choice_value IS NOT NULL)::integer + (number_value IS NOT NULL)::integer = 1),
  FOREIGN KEY (item, field_id) REFERENCES trust_mobile_companion.form_fields(item, field_id) ON DELETE RESTRICT,
  FOREIGN KEY (item, field_id, choice_value) REFERENCES trust_mobile_companion.form_options(item, field_id, value) ON DELETE RESTRICT
);

CREATE FUNCTION trust_mobile_companion.validate_field() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_kind text;
BEGIN
  SELECT kind INTO item_kind FROM trust_mobile_companion.items WHERE id = NEW.item;
  IF item_kind NOT IN ('question', 'decision', 'confirmation', 'review') THEN
    RAISE EXCEPTION 'Forms require an interactive item';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_field_kind BEFORE INSERT OR UPDATE ON trust_mobile_companion.forms
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.validate_field();

CREATE FUNCTION trust_mobile_companion.validate_option() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trust_mobile_companion.form_fields
    WHERE item=NEW.item AND field_id=NEW.field_id AND field_type='choice') THEN
    RAISE EXCEPTION 'Options require a choice field';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER form_option_type BEFORE INSERT OR UPDATE ON trust_mobile_companion.form_options
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.validate_option();

CREATE FUNCTION trust_mobile_companion.validate_complete_form() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM trust_mobile_companion.form_fields WHERE item=NEW.item) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'Form requires 1 to 12 fields';
  END IF;
  IF EXISTS (
    SELECT 1 FROM trust_mobile_companion.form_fields f
    WHERE f.item=NEW.item AND f.field_type='choice' AND
      (SELECT count(*) FROM trust_mobile_companion.form_options o
        WHERE o.item=f.item AND o.field_id=f.field_id) NOT BETWEEN 2 AND 20
  ) THEN
    RAISE EXCEPTION 'Choice field requires 2 to 20 options';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER form_complete AFTER INSERT OR UPDATE ON trust_mobile_companion.forms
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION trust_mobile_companion.validate_complete_form();

CREATE FUNCTION trust_mobile_companion.validate_value() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
DECLARE field_minimum numeric;
DECLARE field_maximum numeric;
BEGIN
  SELECT field_type,minimum,maximum INTO kind,field_minimum,field_maximum FROM trust_mobile_companion.form_fields
    WHERE item=NEW.item AND field_id=NEW.field_id;
  IF (kind = 'boolean' AND NEW.bool_value IS NULL)
    OR (kind = 'choice' AND NEW.choice_value IS NULL)
    OR (kind = 'number' AND (NEW.number_value IS NULL OR
      (field_minimum IS NOT NULL AND NEW.number_value < field_minimum) OR
      (field_maximum IS NOT NULL AND NEW.number_value > field_maximum)))
    OR (kind IN ('text','multiline') AND NEW.text_value IS NULL) THEN
    RAISE EXCEPTION 'Response value does not match form field type';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER response_value_type BEFORE INSERT OR UPDATE ON trust_mobile_companion.response_values
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.validate_value();

CREATE FUNCTION trust_mobile_companion.validate_complete_response() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM trust_mobile_companion.form_fields WHERE item=NEW.item) THEN
    RAISE EXCEPTION 'Response requires a form';
  END IF;
  IF EXISTS (
    SELECT 1 FROM trust_mobile_companion.form_fields f
    WHERE f.item=NEW.item AND f.required AND NOT EXISTS (
      SELECT 1 FROM trust_mobile_companion.response_values v
      WHERE v.item=f.item AND v.field_id=f.field_id
    )
  ) THEN
    RAISE EXCEPTION 'Required response value is absent';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER response_complete AFTER INSERT OR UPDATE ON trust_mobile_companion.responses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION trust_mobile_companion.validate_complete_response();

CREATE FUNCTION trust_mobile_companion.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mobile interactions are append-only';
END $$;
CREATE TRIGGER items_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.items
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER templates_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.post_templates
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER article_versions_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.article_versions
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER article_aliases_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.article_aliases
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER forms_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.forms
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER fields_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.form_fields
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER options_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.form_options
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER responses_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.responses
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();
CREATE TRIGGER values_immutable BEFORE UPDATE OR DELETE ON trust_mobile_companion.response_values
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.refuse_change();

CREATE FUNCTION trust_mobile_companion.notify_feed_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('trust_mobile_companion_feed_changed', '');
  RETURN NULL;
END $$;
CREATE TRIGGER projects_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.projects
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER conversations_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.conversations
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER subjects_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.subjects
  FOR EACH ROW EXECUTE FUNCTION trust_mobile_companion.notify_feed_changed();
CREATE TRIGGER subject_links_changed AFTER INSERT OR UPDATE OR DELETE ON trust_mobile_companion.subject_links
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
