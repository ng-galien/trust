CREATE SCHEMA trust_mobile_companion;
CREATE TABLE trust_mobile_companion.schema_version (
  version integer PRIMARY KEY CHECK (version = 1)
);
INSERT INTO trust_mobile_companion.schema_version VALUES (1);

CREATE TABLE trust_mobile_companion.projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  description text NOT NULL CHECK (length(description) <= 1000),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'unavailable')),
  route text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trust_mobile_companion.items (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9._:-]*$'),
  project text NOT NULL REFERENCES trust_mobile_companion.projects(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('progress', 'explanation', 'question', 'decision', 'confirmation', 'review', 'document')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 500),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 16000),
  document_url text,
  plan text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'document') = (document_url IS NOT NULL))
);
CREATE INDEX items_by_project_time ON trust_mobile_companion.items(project, created_at DESC, id DESC);
CREATE INDEX items_by_time ON trust_mobile_companion.items(created_at DESC, id DESC);

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
