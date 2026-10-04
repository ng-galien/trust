-- TRUST core PostgreSQL schema: version 4 -> version 5 (Plan cancellation).
--
-- Adds the table plan_cancellations, its immutability trigger, and the refusal of a new Attempt or Plan
-- revision on a cancelled Plan in trust_require_active_plan(). Existing rows are not changed.
--
-- Apply once, on a verified backup, while no TRUST runtime is connected:
--   psql "$DATABASE_URL" --single-transaction --set ON_ERROR_STOP=1 --file packages/trust-runtime/migrations/postgres-v4-v5.sql
--
-- Guard: the whole upgrade is one transaction. It raises and changes nothing unless trust_schema holds exactly
-- version 4 with the version 4 digest below. It then records version 5 with the version 5 digest, which the
-- runtime verifies at start.
--   version 4 digest: d442d4a22238cd070afd8de8001f2c841d50a7f043adad722f7bfc93b7b81e5b
--   version 5 digest: 7b5cc1cc0fbe3e40ef7ffdb65298869d38235215996efb1d46ce25d4d2fe88f3

BEGIN;

SET LOCAL search_path = public, pg_catalog;

DO $migration$
DECLARE
  schema_rows INTEGER;
  current_version INTEGER;
  current_digest TEXT;
BEGIN
  SELECT count(*) INTO schema_rows FROM trust_schema;
  SELECT version, digest INTO current_version, current_digest FROM trust_schema WHERE singleton = 1 FOR UPDATE;
  IF schema_rows <> 1
    OR current_version IS DISTINCT FROM 4
    OR current_digest IS DISTINCT FROM 'd442d4a22238cd070afd8de8001f2c841d50a7f043adad722f7bfc93b7b81e5b' THEN
    RAISE EXCEPTION 'TRUST schema is not version 4 with the expected digest (found version %, digest %); nothing was changed',
      current_version, current_digest;
  END IF;

  CREATE TABLE plan_cancellations (
    plan_slug TEXT COLLATE "C" PRIMARY KEY REFERENCES plans(plan_slug) ON DELETE CASCADE,
    root_plan TEXT COLLATE "C" NOT NULL,
    cancelled_at TIMESTAMPTZ(3) NOT NULL,
    actor_issuer TEXT COLLATE "C",
    actor_subject TEXT COLLATE "C",
    CHECK ((actor_issuer IS NULL AND actor_subject IS NULL) OR (actor_issuer IS NOT NULL AND actor_subject IS NOT NULL AND length(actor_issuer) > 0 AND length(actor_subject) > 0)),
    reason TEXT COLLATE "C" NOT NULL CHECK (length(reason) BETWEEN 1 AND 4096)
  );

  CREATE TRIGGER plan_cancellations_cannot_change BEFORE UPDATE ON plan_cancellations
    FOR EACH ROW EXECUTE FUNCTION trust_refuse_immutable_update();

  CREATE OR REPLACE FUNCTION trust_require_active_plan() RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF EXISTS (SELECT 1 FROM plan_escalations WHERE plan_slug = NEW.plan_slug AND resumed_at IS NULL) THEN
      RAISE EXCEPTION 'Plan is escalated' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM plan_cancellations WHERE plan_slug = NEW.plan_slug) THEN
      RAISE EXCEPTION 'Plan is cancelled' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $function$;

  UPDATE trust_schema
    SET version = 5, digest = '7b5cc1cc0fbe3e40ef7ffdb65298869d38235215996efb1d46ce25d4d2fe88f3'
    WHERE singleton = 1;
END
$migration$;

COMMIT;
