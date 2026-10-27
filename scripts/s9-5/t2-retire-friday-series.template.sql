-- S9.5-T2 — retire the 2nd-Friday "Project Day" series (Option B).
--
-- What it does, in ONE transaction (any RAISE EXCEPTION aborts it, nothing written):
--   1. Checks the event row against the header snapshot (id, name, event_type,
--      recurrence_rule) — a wrong environment fails here (unknown id).
--   2. Idempotency: event already inactive AND every snapshot instance already
--      'cancelled' with the S9.5 note → NOTICE 'already applied', no writes.
--      Any other mix of those two → EXCEPTION.
--   3. Preflight — live state must equal the snapshot EXACTLY:
--        • the set of status='scheduled' instances of the event with
--          scheduled_at >= 2026-11-01 00:00 WIB equals the snapshot id set;
--        • their WIB dates equal expected_dates (and the per-id wib_date
--          where the snapshot pins one);
--        • per instance: notes IS NULL, and the counts of event_rsvp_links
--          (any state), event_rsvps, event_invitations, attendance and
--          child_attendance equal the snapshot.
--   4. Apply: events.active = false (+ updated_at); cancel exactly the
--      snapshot ids (status = 'cancelled', notes = the S9.5 note). Never DELETE.
--      Audit (system actor, house convention — see below): one
--      event_instance.cancel per instance + one event.update.
--   5. Post-assert inside the transaction: no 'scheduled' instance of the
--      event on/after 2026-11-01 WIB; every other event's instance
--      (event_id, status) count vector and active flag unchanged; this
--      event's non-snapshot instances unchanged; exactly N+1 audit rows.
--
-- Audit convention for non-user actors: log_audit(NULL, ...) — the SQL
-- system-caller path (log_audit resolves the actor as COALESCE(auth.uid(),
-- p_actor_user_id); the SQL Editor has no JWT, so actor_user_id is NULL),
-- with a 'trigger' key in details_json, exactly as run_rsvp_retention_pass()
-- does (supabase/migrations/20261026120000_sprint9_r5_rsvp_retention.sql,
-- § A3) and as lib/audit.ts documents ("Pass null for cron/system callers").
-- Actions / entity types / details shapes mirror the app's own writers:
-- impl_cancelInstance ('event_instance', {reason}) and impl_updateEvent
-- ('event', {changed_fields, updates}) in lib/actions/events.impl.ts.
--
-- No PII: ids, dates and counts only.
-- GENERATED from scripts/s9-5/t2-retire-friday-series.template.sql +
-- scripts/s9-5/t2-snapshots.json by scripts/s9-5/generate-t2-sql.mjs.
-- Do not edit the generated <env>.sql files by hand — the env files differ
-- only inside the HEADER SNAPSHOT block below.

BEGIN;

-- >>> HEADER SNAPSHOT
-- (template placeholder — replaced per environment by generate-t2-sql.mjs)
SET LOCAL s95.env = '__ENV__';
SET LOCAL s95.event = '__EVENT_JSON__';
SET LOCAL s95.expected_dates = '__DATES_JSON__';
SET LOCAL s95.instances = '__INSTANCES_JSON__';
-- <<< HEADER SNAPSHOT

DO $s95$
DECLARE
  c_note    CONSTANT text        := 'S9.5: moved to 2nd Saturday from Nov 2026';
  c_cutoff  CONSTANT timestamptz := TIMESTAMPTZ '2026-11-01 00:00:00+07';
  c_trigger CONSTANT text        := 's9_5_t2_retire_friday_series';
  v_env      text  := current_setting('s95.env');
  v_event    jsonb := current_setting('s95.event')::jsonb;
  v_dates    jsonb := current_setting('s95.expected_dates')::jsonb;
  v_snap     jsonb := current_setting('s95.instances')::jsonb;
  v_event_id uuid  := (v_event->>'id')::uuid;
  v_n        integer := jsonb_array_length(v_snap);
  v_ids      text[];
  v_live_ids text[];
  v_row      events%ROWTYPE;
  v_noted    integer;
  v_mismatch text;
  v_rows     integer;
  v_id       text;
  v_others_before jsonb;
  v_others_after  jsonb;
  v_rest_before   jsonb;
  v_rest_after    jsonb;
BEGIN
  -- 0. Snapshot sanity
  SELECT array_agg(x->>'id' ORDER BY x->>'id') INTO v_ids
    FROM jsonb_array_elements(v_snap) x;
  IF v_n = 0 OR v_ids IS NULL
     OR v_n <> (SELECT count(DISTINCT u) FROM unnest(v_ids) u)
     OR v_n <> jsonb_array_length(v_dates)
     OR (v_event->>'active')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '[%] header snapshot malformed (n=%, dates=%) — aborting', v_env, v_n, jsonb_array_length(v_dates);
  END IF;

  -- 1. Event row (locked for the rest of the transaction)
  SELECT * INTO v_row FROM events WHERE id = v_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '[%] event % not found — wrong environment? aborting', v_env, v_event_id;
  END IF;
  IF v_row.name <> v_event->>'name'
     OR v_row.event_type::text <> v_event->>'event_type'
     OR v_row.recurrence_rule IS DISTINCT FROM v_event->>'recurrence_rule' THEN
    RAISE EXCEPTION '[%] event % does not match snapshot (name/event_type/recurrence_rule) — aborting', v_env, v_event_id;
  END IF;

  -- 2. Idempotency
  SELECT count(*) INTO v_noted
    FROM event_instances
   WHERE id::text = ANY (v_ids)
     AND event_id = v_event_id
     AND status = 'cancelled'
     AND notes = c_note;
  IF NOT v_row.active AND v_noted = v_n THEN
    RAISE NOTICE '[%] S9.5-T2 already applied (event % inactive, %/% instances cancelled) — no writes', v_env, v_event_id, v_noted, v_n;
    RETURN;
  END IF;
  IF NOT v_row.active OR v_noted <> 0 THEN
    RAISE EXCEPTION '[%] mixed state (active=%, cancelled-with-note=%/%) — aborting', v_env, v_row.active, v_noted, v_n;
  END IF;

  -- 3a. Preflight: scheduled Nov+ instance set == snapshot id set
  SELECT array_agg(id::text ORDER BY id::text) INTO v_live_ids
    FROM event_instances
   WHERE event_id = v_event_id
     AND status = 'scheduled'
     AND scheduled_at >= c_cutoff;
  IF v_live_ids IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION '[%] scheduled instances on/after 2026-11-01 WIB (%) differ from snapshot (%) — aborting',
      v_env, COALESCE(cardinality(v_live_ids), 0), v_n;
  END IF;

  -- 3b. Preflight: WIB date set == expected_dates
  IF (SELECT array_agg(d ORDER BY d)
        FROM (SELECT (scheduled_at AT TIME ZONE 'Asia/Jakarta')::date::text AS d
                FROM event_instances WHERE id::text = ANY (v_ids)) t)
     IS DISTINCT FROM
     (SELECT array_agg(d ORDER BY d) FROM jsonb_array_elements_text(v_dates) d) THEN
    RAISE EXCEPTION '[%] instance WIB dates differ from expected_dates — aborting', v_env;
  END IF;

  -- 3c. Preflight: per instance — pinned date, notes, child counts
  SELECT string_agg(s.id::text, ', ' ORDER BY s.id::text) INTO v_mismatch
    FROM jsonb_to_recordset(v_snap) AS s(id uuid, wib_date date, links integer, rsvps integer,
                                         invitations integer, attendance integer, child_attendance integer)
    JOIN event_instances ei ON ei.id = s.id
   WHERE (s.wib_date IS NOT NULL AND s.wib_date <> (ei.scheduled_at AT TIME ZONE 'Asia/Jakarta')::date)
      OR ei.notes IS NOT NULL
      OR s.links            <> (SELECT count(*) FROM event_rsvp_links  x WHERE x.event_instance_id = s.id)
      OR s.rsvps            <> (SELECT count(*) FROM event_rsvps       x WHERE x.event_instance_id = s.id)
      OR s.invitations      <> (SELECT count(*) FROM event_invitations x WHERE x.event_instance_id = s.id)
      OR s.attendance       <> (SELECT count(*) FROM attendance        x WHERE x.event_instance_id = s.id)
      OR s.child_attendance <> (SELECT count(*) FROM child_attendance  x WHERE x.event_instance_id = s.id);
  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION '[%] instance(s) differ from snapshot (date/notes/child counts): % — aborting', v_env, v_mismatch;
  END IF;

  -- 4. Pre-write vectors for the post-assert
  SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_others_before
    FROM (SELECT 'i:' || event_id || ':' || status AS k, count(*) AS n
            FROM event_instances WHERE event_id <> v_event_id GROUP BY event_id, status
          UNION ALL
          SELECT 'e:' || id || ':active', CASE WHEN active THEN 1 ELSE 0 END
            FROM events WHERE id <> v_event_id) t;
  SELECT COALESCE(jsonb_object_agg(id, status), '{}'::jsonb) INTO v_rest_before
    FROM event_instances WHERE event_id = v_event_id AND NOT (id::text = ANY (v_ids));

  -- 5. Apply
  UPDATE events SET active = false, updated_at = now()
   WHERE id = v_event_id AND active;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION '[%] expected 1 event row deactivated, got % — aborting', v_env, v_rows;
  END IF;

  UPDATE event_instances SET status = 'cancelled', notes = c_note
   WHERE id::text = ANY (v_ids) AND event_id = v_event_id AND status = 'scheduled';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_n THEN
    RAISE EXCEPTION '[%] expected % instances cancelled, got % — aborting', v_env, v_n, v_rows;
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM log_audit(
      NULL::uuid,
      'event_instance.cancel',
      'event_instance',
      v_id,
      jsonb_build_object('reason', c_note, 'trigger', c_trigger, 'env', v_env),
      NULL,
      NULL
    );
  END LOOP;
  PERFORM log_audit(
    NULL::uuid,
    'event.update',
    'event',
    v_event_id::text,
    jsonb_build_object(
      'changed_fields',      jsonb_build_array('active'),
      'updates',             jsonb_build_object('active', false),
      'instances_cancelled', v_n,
      'trigger',             c_trigger,
      'env',                 v_env
    ),
    NULL,
    NULL
  );

  -- 6. Post-assert (still inside the transaction — a failure rolls everything back)
  IF EXISTS (SELECT 1 FROM event_instances
              WHERE event_id = v_event_id AND status = 'scheduled' AND scheduled_at >= c_cutoff) THEN
    RAISE EXCEPTION '[%] post-assert: scheduled instance on/after 2026-11-01 WIB remains — aborting', v_env;
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
  SELECT COALESCE(jsonb_object_agg(id, status), '{}'::jsonb) INTO v_rest_after
    FROM event_instances WHERE event_id = v_event_id AND NOT (id::text = ANY (v_ids));
  IF v_rest_after IS DISTINCT FROM v_rest_before THEN
    RAISE EXCEPTION '[%] post-assert: non-snapshot instances of the event changed — aborting', v_env;
  END IF;
  SELECT count(*) INTO v_rows FROM audit_log
   WHERE created_at = now() AND details_json->>'trigger' = c_trigger;
  IF v_rows <> v_n + 1 THEN
    RAISE EXCEPTION '[%] post-assert: expected % audit rows, got % — aborting', v_env, v_n + 1, v_rows;
  END IF;

  RAISE NOTICE '[%] S9.5-T2 applied: event % deactivated, % instances cancelled, % audit rows',
    v_env, v_event_id, v_n, v_n + 1;
END
$s95$;

COMMIT;
