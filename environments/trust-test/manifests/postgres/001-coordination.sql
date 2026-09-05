CREATE SCHEMA IF NOT EXISTS trust_coordination;

CREATE TABLE IF NOT EXISTS trust_coordination.claims (
  resource text PRIMARY KEY CHECK (resource <> ''),
  owner text NOT NULL CHECK (owner <> ''),
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

COMMENT ON TABLE trust_coordination.claims IS
  'Atomic ownership markers shared by agent Operations.';
