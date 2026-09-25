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
  item text NOT NULL REFERENCES trust_mobile_companion.items(id) ON DELETE RESTRICT,
  endpoint text NOT NULL REFERENCES trust_mobile_companion.push_subscriptions(endpoint) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  PRIMARY KEY (item, endpoint)
);
ALTER TABLE trust_mobile_companion.schema_version DROP CONSTRAINT schema_version_version_check;
UPDATE trust_mobile_companion.schema_version SET version = 2 WHERE version = 1;
ALTER TABLE trust_mobile_companion.schema_version ADD CONSTRAINT schema_version_version_check CHECK (version = 2);
