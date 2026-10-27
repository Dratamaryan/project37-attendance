-- S9.5-T2 ROLLBACK — restore the 2nd-Friday "Project Day" series retired by
-- t2-retire-friday-series.<env>.sql.
--
-- VALID ONLY BEFORE THE SATURDAY SERIES EXISTS. Once any saturday_monthly
-- event has been created, restoring the Friday series would run two
-- Project Day series side by side — this script refuses (EXCEPTION) if any
-- event with event_type 'saturday_monthly' exists. Deactivate/handle the
-- Saturday series first, as a separate decision.
--
-- What it does, in ONE transaction (any RAISE EXCEPTION aborts it, nothing written):
--   1. Event row must match the header snapshot (id, name, event_type, recurrence_rule).
--   2. Idempotency: event active AND every snapshot instance 'scheduled' with
--      notes NULL → NOTICE 'already rolled back / never applied', no writes.
--      Otherwise the state must be exactly the applied state — event inactive
--      AND every snapshot instance 'cancelled' with the S9.5 note — else EXCEPTION.
--   3. Preflight — WIB date set and per-instance child counts equal the snapshot.
--   4. Apply: events.active = true (+ updated_at); every snapshot instance back
--      to status 'scheduled', notes NULL. Audit (system actor, same convention
--      as the forward script): one event.update + one event_instance.update
--      per instance.
--   5. Post-assert: all N snapshot instances 'scheduled'; every other event's
--      instance vector and active flag unchanged; exactly N+1 audit rows.
--
-- No PII: ids, dates and counts only.
-- GENERATED from scripts/s9-5/t2-retire-friday-series.ROLLBACK.template.sql +
-- scripts/s9-5/t2-snapshots.json by scripts/s9-5/generate-t2-sql.mjs.
-- Do not edit the generated ROLLBACK.<env>.sql files by hand — the env files
-- differ only inside the HEADER SNAPSHOT block below.

BEGIN;

-- >>> HEADER SNAPSHOT
-- env: prod
-- expected event: 4f9eb395-b1a2-40c2-a84c-af3970d8d26f  name="Project Day"  type=friday_monthly  rrule=FREQ=MONTHLY;BYDAY=2FR  active=true
-- expected scheduled instances on/after 2026-11-01 WIB: 12
-- instance_id                           wib_date    links rsvps invit atten child
-- 3c456ee4-7385-4478-80cb-9d7718f9b499  (set)       0     0     0     0     0
-- f7aca1c9-5a15-4011-bee2-ef5f9fb568d2  (set)       0     0     0     0     0
-- a1e295da-73d3-41d8-b339-522c7124abcd  (set)       0     0     0     0     0
-- 74f1cc19-3bbd-4909-8d90-5d9d3f84b547  (set)       0     0     0     0     0
-- ce4a2457-bac6-452f-bfd5-4bba4a34198e  (set)       0     0     0     0     0
-- 7462bf1c-c98e-427b-bc34-ff764e3c4409  (set)       0     0     0     0     0
-- b1d32d69-659f-49b6-87aa-2a20fa8426d6  (set)       0     0     0     0     0
-- ee6a9d3c-2d5c-47a6-818b-68695c3a6e21  (set)       0     0     0     0     0
-- 2fbce96c-fc83-404e-ab8e-1e4ec4e59167  (set)       0     0     0     0     0
-- 69eaf035-d5ac-4855-a50d-4f7949b54557  (set)       0     0     0     0     0
-- 64535c8c-1c27-4720-80dc-e17bf92039c9  (set)       0     0     0     0     0
-- e938399f-29d5-4cc4-8b36-7771d870aa01  (set)       0     0     0     0     0
-- expected WIB date set: 2026-11-13 2026-12-11 2027-01-08 2027-02-12 2027-03-12 2027-04-09 2027-05-14 2027-06-11 2027-07-09 2027-08-13 2027-09-10 2027-10-08
SET LOCAL s95.env = 'prod';
SET LOCAL s95.event = '{"id":"4f9eb395-b1a2-40c2-a84c-af3970d8d26f","name":"Project Day","event_type":"friday_monthly","recurrence_rule":"FREQ=MONTHLY;BYDAY=2FR","active":true}';
SET LOCAL s95.expected_dates = '["2026-11-13","2026-12-11","2027-01-08","2027-02-12","2027-03-12","2027-04-09","2027-05-14","2027-06-11","2027-07-09","2027-08-13","2027-09-10","2027-10-08"]';
SET LOCAL s95.instances = '[{"id":"3c456ee4-7385-4478-80cb-9d7718f9b499","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"f7aca1c9-5a15-4011-bee2-ef5f9fb568d2","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"a1e295da-73d3-41d8-b339-522c7124abcd","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"74f1cc19-3bbd-4909-8d90-5d9d3f84b547","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"ce4a2457-bac6-452f-bfd5-4bba4a34198e","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"7462bf1c-c98e-427b-bc34-ff764e3c4409","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"b1d32d69-659f-49b6-87aa-2a20fa8426d6","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"ee6a9d3c-2d5c-47a6-818b-68695c3a6e21","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"2fbce96c-fc83-404e-ab8e-1e4ec4e59167","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"69eaf035-d5ac-4855-a50d-4f7949b54557","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"64535c8c-1c27-4720-80dc-e17bf92039c9","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0},{"id":"e938399f-29d5-4cc4-8b36-7771d870aa01","wib_date":null,"links":0,"rsvps":0,"invitations":0,"attendance":0,"child_attendance":0}]';
-- <<< HEADER SNAPSHOT

DO $s95$
DECLARE
  c_note    CONSTANT text := 'S9.5: moved to 2nd Saturday from Nov 2026';
  c_trigger CONSTANT text := 's9_5_t2_retire_friday_series_rollback';
  v_env      text  := current_setting('s95.env');
  v_event    jsonb := current_setting('s95.event')::jsonb;
  v_dates    jsonb := current_setting('s95.expected_dates')::jsonb;
  v_snap     jsonb := current_setting('s95.instances')::jsonb;
  v_event_id uuid  := (v_event->>'id')::uuid;
  v_n        integer := jsonb_array_length(v_snap);
  v_ids      text[];
  v_row      events%ROWTYPE;
  v_noted    integer;
  v_restored integer;
  v_mismatch text;
  v_rows     integer;
  v_id       text;
  v_others_before jsonb;
  v_others_after  jsonb;
BEGIN
  -- 0. Snapshot sanity
  SELECT array_agg(x->>'id' ORDER BY x->>'id') INTO v_ids
    FROM jsonb_array_elements(v_snap) x;
  IF v_n = 0 OR v_ids IS NULL
     OR v_n <> (SELECT count(DISTINCT u) FROM unnest(v_ids) u)
     OR v_n <> jsonb_array_length(v_dates) THEN
    RAISE EXCEPTION '[%] header snapshot malformed (n=%, dates=%) — aborting', v_env, v_n, jsonb_array_length(v_dates);
  END IF;

  -- 1. Event row (locked)
  SELECT * INTO v_row FROM events WHERE id = v_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '[%] event % not found — wrong environment? aborting', v_env, v_event_id;
  END IF;
  IF v_row.name <> v_event->>'name'
     OR v_row.event_type::text <> v_event->>'event_type'
     OR v_row.recurrence_rule IS DISTINCT FROM v_event->>'recurrence_rule' THEN
    RAISE EXCEPTION '[%] event % does not match snapshot (name/event_type/recurrence_rule) — aborting', v_env, v_event_id;
  END IF;

  -- 2. Idempotency / state check
  SELECT count(*) FILTER (WHERE status = 'cancelled' AND notes = c_note),
         count(*) FILTER (WHERE status = 'scheduled' AND notes IS NULL)
    INTO v_noted, v_restored
    FROM event_instances
   WHERE id::text = ANY (v_ids) AND event_id = v_event_id;
  IF v_row.active AND v_restored = v_n THEN
    RAISE NOTICE '[%] S9.5-T2 rollback: already rolled back / never applied (event % active, %/% instances scheduled) — no writes',
      v_env, v_event_id, v_restored, v_n;
    RETURN;
  END IF;
  IF v_row.active OR v_noted <> v_n THEN
    RAISE EXCEPTION '[%] rollback: not in the applied state (active=%, cancelled-with-note=%/%) — aborting',
      v_env, v_row.active, v_noted, v_n;
  END IF;

  -- 2b. Validity window: no Saturday series may exist
  IF EXISTS (SELECT 1 FROM events WHERE event_type::text = 'saturday_monthly') THEN
    RAISE EXCEPTION '[%] rollback refused: a saturday_monthly event exists — this rollback is valid only before the Saturday series is created', v_env;
  END IF;

  -- 3. Preflight: dates + per-instance child counts
  IF (SELECT array_agg(d ORDER BY d)
        FROM (SELECT (scheduled_at AT TIME ZONE 'Asia/Jakarta')::date::text AS d
                FROM event_instances WHERE id::text = ANY (v_ids)) t)
     IS DISTINCT FROM
     (SELECT array_agg(d ORDER BY d) FROM jsonb_array_elements_text(v_dates) d) THEN
    RAISE EXCEPTION '[%] instance WIB dates differ from expected_dates — aborting', v_env;
  END IF;
  SELECT string_agg(s.id::text, ', ' ORDER BY s.id::text) INTO v_mismatch
    FROM jsonb_to_recordset(v_snap) AS s(id uuid, wib_date date, links integer, rsvps integer,
                                         invitations integer, attendance integer, child_attendance integer)
    JOIN event_instances ei ON ei.id = s.id
   WHERE (s.wib_date IS NOT NULL AND s.wib_date <> (ei.scheduled_at AT TIME ZONE 'Asia/Jakarta')::date)
      OR s.links            <> (SELECT count(*) FROM event_rsvp_links  x WHERE x.event_instance_id = s.id)
      OR s.rsvps            <> (SELECT count(*) FROM event_rsvps       x WHERE x.event_instance_id = s.id)
      OR s.invitations      <> (SELECT count(*) FROM event_invitations x WHERE x.event_instance_id = s.id)
      OR s.attendance       <> (SELECT count(*) FROM attendance        x WHERE x.event_instance_id = s.id)
      OR s.child_attendance <> (SELECT count(*) FROM child_attendance  x WHERE x.event_instance_id = s.id);
  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION '[%] instance(s) differ from snapshot (date/child counts): % — aborting', v_env, v_mismatch;
  END IF;

  -- 4. Pre-write vector of every other event
  SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_others_before
    FROM (SELECT 'i:' || event_id || ':' || status AS k, count(*) AS n
            FROM event_instances WHERE event_id <> v_event_id GROUP BY event_id, status
          UNION ALL
          SELECT 'e:' || id || ':active', CASE WHEN active THEN 1 ELSE 0 END
            FROM events WHERE id <> v_event_id) t;

  -- 5. Apply
  UPDATE events SET active = true, updated_at = now()
   WHERE id = v_event_id AND NOT active;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '[%] expected 1 event row reactivated, got % — aborting', v_env, v_rows;
  END IF;

  UPDATE event_instances SET status = 'scheduled', notes = NULL
   WHERE id::text = ANY (v_ids) AND event_id = v_event_id
     AND status = 'cancelled' AND notes = c_note;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION '[%] expected % instances restored, got % — aborting', v_env, v_n, v_rows;
  END IF;

  PERFORM log_audit(
    NULL::uuid,
    'event.update',
    'event',
    v_event_id::text,
    jsonb_build_object(
      'changed_fields',      jsonb_build_array('active'),
      'updates',             jsonb_build_object('active', true),
      'instances_restored',  v_n,
      'trigger',             c_trigger,
      'env',                 v_env
    ),
    NULL,
    NULL
  );
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM log_audit(
      NULL::uuid,
      'event_instance.update',
      'event_instance',
      v_id,
      jsonb_build_object(
        'changed_fields', jsonb_build_array('status', 'notes'),
        'updates',        jsonb_build_object('status', 'scheduled', 'notes', NULL),
        'trigger',        c_trigger,
        'env',            v_env
      ),
      NULL,
      NULL
    );
  END LOOP;

  -- 6. Post-assert
  SELECT count(*) INTO v_rows FROM event_instances
   WHERE id::text = ANY (v_ids) AND status = 'scheduled' AND notes IS NULL;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION '[%] post-assert: expected % scheduled instances, got % — aborting', v_env, v_n, v_rows;
  END IF;
  SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_others_after
    FROM (SELECT 'i:' || event_id || ':' || status AS k, count(*) AS n
            FROM event_instances WHERE event_id <> v_event_id GROUP BY event_id, status
          UNION ALL
          SELECT 'e:' || id || ':active', CASE WHEN active THEN 1 ELSE 0 END
            FROM events WHERE id <> v_event_id) t;
  IF v_others_after IS DISTINCT FROM v_others_before THEN
    RAISE EXCEPTION '[%] post-assert: other events changed — aborting', v_env;
  END IF;
  SELECT count(*) INTO v_rows FROM audit_log
   WHERE created_at = now() AND details_json->>'trigger' = c_trigger;
  IF v_rows <> v_n + 1 THEN
    RAISE EXCEPTION '[%] post-assert: expected % audit rows, got % — aborting', v_env, v_n + 1, v_rows;
  END IF;

  RAISE NOTICE '[%] S9.5-T2 rollback applied: event % reactivated, % instances restored, % audit rows',
    v_env, v_event_id, v_n, v_n + 1;
END
$s95$;

COMMIT;
