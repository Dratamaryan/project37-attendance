-- Migration: s9_5_t5_5_p2_schedule_change
-- S9.5-T5.5 Phase 2 — schedule-edit propagation (recon option C, hybrid).
--
-- Phase 1 (20261102120000) locked start_date / start_time / recurrence_rule /
-- event_type while an event has upcoming (scheduled or cancelled) occurrences.
-- Phase 2 unlocks exactly two moves, admin-only, through one function:
--
--   R  recurring event (event_type <> 'adhoc', recurrence_rule NOT NULL):
--      start_time changes; start_date, recurrence_rule, event_type unchanged.
--      Every future occurrence on an OLD rule slot moves to the same WIB date
--      at the new time.
--   A  adhoc event (event_type = 'adhoc', recurrence_rule NULL): start_date
--      and/or start_time change. Its single future occurrence moves to the new
--      WIB date + time.
--
-- The TS layer (lib/events/schedule-change.ts, impl_updateEvent) computes the
-- plan with the materializer's own expansion: p_moves (id, from_at, to_at) and
-- p_expected_slots = the NEW rule's slots exactly as the materializer will
-- compute them. This function re-checks everything it can without an RRULE
-- engine and applies the plan in one transaction:
--   - event row locked FOR UPDATE; current schedule == p_old (else 'stale');
--   - change shape is R or A (else 'unsupported_change');
--   - each move: row of this event, status scheduled/cancelled, scheduled_at
--     == from_at, from_at > now(), to_at > now(); R: to_at on the same WIB date
--     as from_at at the new WIB time; A: from_at = old instant, to_at = new
--     instant, exactly one move. UPDATE scheduled_at = to_at (unique violation
--     → 'slot_taken'). Row ids never change, so RSVP links, RSVPs, invitations
--     and attendance stay attached.
--   - a transaction-local flag (§ 2) lets trg_events_schedule_lock pass the
--     R/A update of the event row; the flag is cleared right after;
--   - post-assert: every p_expected_slots value exists as a row of this event
--     (the materializer would insert 0); no moved row is left at its from_at;
--     else RAISE → full rollback;
--   - one audit row 'event.schedule_change' with the real actor.
-- Never DELETEs.
--
-- Access: SECURITY INVOKER — every read/write goes through the caller's RLS
-- (events_admin_all, event_instances_admin_all; organizers cannot UPDATE
-- event_instances at all). The is_admin() check up front is for a typed
-- refusal, not the enforcement layer. search_path pinned. EXECUTE:
-- authenticated only. Audit via log_audit() (SECURITY DEFINER; actor
-- COALESCE(auth.uid(), …) — the real admin, never a parameter).
-- House pattern: 20261030120000_s9_5_t4_reschedule_instance.sql.
--
-- Refusals: RAISE EXCEPTION 'schedule_change:<code>' USING ERRCODE = 'P0001'.
-- Codes (mapped in lib/actions/events.impl.ts mapScheduleChangeError):
--   not_admin, invalid_input, not_found, stale, unsupported_change,
--   nothing_to_move, move_invalid, in_progress, slot_taken, expected_missing
--
-- § 2  events_schedule_lock() — CREATE OR REPLACE (keeps the trigger and the
--      ACL). New: when the lock would fire, it passes ONLY if
--        (a) current_setting('app.event_schedule_change', true) equals
--            OLD.id || ':' || txid_current() — set by apply_event_schedule_change
--            in this very transaction, for this very event; and
--        (b) nothing but start_date / start_time / updated_at differs between
--            OLD and NEW (to_jsonb comparison, so future columns are covered);
--        (c) the change shape is R or A (same definition as above).
--      Anything else still raises 'event:schedule_locked', flag or not.
--      Nobody but apply_event_schedule_change sets the flag: API roles cannot
--      reach set_config() (pg_catalog is not an exposed schema) and a
--      PostgREST request is one transaction, so the txid binding makes a flag
--      from another transaction worthless.
--
-- § 3  materialize_event_slots(p_event_id, p_schedule, p_slots) RETURNS int —
--      the materializer's per-event insert, now compare-and-insert under the
--      event row lock (replaces the client-side upsert in materialize.impl.ts).
--      Why: the materializer reads all active events, then inserts per event.
--      If apply_event_schedule_change commits in between, a client upsert
--      inserts the OLD schedule's slots next to the moved rows (reproduced
--      locally: 12 duplicate rows). Here:
--        SELECT … FROM events WHERE id = p_event_id FOR SHARE — conflicts with
--        apply_event_schedule_change's FOR UPDATE, so the two serialize; a
--        waiting FOR SHARE re-reads the committed row (READ COMMITTED);
--        start_date / start_time / recurrence_rule / event_type / active differ
--        from p_schedule (what TS expanded from) → insert nothing, return -1
--        ('schedule_changed'; the next run picks up the new schedule);
--        else INSERT … ON CONFLICT (event_id, scheduled_at) DO NOTHING with the
--        same columns/values as before, return the number of rows inserted.
--      Snapshot names come from the locked row. Never DELETEs (the prune path
--      in materialize.impl.ts is unchanged).
--      Access: SECURITY INVOKER; EXECUTE service_role only — materializeEvents
--      always runs with the service-role (admin) client (cron route and
--      impl_createEvent). anon/authenticated: no EXECUTE.

-- ============================================================
-- § 0  Pre-flight: hard-abort before any DDL if the target has drifted.
--      Supabase runs each migration in a transaction, so RAISE EXCEPTION
--      here rolls back cleanly.
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure('public.apply_event_schedule_change(uuid,jsonb,jsonb,jsonb,timestamptz[])') IS NOT NULL THEN
    RAISE EXCEPTION 'apply_event_schedule_change(...) already exists — drift, aborting';
  END IF;
  IF to_regprocedure('public.materialize_event_slots(uuid,jsonb,timestamptz[])') IS NOT NULL THEN
    RAISE EXCEPTION 'materialize_event_slots(...) already exists — drift, aborting';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'event_instances'
         AND column_name IN ('event_name_snapshot', 'event_name_snapshot_id')) <> 2 THEN
    RAISE EXCEPTION 'event_instances snapshot column(s) missing — drift, aborting';
  END IF;
  IF to_regtype('public.instance_status_enum') IS NULL THEN
    RAISE EXCEPTION 'instance_status_enum missing — drift, aborting';
  END IF;
  IF to_regprocedure('public.events_schedule_lock()') IS NULL THEN
    RAISE EXCEPTION 'events_schedule_lock() missing — Phase 1 (20261102120000) not applied, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname = 'trg_events_schedule_lock'
                    AND tgrelid = 'public.events'::regclass
                    AND tgfoid = 'public.events_schedule_lock()'::regprocedure) THEN
    RAISE EXCEPTION 'trg_events_schedule_lock missing or bound to another function — drift, aborting';
  END IF;
  -- The Phase 1 body: raises event:schedule_locked and knows no flag yet.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.events_schedule_lock()'::regprocedure
                    AND prosrc LIKE '%event:schedule_locked%'
                    AND prosrc NOT LIKE '%app.event_schedule_change%') THEN
    RAISE EXCEPTION 'events_schedule_lock() body is not the Phase 1 body — drift, aborting';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'is_admin() missing — admin guard would fail';
  END IF;
  IF to_regprocedure('public.log_audit(uuid,text,text,text,jsonb,inet,text)') IS NULL THEN
    RAISE EXCEPTION 'log_audit(...) missing — drift, aborting';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events'
         AND column_name IN ('id', 'start_date', 'start_time', 'recurrence_rule',
                             'event_type', 'updated_at')) <> 6 THEN
    RAISE EXCEPTION 'events column(s) missing — drift, aborting';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'event_instances'
         AND column_name IN ('id', 'event_id', 'scheduled_at', 'status')) <> 4 THEN
    RAISE EXCEPTION 'event_instances column(s) missing — drift, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'idx_event_instances_event_date' AND i.indisunique) THEN
    RAISE EXCEPTION 'unique idx_event_instances_event_date missing — the slot guarantee would not hold';
  END IF;
END $$;

-- ============================================================
-- § 1  apply_event_schedule_change
-- ============================================================

CREATE FUNCTION public.apply_event_schedule_change(
  p_event_id       uuid,
  p_old            jsonb,
  p_new            jsonb,
  p_moves          jsonb,
  p_expected_slots timestamptz[]
)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_event      events%ROWTYPE;
  v_old_date   date;
  v_old_time   time;
  v_new_date   date;
  v_new_time   time;
  v_shape      text;
  v_move       jsonb;
  v_id         uuid;
  v_from       timestamptz;
  v_to         timestamptz;
  v_row        event_instances%ROWTYPE;
  v_moved      integer := 0;
  v_cancelled  integer := 0;
  v_audit      jsonb := '[]'::jsonb;
  v_missing    integer;
  v_left       integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'schedule_change:not_admin' USING ERRCODE = 'P0001';
  END IF;

  IF p_event_id IS NULL OR p_old IS NULL OR p_new IS NULL OR p_moves IS NULL
     OR p_expected_slots IS NULL
     OR jsonb_typeof(p_old) <> 'object' OR jsonb_typeof(p_new) <> 'object'
     OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'schedule_change:invalid_input' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    v_old_date := (p_old->>'start_date')::date;
    v_old_time := (p_old->>'start_time')::time;
    v_new_date := (p_new->>'start_date')::date;
    v_new_time := (p_new->>'start_time')::time;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'schedule_change:invalid_input' USING ERRCODE = 'P0001';
  END;
  IF v_old_date IS NULL OR v_old_time IS NULL OR v_new_date IS NULL OR v_new_time IS NULL THEN
    RAISE EXCEPTION 'schedule_change:invalid_input' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the event first, then judge it (optimistic concurrency on p_old).
  SELECT * INTO v_event FROM events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schedule_change:not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_event.start_date      IS DISTINCT FROM v_old_date
  OR v_event.start_time      IS DISTINCT FROM v_old_time
  OR v_event.recurrence_rule IS DISTINCT FROM (p_old->>'recurrence_rule')
  OR v_event.event_type::text IS DISTINCT FROM (p_old->>'event_type') THEN
    RAISE EXCEPTION 'schedule_change:stale' USING ERRCODE = 'P0001';
  END IF;

  -- Shape: R or A, nothing else.
  IF (p_new->>'event_type')      IS DISTINCT FROM v_event.event_type::text
  OR (p_new->>'recurrence_rule') IS DISTINCT FROM v_event.recurrence_rule THEN
    RAISE EXCEPTION 'schedule_change:unsupported_change' USING ERRCODE = 'P0001';
  END IF;
  IF v_event.event_type <> 'adhoc' AND v_event.recurrence_rule IS NOT NULL
     AND v_new_date = v_old_date AND v_new_time <> v_old_time THEN
    v_shape := 'R';
  ELSIF v_event.event_type = 'adhoc' AND v_event.recurrence_rule IS NULL
     AND (v_new_date, v_new_time) IS DISTINCT FROM (v_old_date, v_old_time) THEN
    v_shape := 'A';
  ELSE
    RAISE EXCEPTION 'schedule_change:unsupported_change' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_array_length(p_moves) = 0 THEN
    RAISE EXCEPTION 'schedule_change:nothing_to_move' USING ERRCODE = 'P0001';
  END IF;
  IF v_shape = 'A' AND jsonb_array_length(p_moves) <> 1 THEN
    RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(DISTINCT m->>'id') FROM jsonb_array_elements(p_moves) m)
     <> jsonb_array_length(p_moves) THEN
    RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
  END IF;

  FOR v_move IN SELECT * FROM jsonb_array_elements(p_moves) LOOP
    BEGIN
      v_id   := (v_move->>'id')::uuid;
      v_from := (v_move->>'from_at')::timestamptz;
      v_to   := (v_move->>'to_at')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'schedule_change:invalid_input' USING ERRCODE = 'P0001';
    END;
    IF v_id IS NULL OR v_from IS NULL OR v_to IS NULL THEN
      RAISE EXCEPTION 'schedule_change:invalid_input' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_row FROM event_instances WHERE id = v_id FOR UPDATE;
    IF NOT FOUND
       OR v_row.event_id <> p_event_id
       OR v_row.status NOT IN ('scheduled', 'cancelled')
       OR v_row.scheduled_at <> v_from THEN
      RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
    END IF;
    IF v_from <= now() OR v_to <= now() THEN
      RAISE EXCEPTION 'schedule_change:in_progress' USING ERRCODE = 'P0001';
    END IF;
    IF v_shape = 'R' AND (
         (v_to AT TIME ZONE 'Asia/Jakarta')::date <> (v_from AT TIME ZONE 'Asia/Jakarta')::date
      OR (v_to AT TIME ZONE 'Asia/Jakarta')::time <> v_new_time) THEN
      RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
    END IF;
    IF v_shape = 'A' AND (
         v_from <> ((v_old_date + v_old_time) AT TIME ZONE 'Asia/Jakarta')
      OR v_to   <> ((v_new_date + v_new_time) AT TIME ZONE 'Asia/Jakarta')) THEN
      RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
    END IF;

    BEGIN
      UPDATE event_instances SET scheduled_at = v_to WHERE id = v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'schedule_change:slot_taken' USING ERRCODE = 'P0001';
    END;

    v_moved := v_moved + 1;
    IF v_row.status = 'cancelled' THEN
      v_cancelled := v_cancelled + 1;
    END IF;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object(
      'id', v_id, 'from', v_from, 'to', v_to, 'status', v_row.status));
  END LOOP;

  -- The only door through trg_events_schedule_lock: this event, this txid.
  PERFORM set_config('app.event_schedule_change',
                     p_event_id::text || ':' || txid_current()::text, true);
  UPDATE events
     SET start_date = v_new_date,
         start_time = v_new_time,
         updated_at = now()
   WHERE id = p_event_id;
  PERFORM set_config('app.event_schedule_change', '', true);

  -- Post-assert 1: the materializer would insert 0 for this event.
  SELECT count(*) INTO v_missing
    FROM unnest(p_expected_slots) s
   WHERE NOT EXISTS (SELECT 1 FROM event_instances ei
                      WHERE ei.event_id = p_event_id AND ei.scheduled_at = s);
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'schedule_change:expected_missing' USING ERRCODE = 'P0001';
  END IF;

  -- Post-assert 2: no moved row is still at its from_at.
  SELECT count(*) INTO v_left
    FROM jsonb_array_elements(p_moves) m
    JOIN event_instances ei ON ei.id = (m->>'id')::uuid
   WHERE ei.scheduled_at = (m->>'from_at')::timestamptz;
  IF v_left > 0 THEN
    RAISE EXCEPTION 'schedule_change:move_invalid' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.log_audit(
    auth.uid(),
    'event.schedule_change',
    'event',
    p_event_id::text,
    jsonb_build_object(
      'old', jsonb_build_object(
        'start_date', v_old_date, 'start_time', to_char(v_old_time, 'HH24:MI:SS'),
        'recurrence_rule', v_event.recurrence_rule, 'event_type', v_event.event_type),
      'new', jsonb_build_object(
        'start_date', v_new_date, 'start_time', to_char(v_new_time, 'HH24:MI:SS'),
        'recurrence_rule', v_event.recurrence_rule, 'event_type', v_event.event_type),
      'moves', v_audit,
      'expected_count', cardinality(p_expected_slots)
    )
  );

  RETURN jsonb_build_object('moved', v_moved, 'cancelled_moved', v_cancelled);
END;
$$;

-- Authenticated only: revoke the implicit PUBLIC grant and the per-role grants
-- this schema's default privileges hand to anon/service_role on every new
-- function (S9-R6 anon-EXECUTE allowlist stays unchanged).
REVOKE EXECUTE ON FUNCTION public.apply_event_schedule_change(uuid, jsonb, jsonb, jsonb, timestamptz[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_event_schedule_change(uuid, jsonb, jsonb, jsonb, timestamptz[])
  TO authenticated;

COMMENT ON FUNCTION public.apply_event_schedule_change(uuid, jsonb, jsonb, jsonb, timestamptz[]) IS
'S9.5-T5.5 P2: admin-only. Applies a recurring start_time change (R) or an adhoc date/time change (A): moves the planned future occurrences (ids unchanged), updates the event through the schedule lock, asserts the materializer would insert 0, audit event.schedule_change. Never deletes.';

-- ============================================================
-- § 2  events_schedule_lock() — honours the flag for R/A only
-- ============================================================

CREATE OR REPLACE FUNCTION public.events_schedule_lock()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.start_date      IS DISTINCT FROM OLD.start_date
  OR NEW.start_time      IS DISTINCT FROM OLD.start_time
  OR NEW.recurrence_rule IS DISTINCT FROM OLD.recurrence_rule
  OR NEW.event_type      IS DISTINCT FROM OLD.event_type THEN
    IF EXISTS (SELECT 1 FROM event_instances
                WHERE event_id = OLD.id
                  AND scheduled_at > now()
                  AND status IN ('scheduled', 'cancelled')) THEN
      -- S9.5-T5.5 P2: apply_event_schedule_change's door — this event, this
      -- transaction, only start_date/start_time(/updated_at) changed, R or A.
      IF current_setting('app.event_schedule_change', true)
           = OLD.id::text || ':' || txid_current()::text
         AND (to_jsonb(NEW) - 'start_date' - 'start_time' - 'updated_at')
           = (to_jsonb(OLD) - 'start_date' - 'start_time' - 'updated_at')
         AND (
              (OLD.event_type <> 'adhoc' AND OLD.recurrence_rule IS NOT NULL
               AND NEW.start_date = OLD.start_date)
           OR (OLD.event_type = 'adhoc' AND OLD.recurrence_rule IS NULL)
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'event:schedule_locked' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.events_schedule_lock() IS
'S9.5-T5.5: refuses a change to start_date/start_time/recurrence_rule/event_type while the event has a future scheduled or cancelled occurrence (event:schedule_locked, P0001). Every role. P2: passes only the R/A shapes when apply_event_schedule_change set app.event_schedule_change = <event id>:<txid> in the same transaction and nothing else changed.';

-- ============================================================
-- § 3  materialize_event_slots
-- ============================================================

CREATE FUNCTION public.materialize_event_slots(
  p_event_id uuid,
  p_schedule jsonb,
  p_slots    timestamptz[]
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_event    events%ROWTYPE;
  v_date     date;
  v_time     time;
  v_active   boolean;
  v_inserted integer;
BEGIN
  IF p_event_id IS NULL OR p_schedule IS NULL OR p_slots IS NULL
     OR jsonb_typeof(p_schedule) <> 'object' THEN
    RAISE EXCEPTION 'materialize:invalid_input' USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    v_date   := (p_schedule->>'start_date')::date;
    v_time   := (p_schedule->>'start_time')::time;
    v_active := (p_schedule->>'active')::boolean;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'materialize:invalid_input' USING ERRCODE = 'P0001';
  END;

  -- Serializes with apply_event_schedule_change (FOR UPDATE on the same row).
  SELECT * INTO v_event FROM events WHERE id = p_event_id FOR SHARE;
  IF NOT FOUND
     OR v_event.start_date        IS DISTINCT FROM v_date
     OR v_event.start_time        IS DISTINCT FROM v_time
     OR v_event.recurrence_rule   IS DISTINCT FROM (p_schedule->>'recurrence_rule')
     OR v_event.event_type::text  IS DISTINCT FROM (p_schedule->>'event_type')
     OR v_event.active            IS DISTINCT FROM v_active THEN
    RETURN -1;  -- schedule_changed: insert nothing
  END IF;

  INSERT INTO event_instances (event_id, scheduled_at, event_name_snapshot,
                               event_name_snapshot_id, status)
  SELECT DISTINCT p_event_id, s, v_event.name, v_event.name_id,
         'scheduled'::instance_status_enum
    FROM unnest(p_slots) AS s
  ON CONFLICT (event_id, scheduled_at) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.materialize_event_slots(uuid, jsonb, timestamptz[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_event_slots(uuid, jsonb, timestamptz[])
  TO service_role;

COMMENT ON FUNCTION public.materialize_event_slots(uuid, jsonb, timestamptz[]) IS
'S9.5-T5.5 P2: materializer per-event insert. Locks the event FOR SHARE; if its schedule (start_date/start_time/recurrence_rule/event_type/active) differs from p_schedule returns -1 and inserts nothing, else inserts p_slots ON CONFLICT DO NOTHING and returns the count. service_role only. Never deletes.';

-- ============================================================
-- § 4  Post-conditions
-- ============================================================

DO $$
DECLARE
  v_sig constant text := 'public.apply_event_schedule_change(uuid,jsonb,jsonb,jsonb,timestamptz[])';
BEGIN
  IF NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'apply_event_schedule_change ACL — expected EXECUTE authenticated only';
  END IF;
  IF has_function_privilege('anon', 'public.events_schedule_lock()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.events_schedule_lock()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.events_schedule_lock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'events_schedule_lock() ACL changed — expected no API role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.events_schedule_lock()'::regprocedure
                    AND prosecdef
                    AND prosrc LIKE '%app.event_schedule_change%') THEN
    RAISE EXCEPTION 'events_schedule_lock() not replaced';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_events_schedule_lock') <> 1 THEN
    RAISE EXCEPTION 'trg_events_schedule_lock count <> 1';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.materialize_event_slots(uuid,jsonb,timestamptz[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.materialize_event_slots(uuid,jsonb,timestamptz[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.materialize_event_slots(uuid,jsonb,timestamptz[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'materialize_event_slots ACL — expected EXECUTE service_role only';
  END IF;
END $$;
