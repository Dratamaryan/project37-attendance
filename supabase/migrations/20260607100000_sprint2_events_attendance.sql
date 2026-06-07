-- Migration: sprint2_events_attendance
-- Creates: event_type_enum, instance_status_enum, is_active_app_user() helper,
--          events, event_instances, attendance tables + all indexes per docs/schema.md,
--          RLS policies for all three tables, 2-event idempotent seed.
-- Sprint 2 Task 2 — DB foundation only.

-- ============================================================
-- § 1  Enums
-- ============================================================

CREATE TYPE event_type_enum AS ENUM ('friday_biweekly', 'sunday_monthly', 'adhoc', 'other_recurring');
CREATE TYPE instance_status_enum AS ENUM ('scheduled', 'cancelled', 'completed');
-- NOTE: rsvp_status_enum is deferred to Sprint 4 (event_invitations table).

-- ============================================================
-- § 2  is_active_app_user() SECURITY DEFINER helper
--      Returns true for any active app_user (admin or organizer).
--      SECURITY DEFINER runs as function owner, bypassing RLS on
--      app_users — same pattern as is_admin() and is_organizer()
--      from Sprint 0/1. Prevents recursive RLS evaluation when
--      organizer policies query app_users inside another table's
--      policy.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_active_app_user()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users
    WHERE id = auth.uid()
      AND active = true
  );
$$;

-- ============================================================
-- § 3  events — event templates
-- ============================================================

CREATE TABLE events (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text         NOT NULL,
  name_id         text,
  event_type      event_type_enum NOT NULL,
  start_date      date         NOT NULL,
  start_time      time         NOT NULL,   -- wall-clock, interpreted as Asia/Jakarta at materialization
  duration_min    integer      NOT NULL DEFAULT 120,
  location        text,
  description     text,
  recurrence_rule text,                    -- RFC 5545 RRULE string; NULL for adhoc
  active          boolean      NOT NULL DEFAULT true,
  created_by      uuid         NOT NULL REFERENCES app_users (id),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- ============================================================
-- § 4  event_instances — concrete dated occurrences
-- ============================================================

CREATE TABLE event_instances (
  id                     uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               uuid               NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  scheduled_at           timestamptz        NOT NULL,
  event_name_snapshot    text               NOT NULL,   -- EN name at creation time; never updated
  event_name_snapshot_id text,                          -- ID name at creation time; nullable
  status                 instance_status_enum NOT NULL DEFAULT 'scheduled',
  notes                  text,
  created_at             timestamptz        NOT NULL DEFAULT now()
);

-- ============================================================
-- § 5  attendance — the log
-- ============================================================

CREATE TABLE attendance (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_instance_id uuid        NOT NULL REFERENCES event_instances (id) ON DELETE CASCADE,
  person_id         uuid        NOT NULL REFERENCES people (id),  -- NO ON DELETE: people only soft-delete
  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  checked_in_by     uuid        NOT NULL REFERENCES app_users (id),
  source            text        DEFAULT 'volunteer_checkin',
  CONSTRAINT uniq_attendance UNIQUE (event_instance_id, person_id)
);

-- ============================================================
-- § 6  Indexes — exactly per docs/schema.md
--      events: no indexes specified in schema doc
-- ============================================================

CREATE UNIQUE INDEX idx_event_instances_event_date ON event_instances (event_id, scheduled_at);
CREATE INDEX         idx_event_instances_scheduled  ON event_instances (scheduled_at);

CREATE INDEX idx_attendance_event      ON attendance (event_instance_id);
CREATE INDEX idx_attendance_person     ON attendance (person_id);
CREATE INDEX idx_attendance_checked_in ON attendance (checked_in_at DESC);

-- ============================================================
-- § 7  Row Level Security
-- ============================================================

ALTER TABLE events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance      ENABLE ROW LEVEL SECURITY;

-- ── events ───────────────────────────────────────────────────

-- Admin: full CRUD
CREATE POLICY events_admin_all ON events
  FOR ALL
  USING      (is_admin())
  WITH CHECK (is_admin());

-- Organizer: read any event
CREATE POLICY events_organizer_select ON events
  FOR SELECT
  TO authenticated
  USING (is_active_app_user());

-- Organizer: create own events only — WITH CHECK prevents created_by spoofing
CREATE POLICY events_organizer_insert ON events
  FOR INSERT
  TO authenticated
  WITH CHECK (is_active_app_user() AND created_by = auth.uid());

-- Organizer: update any event (no delete — intentional gap forces admin for destructive ops)
CREATE POLICY events_organizer_update ON events
  FOR UPDATE
  TO authenticated
  USING      (is_active_app_user())
  WITH CHECK (is_active_app_user());

-- ── event_instances ───────────────────────────────────────────

-- Admin: full CRUD
CREATE POLICY event_instances_admin_all ON event_instances
  FOR ALL
  USING      (is_admin())
  WITH CHECK (is_admin());

-- Organizer: read instances (write is cron-only, via admin client)
CREATE POLICY event_instances_organizer_select ON event_instances
  FOR SELECT
  TO authenticated
  USING (is_active_app_user());

-- ── attendance ────────────────────────────────────────────────

-- Admin: full CRUD
CREATE POLICY attendance_admin_all ON attendance
  FOR ALL
  USING      (is_admin())
  WITH CHECK (is_admin());

-- Organizer: read all attendance records
CREATE POLICY attendance_organizer_select ON attendance
  FOR SELECT
  TO authenticated
  USING (is_active_app_user());

-- Organizer: create attendance — checked_in_by must equal caller's uid.
-- Prevents identity spoofing: an organizer cannot forge an admin's name onto a check-in.
CREATE POLICY attendance_organizer_insert ON attendance
  FOR INSERT
  TO authenticated
  WITH CHECK (is_active_app_user() AND checked_in_by = auth.uid());

-- ============================================================
-- § 8  Seed — 2 events (idempotent)
--
--      Guard strategy: skip entire block if events table is
--      non-empty. Trade-off: if a seed event is manually deleted
--      later, re-running the migration will not restore it.
--      Acceptable for dev/init; restore by running the INSERT
--      directly if needed.
-- ============================================================

DO $$
DECLARE
  admin_id uuid;
BEGIN
  IF (SELECT COUNT(*) FROM events) > 0 THEN
    RAISE NOTICE 'events table not empty; Sprint 2 seed skipped';
    RETURN;
  END IF;

  SELECT id INTO admin_id
  FROM app_users
  WHERE role = 'admin' AND active = true
  ORDER BY created_at
  LIMIT 1;

  IF admin_id IS NULL THEN
    RAISE WARNING 'sprint2_seed: no active admin user found in app_users — skipping event seed. Run Sprint 0 Task 8 seed first.';
    RETURN;
  END IF;

  INSERT INTO events (
    name, name_id, event_type, start_date, start_time,
    duration_min, location, recurrence_rule, created_by
  ) VALUES
    (
      'Project Day',   'Project Day', 'friday_biweekly',
      DATE '2026-07-10', TIME '18:00', 120,
      'Hotel Neo Puri Indah',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      admin_id
    ),
    (
      'Tribe Connect', 'Obor Doa', 'sunday_monthly',
      DATE '2026-07-05', TIME '15:00', 120,
      'Sutera Onyx XI no 10-12',
      'FREQ=MONTHLY;BYDAY=1SU',
      admin_id
    );

  RAISE NOTICE 'Sprint 2 seed: 2 events inserted (admin actor %)', admin_id;
END $$;
