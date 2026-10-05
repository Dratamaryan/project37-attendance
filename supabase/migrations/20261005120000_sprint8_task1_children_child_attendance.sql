-- Migration: sprint8_task1_children_child_attendance
-- S8-T1: children + child_attendance schema.
-- children     = people-shaped (soft-deletable entity, APP-MANAGED updated_at, no trigger).
-- child_attendance = attendance-shaped append log, SEPARATE from adult attendance
--                    so adult attendance stays ground truth.

-- ── Prod-drift preflight abort ────────────────────────────────────────────────
-- Pre-flight: hard-abort before any DDL if prod has drifted from the state
-- this migration was written against (schema live-verified on staging at S8-T1
-- recon). Supabase runs each migration in a transaction, so RAISE EXCEPTION
-- here rolls back cleanly — a loud abort beats a CREATE TABLE that succeeds
-- followed by a CREATE POLICY referencing a missing/renamed helper, which
-- would leave the table with no RLS.
DO $$
BEGIN
  IF to_regclass('public.people') IS NULL THEN
    RAISE EXCEPTION 'people missing in prod — children FK would fail';
  END IF;
  IF to_regclass('public.event_instances') IS NULL THEN
    RAISE EXCEPTION 'event_instances missing in prod — child_attendance FK would fail';
  END IF;
  IF to_regclass('public.app_users') IS NULL THEN
    RAISE EXCEPTION 'app_users missing in prod — child_attendance FK would fail';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type
                 WHERE typname = 'gender_enum'
                   AND typnamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'gender_enum missing in prod — children.gender would fail';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    RAISE EXCEPTION 'is_admin() missing in prod — RLS would half-apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_organizer') THEN
    RAISE EXCEPTION 'is_organizer() missing in prod — RLS would half-apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_active_app_user') THEN
    RAISE EXCEPTION 'is_active_app_user() missing in prod — RLS would half-apply';
  END IF;
  IF to_regclass('public.children') IS NOT NULL THEN
    RAISE EXCEPTION 'children already exists — prod drift, aborting';
  END IF;
  IF to_regclass('public.child_attendance') IS NOT NULL THEN
    RAISE EXCEPTION 'child_attendance already exists — prod drift, aborting';
  END IF;
END $$;

-- ── children (people-shaped) ──────────────────────────────────────────────────
CREATE TABLE public.children (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_person_id uuid NOT NULL REFERENCES public.people(id)
                     ON DELETE NO ACTION ON UPDATE NO ACTION,
  full_name        text NOT NULL,
  birth_date       date,
  gender           public.gender_enum,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
COMMENT ON TABLE public.children IS
  'Children linked to a parent in people. People-shaped: soft-delete via deleted_at; '
  'updated_at is APP-MANAGED (no trigger — set explicitly on every UPDATE, mirroring people).';

CREATE INDEX idx_children_parent ON public.children USING btree (parent_person_id);

ALTER TABLE public.children ENABLE ROW LEVEL SECURITY;
-- mirrors people: per-command, is_admin()/is_organizer(), organizers can't see or
-- update soft-deleted rows, organizers have no DELETE. No anon policy (deny by default).
CREATE POLICY children_admin_select ON public.children
  FOR SELECT TO public USING (is_admin());
CREATE POLICY children_admin_insert ON public.children
  FOR INSERT TO public WITH CHECK (is_admin());
CREATE POLICY children_admin_update ON public.children
  FOR UPDATE TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY children_admin_delete ON public.children
  FOR DELETE TO public USING (is_admin());
CREATE POLICY children_organizer_select ON public.children
  FOR SELECT TO public USING (deleted_at IS NULL AND is_organizer());
CREATE POLICY children_organizer_insert ON public.children
  FOR INSERT TO public WITH CHECK (is_organizer());
CREATE POLICY children_organizer_update ON public.children
  FOR UPDATE TO public
  USING (deleted_at IS NULL AND is_organizer())
  WITH CHECK (deleted_at IS NULL AND is_organizer());

-- ── child_attendance (attendance-shaped append log) ───────────────────────────
CREATE TABLE public.child_attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_instance_id uuid NOT NULL REFERENCES public.event_instances(id) ON DELETE CASCADE,
  child_id          uuid NOT NULL REFERENCES public.children(id)
                      ON DELETE NO ACTION ON UPDATE NO ACTION,
  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  checked_in_by     uuid NOT NULL REFERENCES public.app_users(id),
  source            text DEFAULT 'volunteer_checkin'::text,
  CONSTRAINT uniq_child_attendance UNIQUE (event_instance_id, child_id)
);
COMMENT ON TABLE public.child_attendance IS
  'Child check-ins. Attendance-shaped append log, SEPARATE from adult attendance so '
  'adult attendance stays ground truth. Identity dedup via UNIQUE(event_instance_id, child_id).';

CREATE INDEX idx_child_attendance_checked_in ON public.child_attendance USING btree (checked_in_at DESC);
CREATE INDEX idx_child_attendance_event      ON public.child_attendance USING btree (event_instance_id);
CREATE INDEX idx_child_attendance_child      ON public.child_attendance USING btree (child_id);

ALTER TABLE public.child_attendance ENABLE ROW LEVEL SECURITY;
-- mirrors adult attendance exactly: admin ALL; active app users read + self-insert.
-- No anon policy (deny by default).
CREATE POLICY child_attendance_admin_all ON public.child_attendance
  FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY child_attendance_organizer_insert ON public.child_attendance
  FOR INSERT TO authenticated
  WITH CHECK (is_active_app_user() AND checked_in_by = auth.uid());
CREATE POLICY child_attendance_organizer_select ON public.child_attendance
  FOR SELECT TO authenticated USING (is_active_app_user());
