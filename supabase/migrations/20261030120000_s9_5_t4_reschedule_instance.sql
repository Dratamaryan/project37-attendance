-- Migration: s9_5_t4_reschedule_instance
-- S9.5-T4 (design R2, locked in S9.5-T1): reschedule ONE occurrence of a
-- recurring event = cancel the original slot + insert a one-off instance on the
-- SAME event, in one transaction.
--
-- Why this shape:
--   - The cancelled original keeps its (event_id, scheduled_at) slot, so the
--     materializer's ON CONFLICT (event_id, scheduled_at) DO NOTHING never
--     recreates it.
--   - The materializer never touches a non-rule row inside the horizon; its
--     prune hard-deletes 'scheduled' rows only beyond now() + horizon, so the
--     new time must be inside the horizon (guard below).
--   - The one-off gets a NEW id → it needs its own RSVP link; RSVPs and
--     invitations already made stay on the cancelled original (accepted).
--
-- Access: SECURITY INVOKER, so every read/write goes through the caller's RLS
-- (event_instances_admin_all / events_admin_all / app_settings admin_select —
-- organizers cannot UPDATE or INSERT event_instances at all). The explicit
-- is_admin() check up front is for a typed refusal, not the enforcement layer.
-- search_path pinned (house pattern: 20261020120000_sprint9_r0_rsvp.sql).
-- The audit row goes through log_audit() (SECURITY DEFINER), whose actor is
-- COALESCE(auth.uid(), p_actor_user_id) — the real admin, never a parameter.
--
-- Refusals: RAISE EXCEPTION 'reschedule:<code>' USING ERRCODE = 'P0001'
-- (house pattern: 'last_admin: …' in 20260802140000_sprint5_task6_last_admin_guard.sql).
-- A refusal aborts the call, so nothing is written. Codes (mapped in
-- lib/actions/events.impl.ts impl_rescheduleInstance):
--   not_admin, invalid_input, not_found, not_scheduled, original_in_past,
--   event_inactive, not_recurring, new_in_past, beyond_horizon, same_time,
--   slot_taken, reason_required, reason_too_long
-- Never DELETEs.

-- ============================================================
-- § 0  Pre-flight: hard-abort before any DDL if the target has drifted.
--      Supabase runs each migration in a transaction, so RAISE EXCEPTION
--      here rolls back cleanly.
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure('public.reschedule_instance(uuid,timestamptz,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'reschedule_instance(uuid,timestamptz,text) already exists — drift, aborting';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'is_admin() missing — admin guard would fail';
  END IF;
  IF to_regprocedure('public.log_audit(uuid,text,text,text,jsonb,inet,text)') IS NULL THEN
    RAISE EXCEPTION 'log_audit(...) missing — drift, aborting';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'event_instances'
         AND column_name IN ('id', 'event_id', 'scheduled_at', 'event_name_snapshot',
                             'event_name_snapshot_id', 'status', 'notes')) <> 7 THEN
    RAISE EXCEPTION 'event_instances column(s) missing — drift, aborting';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events'
         AND column_name IN ('id', 'name', 'name_id', 'event_type', 'recurrence_rule', 'active')) <> 6 THEN
    RAISE EXCEPTION 'events column(s) missing — drift, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'app_settings'
                    AND column_name = 'materialization_horizon_mo') THEN
    RAISE EXCEPTION 'app_settings.materialization_horizon_mo missing — drift, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'idx_event_instances_event_date' AND i.indisunique) THEN
    RAISE EXCEPTION 'unique idx_event_instances_event_date missing — the slot guarantee would not hold';
  END IF;
END $$;

-- ============================================================
-- § 1  reschedule_instance
-- ============================================================

CREATE FUNCTION public.reschedule_instance(
  p_instance_id uuid,
  p_new_at      timestamptz,
  p_reason      text
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_reason  text := btrim(p_reason);
  v_orig    event_instances%ROWTYPE;
  v_event   events%ROWTYPE;
  v_horizon integer;
  v_new_id  uuid;
  v_from    text;
  v_to      text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'reschedule:not_admin' USING ERRCODE = 'P0001';
  END IF;

  IF p_instance_id IS NULL OR p_new_at IS NULL THEN
    RAISE EXCEPTION 'reschedule:invalid_input' USING ERRCODE = 'P0001';
  END IF;
  IF v_reason IS NULL OR v_reason = '' THEN
    RAISE EXCEPTION 'reschedule:reason_required' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reschedule:reason_too_long' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the original first, then judge it, so a concurrent cancel/flip
  -- can't slip between the checks and the writes.
  SELECT * INTO v_orig FROM event_instances WHERE id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reschedule:not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_orig.status <> 'scheduled' THEN
    RAISE EXCEPTION 'reschedule:not_scheduled' USING ERRCODE = 'P0001';
  END IF;
  IF v_orig.scheduled_at <= now() THEN
    RAISE EXCEPTION 'reschedule:original_in_past' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_event FROM events WHERE id = v_orig.event_id;
  IF NOT FOUND OR NOT v_event.active THEN
    RAISE EXCEPTION 'reschedule:event_inactive' USING ERRCODE = 'P0001';
  END IF;
  -- Adhoc events are edited directly, not rescheduled.
  IF v_event.event_type = 'adhoc' OR v_event.recurrence_rule IS NULL THEN
    RAISE EXCEPTION 'reschedule:not_recurring' USING ERRCODE = 'P0001';
  END IF;

  IF p_new_at <= now() THEN
    RAISE EXCEPTION 'reschedule:new_in_past' USING ERRCODE = 'P0001';
  END IF;
  -- Same fallback as lib/events/materialize.impl.ts (defaultHorizonMonths = 12).
  SELECT materialization_horizon_mo INTO v_horizon FROM app_settings LIMIT 1;
  v_horizon := COALESCE(v_horizon, 12);
  IF p_new_at > now() + make_interval(months => v_horizon) THEN
    RAISE EXCEPTION 'reschedule:beyond_horizon' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_at = v_orig.scheduled_at THEN
    RAISE EXCEPTION 'reschedule:same_time' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM event_instances
              WHERE event_id = v_orig.event_id AND scheduled_at = p_new_at) THEN
    RAISE EXCEPTION 'reschedule:slot_taken' USING ERRCODE = 'P0001';
  END IF;

  v_from := to_char(v_orig.scheduled_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') || ' WIB';
  v_to   := to_char(p_new_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') || ' WIB';

  UPDATE event_instances
     SET status = 'cancelled',
         notes  = 'Rescheduled to ' || v_to || ': ' || v_reason
   WHERE id = v_orig.id;

  -- Same columns/values the materializer writes (materialize.impl.ts insertRows).
  BEGIN
    INSERT INTO event_instances (event_id, scheduled_at, event_name_snapshot,
                                 event_name_snapshot_id, status, notes)
    VALUES (v_orig.event_id, p_new_at, v_event.name, v_event.name_id, 'scheduled',
            'Rescheduled from ' || v_from || ': ' || v_reason)
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost a race for the slot; re-raising aborts the whole call, cancel included.
    RAISE EXCEPTION 'reschedule:slot_taken' USING ERRCODE = 'P0001';
  END;

  PERFORM public.log_audit(
    auth.uid(),
    'event_instance.reschedule',
    'event_instance',
    v_orig.id::text,
    jsonb_build_object(
      'from_instance_id', v_orig.id,
      'to_instance_id',   v_new_id,
      'from_at',          v_orig.scheduled_at,
      'to_at',            p_new_at,
      'reason',           v_reason
    )
  );

  RETURN v_new_id;
END;
$$;

-- Authenticated only: revoke the implicit PUBLIC grant and the per-role grants
-- this schema's default privileges hand to anon/service_role on every new
-- function (S9-R6 anon-EXECUTE allowlist stays unchanged).
REVOKE EXECUTE ON FUNCTION public.reschedule_instance(uuid, timestamptz, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_instance(uuid, timestamptz, text) TO authenticated;

COMMENT ON FUNCTION public.reschedule_instance(uuid, timestamptz, text) IS
'S9.5-T4: admin-only. Cancels one future scheduled occurrence of a recurring event and inserts a one-off on the same event at p_new_at (inside the materialization horizon), atomically; audit event_instance.reschedule. Returns the new instance id.';
