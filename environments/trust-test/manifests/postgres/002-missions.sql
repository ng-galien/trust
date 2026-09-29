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

-- Independent review checklist of one mission: the reviewer states one verdict with evidence per declared rule and
-- per contract criterion. The database refuses a review by the assignee and a malformed checklist, then counts what
-- is missing; the verdicts remain the named reviewer's statements.
CREATE TABLE IF NOT EXISTS trust_coordination.reviews (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mission text NOT NULL REFERENCES trust_coordination.missions(mission),
  reviewer text NOT NULL CHECK (reviewer <> ''),
  checklist jsonb NOT NULL CHECK (jsonb_typeof(checklist) = 'array'),
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION trust_coordination.review_record(input jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  m trust_coordination.missions; k text; items jsonb; item jsonb;
  rules text[]; criteria text[]; subjects text[] := '{}'; result jsonb;
BEGIN
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(input) key)
     IS DISTINCT FROM ARRAY['checklist','contract','mission','reviewer','rules'] THEN
    RAISE EXCEPTION 'Review fields do not match the contract';
  END IF;
  FOREACH k IN ARRAY ARRAY['mission','reviewer','rules','contract','checklist'] LOOP
    IF jsonb_typeof(input->k) IS DISTINCT FROM 'string' OR length(btrim(input->>k)) = 0 THEN
      RAISE EXCEPTION 'Review field % must be a non-empty string', k;
    END IF;
  END LOOP;
  SELECT * INTO STRICT m FROM trust_coordination.missions WHERE mission = input->>'mission';
  IF input->>'reviewer' = m.request->>'assignee' THEN
    RAISE EXCEPTION 'The assignee cannot review its own mission';
  END IF;
  rules := regexp_split_to_array(btrim(input->>'rules'), '\s+');
  SELECT coalesce(array_agg(value), '{}') INTO criteria
    FROM jsonb_array_elements_text((input->>'contract')::jsonb->'requirements');
  items := (input->>'checklist')::jsonb->'items';
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items) = 0 THEN
    RAISE EXCEPTION 'The checklist must be an object with a non-empty items array';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
       IS DISTINCT FROM ARRAY['evidence','subject','verdict']
       OR item->>'verdict' NOT IN ('pass','fail')
       OR jsonb_typeof(item->'evidence') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Each checklist item has exactly a subject, a pass or fail verdict and an evidence string';
    END IF;
    IF NOT ((item->>'subject') = ANY (SELECT 'rule:' || r FROM unnest(rules) r)
            OR (item->>'subject') = ANY (SELECT 'criterion:' || c FROM unnest(criteria) c)) THEN
      RAISE EXCEPTION 'Checklist subject % is neither a declared rule nor a contract criterion', item->>'subject';
    END IF;
    IF (item->>'subject') = ANY (subjects) THEN
      RAISE EXCEPTION 'Checklist subject % appears twice', item->>'subject';
    END IF;
    subjects := subjects || (item->>'subject');
  END LOOP;
  result := jsonb_build_object(
    'mission', m.mission,
    'reviewer', input->>'reviewer',
    'assignee', m.request->>'assignee',
    'items', jsonb_array_length(items),
    'passed', (SELECT count(*) FROM jsonb_array_elements(items) i WHERE i->>'verdict' = 'pass'),
    'failed', (SELECT count(*) FROM jsonb_array_elements(items) i WHERE i->>'verdict' = 'fail'),
    'missingRules', (SELECT count(*) FROM unnest(rules) r WHERE NOT ('rule:' || r) = ANY (subjects)),
    'missingCriteria', (SELECT count(*) FROM unnest(criteria) c WHERE NOT ('criterion:' || c) = ANY (subjects)),
    'withoutEvidence', (SELECT count(*) FROM jsonb_array_elements(items) i WHERE length(btrim(i->>'evidence')) = 0),
    'summary', coalesce((SELECT string_agg(i->>'subject', ', ') FROM jsonb_array_elements(items) i
                         WHERE i->>'verdict' = 'fail'), '')
  );
  INSERT INTO trust_coordination.reviews(mission, reviewer, checklist, result)
    VALUES (m.mission, input->>'reviewer', items, result);
  RETURN result;
END $$;
