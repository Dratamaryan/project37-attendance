-- Migration: s9_5_t5_5_schedule_lock_public_note
-- S9.5-T5.5 Phase 1 — schedule lock + public schedule note.
--
-- Why: editing an event's start_time did not move existing occurrences
-- (impl_updateEvent never touches event_instances), and the next materializer
-- run (cron, or any createEvent — it materializes ALL active events) would
-- then insert a second set of rows at the new time: the conflict key
-- (event_id, scheduled_at) never matches across times. Until a real
-- "move the series" exists, the schedule of an event with upcoming
-- occurrences is locked at the database layer.
--
-- § 1  events.schedule_note (EN) / events.schedule_note_id (ID): optional
--      public line shown under the time on the RSVP page, in its metadata
--      description and in the WhatsApp share text. <= 160 characters each
--      (char_length = code points). Same EN/ID pair shape as name/name_id.
-- § 2  get_rsvp_context: open branch also returns schedule_note and
--      schedule_note_id (read live from events, like location). Everything
--      else byte-identical to 20261020120000_sprint9_r0_rsvp.sql § 4.
--      CREATE OR REPLACE keeps the existing ACL (EXECUTE anon only) — no
--      grant statements here; § 4 asserts it.
-- § 3  events_schedule_lock() + trg_events_schedule_lock (BEFORE UPDATE,
--      every role incl. service_role/postgres): if start_date, start_time,
--      recurrence_rule or event_type changes (IS DISTINCT FROM) while the
--      event has any occurrence with scheduled_at > now() and status
--      'scheduled' or 'cancelled' → RAISE 'event:schedule_locked' (P0001).
--      Cancelled rows count: they hold their slot so the materializer never
--      recreates them; a schedule change would leave them behind at the old
--      time. A no-op save (same values re-sent) passes: time '15:00' vs
--      stored '15:00:00' compares equal as time.
--      SECURITY DEFINER so the EXISTS check sees every row whatever the
--      caller's RLS; pinned search_path; EXECUTE revoked from every API role
--      (triggers fire regardless of the caller's EXECUTE — R6 pattern).
--
-- Refusal pattern: RAISE EXCEPTION '<area>:<code>' USING ERRCODE = 'P0001'
-- (house pattern: 'reschedule:<code>', 'last_admin: …').
-- No data changes.

-- ============================================================
-- § 0  Pre-flight: hard-abort before any DDL if the target has drifted.
-- ============================================================

DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'events'
         AND column_name IN ('id', 'start_date', 'start_time', 'recurrence_rule',
                             'event_type', 'location', 'duration_min')) <> 7 THEN
    RAISE EXCEPTION 'events column(s) missing — drift, aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'events'
                AND column_name IN ('schedule_note', 'schedule_note_id')) THEN
    RAISE EXCEPTION 'events.schedule_note(_id) already exists — drift, aborting';
  END IF;
  IF to_regprocedure('public.get_rsvp_context(text)') IS NULL THEN
    RAISE EXCEPTION 'get_rsvp_context(text) missing — drift, aborting';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_rsvp_context(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon cannot EXECUTE get_rsvp_context(text) — drift, aborting';
  END IF;
  IF to_regprocedure('public.rsvp_instance_open(uuid)') IS NULL THEN
    RAISE EXCEPTION 'rsvp_instance_open(uuid) missing — drift, aborting';
  END IF;
  IF to_regprocedure('public.events_schedule_lock()') IS NOT NULL THEN
    RAISE EXCEPTION 'events_schedule_lock() already exists — drift, aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_events_schedule_lock') THEN
    RAISE EXCEPTION 'trg_events_schedule_lock already exists — drift, aborting';
  END IF;
END $$;

-- ============================================================
-- § 1  Columns
-- ============================================================

ALTER TABLE events
  ADD COLUMN schedule_note text
    CONSTRAINT events_schedule_note_len CHECK (char_length(schedule_note) <= 160),
  ADD COLUMN schedule_note_id text
    CONSTRAINT events_schedule_note_id_len CHECK (char_length(schedule_note_id) <= 160);

COMMENT ON COLUMN events.schedule_note IS
'S9.5-T5.5: optional public schedule note (EN), shown under the time on the RSVP page, in its metadata description and in the WhatsApp share text. <= 160 chars.';
COMMENT ON COLUMN events.schedule_note_id IS
'S9.5-T5.5: optional public schedule note (ID). Same surfaces as schedule_note. <= 160 chars.';

-- ============================================================
-- § 2  get_rsvp_context(p_token) — public page context (+ schedule note)
-- ============================================================
-- Any closed/unknown state returns exactly {"open": false} — no hint whether
-- the token exists, is inactive, expired, or the instance has ended.

CREATE OR REPLACE FUNCTION public.get_rsvp_context(p_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) > 64 THEN
    RETURN '{"open":false}'::jsonb;
  END IF;

  SELECT jsonb_build_object(
           'open',          true,
           'event_name',    ei.event_name_snapshot,
           'event_name_id', ei.event_name_snapshot_id,
           'scheduled_at',  ei.scheduled_at,
           'duration_min',  e.duration_min,
           'location',      e.location,
           'image_url',     ei.image_url,
           'schedule_note',    e.schedule_note,
           'schedule_note_id', e.schedule_note_id
         )
    INTO v_result
    FROM event_rsvp_links l
    JOIN event_instances ei ON ei.id = l.event_instance_id
    JOIN events e           ON e.id = ei.event_id
   WHERE l.token = p_token
     AND l.is_active
     AND (l.expires_at IS NULL OR l.expires_at > now())
     AND rsvp_instance_open(l.event_instance_id);

  RETURN COALESCE(v_result, '{"open":false}'::jsonb);
END;
$$;

-- ============================================================
-- § 3  events_schedule_lock() + trigger
-- ============================================================

CREATE FUNCTION public.events_schedule_lock()
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
      RAISE EXCEPTION 'event:schedule_locked' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.events_schedule_lock()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_events_schedule_lock
  BEFORE UPDATE ON events
  FOR EACH ROW
  EXECUTE FUNCTION public.events_schedule_lock();

COMMENT ON FUNCTION public.events_schedule_lock() IS
'S9.5-T5.5: refuses a change to start_date/start_time/recurrence_rule/event_type while the event has a future scheduled or cancelled occurrence (event:schedule_locked, P0001). Every role.';

-- ============================================================
-- § 4  Post-conditions
-- ============================================================

DO $$
BEGIN
  IF NOT has_function_privilege('anon', 'public.get_rsvp_context(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_rsvp_context(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_rsvp_context(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_rsvp_context ACL changed — expected EXECUTE anon only';
  END IF;
  IF has_function_privilege('anon', 'public.events_schedule_lock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can EXECUTE events_schedule_lock() — expected revoked';
  END IF;
END $$;
