-- External delegation business state. TRUST owns qualification separately.
CREATE SCHEMA IF NOT EXISTS trust_coordination;
CREATE TABLE IF NOT EXISTS trust_coordination.missions (
  mission text PRIMARY KEY CHECK (mission <> ''),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  owner text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'completed', 'blocked')),
  response text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state = 'pending' AND owner IS NULL) OR (state <> 'pending' AND owner IS NOT NULL)),
  CHECK ((state IN ('pending', 'claimed') AND response = '') OR (state IN ('completed', 'blocked') AND length(btrim(response)) > 0))
);
CREATE TABLE IF NOT EXISTS trust_coordination.mission_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission text NOT NULL REFERENCES trust_coordination.missions(mission),
  event text NOT NULL CHECK (event IN ('created', 'relaunched', 'claimed', 'completed', 'blocked')),
  actor text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- These functions run as the caller, not SECURITY DEFINER. Actor values correlate
-- a trusted host's agents; they are not authentication credentials.
CREATE OR REPLACE FUNCTION trust_coordination.mission_view(m trust_coordination.missions)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'mission', m.mission, 'plan', m.request->>'plan',
    'assignee', m.request->>'assignee', 'owner', coalesce(m.owner, ''),
    'state', m.state, 'instructions', m.request->>'instructions',
    'project', m.request->>'project', 'expected', m.request->>'expected',
    'authorized', m.request->>'authorized', 'forbidden', m.request->>'forbidden',
    'response', m.response
  )
$$;

CREATE OR REPLACE FUNCTION trust_coordination.mission_create(input jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m trust_coordination.missions; k text;
BEGIN
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(input) key)
     IS DISTINCT FROM ARRAY['assignee','authorized','expected','forbidden','instructions','mission','plan','project'] THEN
    RAISE EXCEPTION 'Mission request fields do not match the contract';
  END IF;
  FOREACH k IN ARRAY ARRAY['mission','plan','assignee','project','instructions','expected','authorized','forbidden'] LOOP
    IF jsonb_typeof(input->k) IS DISTINCT FROM 'string' OR length(btrim(input->>k)) = 0 THEN
      RAISE EXCEPTION 'Mission field % must be a non-empty string', k;
    END IF;
  END LOOP;
  INSERT INTO trust_coordination.missions(mission, request)
    VALUES(input->>'mission', input) ON CONFLICT DO NOTHING RETURNING * INTO m;
  IF FOUND THEN
    INSERT INTO trust_coordination.mission_events(mission,event,actor) VALUES(m.mission,'created','coordinator');
  ELSE
    SELECT * INTO STRICT m FROM trust_coordination.missions WHERE mission = input->>'mission' FOR UPDATE;
    IF m.request <> input THEN
      -- A relaunched TRUST invocation generation replays the identical request from its new child Plan.
      -- TRUST refuses every admission in the abandoned generation, so the mission follows the new Plan
      -- and keeps its state, owner and history.
      IF (m.request - 'plan') <> (input - 'plan') THEN
        RAISE EXCEPTION 'Mission identifier already has a different request';
      END IF;
      UPDATE trust_coordination.missions SET request = input, updated_at = clock_timestamp()
        WHERE mission = m.mission RETURNING * INTO m;
      INSERT INTO trust_coordination.mission_events(mission,event,actor) VALUES(m.mission,'relaunched','coordinator');
    END IF;
  END IF;
  RETURN trust_coordination.mission_view(m);
END $$;

CREATE OR REPLACE FUNCTION trust_coordination.mission_claim(input jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m trust_coordination.missions;
BEGIN
  SELECT * INTO STRICT m FROM trust_coordination.missions WHERE mission = input->>'mission' FOR UPDATE;
  IF input->>'actor' IS DISTINCT FROM m.request->>'assignee' THEN
    RAISE EXCEPTION 'Only the assigned agent may claim the mission';
  END IF;
  IF m.state = 'pending' THEN
    UPDATE trust_coordination.missions SET owner=input->>'actor', state='claimed', updated_at=clock_timestamp()
      WHERE mission=m.mission RETURNING * INTO m;
    INSERT INTO trust_coordination.mission_events(mission,event,actor) VALUES(m.mission,'claimed',m.owner);
  END IF;
  RETURN trust_coordination.mission_view(m);
END $$;

CREATE OR REPLACE FUNCTION trust_coordination.mission_submit(input jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m trust_coordination.missions;
BEGIN
  SELECT * INTO STRICT m FROM trust_coordination.missions WHERE mission = input->>'mission' FOR UPDATE;
  IF m.owner IS NULL OR input->>'actor' IS DISTINCT FROM m.owner THEN
    RAISE EXCEPTION 'Only the mission owner may submit a response';
  END IF;
  IF coalesce(input->>'outcome','') NOT IN ('completed','blocked')
     OR jsonb_typeof(input->'response') IS DISTINCT FROM 'string' OR length(btrim(input->>'response')) = 0 THEN
    RAISE EXCEPTION 'A response and a completed or blocked outcome are required';
  END IF;
  IF m.state IN ('completed','blocked') THEN
    IF m.state <> input->>'outcome' OR m.response <> input->>'response' THEN
      RAISE EXCEPTION 'The submitted response is immutable';
    END IF;
  ELSE
    UPDATE trust_coordination.missions SET response=input->>'response', state=input->>'outcome', updated_at=clock_timestamp()
      WHERE mission=m.mission RETURNING * INTO m;
    INSERT INTO trust_coordination.mission_events(mission,event,actor) VALUES(m.mission,m.state,m.owner);
  END IF;
  RETURN trust_coordination.mission_view(m);
END $$;

CREATE OR REPLACE FUNCTION trust_coordination.mission_read(input jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE m trust_coordination.missions;
BEGIN
  SELECT * INTO STRICT m FROM trust_coordination.missions WHERE mission = input->>'mission';
  RETURN trust_coordination.mission_view(m);
END $$;
