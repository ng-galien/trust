-- Mutable organizational metadata within the delegation schema.
CREATE SEQUENCE trust_coordination.changes;
CREATE TABLE trust_coordination.tags (
  mission text PRIMARY KEY REFERENCES trust_coordination.missions(mission),
  tags text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL CHECK (revision > 0),
  change_id bigint NOT NULL DEFAULT nextval('trust_coordination.changes'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
