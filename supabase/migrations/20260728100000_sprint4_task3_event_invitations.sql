-- Migration: sprint4_task3_event_invitations
-- Sprint 4 Task 3 — event_invitations table + RLS + indexes. CREATE, not ALTER
-- (table confirmed absent from prod in T1/V1, re-confirmed at T3 plan time).
--
-- .env.local on the dev machine resolves to PRODUCTION. This migration only
-- CREATEs — no destructive statement is in scope — but flagging per the
-- standing guard for any migration touching prod.
--
-- Instance-keyed correction (locked Sprint 4 decision, amends the original
-- Notion Schema draft which wrongly keyed this table on events(id)):
-- `events` is the recurring-series template; `event_instances` is the
-- per-occurrence row. Keying on event_id + UNIQUE(event_id, person_id) would
-- allow inviting a person to a recurring series exactly once, ever. The FK
-- and the unique constraint both key on event_instance_id instead.
--
-- Column-set note: this deliberately diverges from the Notion Schema page's
-- Sprint 4 addendum (channel/invited_at/rsvp_status_enum) — the task-brief
-- shape (status/sent_at/error/invited_by/created_at) is what T4-09's
-- resumable send needs: a delivery-status field distinct from rsvp_status,
-- since rsvp_status_enum (pending/accepted/declined/maybe) has no cell for
-- delivery failure. Architect will correct the Notion page to match.

-- Pre-flight: hard-abort before any DDL if prod has drifted from the state
-- this migration was written against. Supabase runs each migration in a
-- transaction, so RAISE EXCEPTION here rolls back cleanly — a loud abort
-- beats a CREATE TABLE that succeeds followed by a CREATE POLICY referencing
-- a missing/renamed helper, which would leave the table with no RLS.
DO $$
BEGIN
  IF to_regclass('public.event_invitations') IS NOT NULL THEN
    RAISE EXCEPTION 'event_invitations already exists — prod drift, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    RAISE EXCEPTION 'is_admin() missing in prod — RLS would half-apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_organizer') THEN
    RAISE EXCEPTION 'is_organizer() missing in prod — RLS would half-apply';
  END IF;
END $$;

CREATE TABLE event_invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_instance_id uuid NOT NULL REFERENCES event_instances (id) ON DELETE CASCADE,
  person_id         uuid NOT NULL REFERENCES people (id),
  status            text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at           timestamptz,
  error             text,
  rsvp_status       text,              -- dormant Sprint 4: no writer, no test case
  responded_at      timestamptz,       -- dormant Sprint 4
  invited_by        uuid NOT NULL REFERENCES app_users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_invite UNIQUE (event_instance_id, person_id)
);

CREATE INDEX idx_invitations_instance ON event_invitations (event_instance_id);
CREATE INDEX idx_invitations_person   ON event_invitations (person_id);

ALTER TABLE event_invitations ENABLE ROW LEVEL SECURITY;

-- Admin: full CRUD.
CREATE POLICY event_invitations_admin_all
  ON event_invitations FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Organizer: read-only. is_organizer() (role = 'organizer', excludes admins)
-- chosen over is_active_app_user() to match the app_settings two-tier shape —
-- admin already has full access via admin_all, so this policy only needs to
-- add organizer read, not re-grant admin.
--
-- Note for T9/T10 (no action needed in T3): /admin/events/layout.tsx gates
-- admin-OR-organizer, so an organizer can reach the future invite page even
-- though this policy gives them read-only. The send action needs its own
-- admin-only guard at the action level — the permissive shared layout won't
-- stop the page from loading. This RLS is the backstop, not the primary
-- control.
CREATE POLICY event_invitations_organizer_select
  ON event_invitations FOR SELECT
  USING (is_organizer());

-- Anonymous: no policy. RLS default-denies once enabled.
