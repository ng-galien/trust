-- Mutable organizational metadata, separate from immutable Plan labels and mission requests.
CREATE SCHEMA trust_coordination_classification;
CREATE SEQUENCE trust_coordination_classification.changes;
CREATE TABLE trust_coordination_classification.tags (
  mission text PRIMARY KEY REFERENCES trust_coordination.missions(mission),
  tags text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL CHECK (revision > 0),
  change_id bigint NOT NULL DEFAULT nextval('trust_coordination_classification.changes'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
