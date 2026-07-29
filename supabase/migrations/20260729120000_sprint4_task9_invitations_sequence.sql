-- Migration: sprint4_task9_invitations_sequence
-- Sprint 4 Task 9 — adds the SEQUENCE source for resend (.ics RFC 5545 SEQUENCE,
-- E/4's one-way-door mechanism). T3's locked schema didn't anticipate this column;
-- the task brief itself named it as the likely resolution ("a column on
-- event_invitations"). Approved at T9 plan review.
--
-- Semantics (locked at T9 plan review): sequence increments if and only if an
-- explicit resendInvite() call happens — never on a routine sendInvites() retry
-- of a pending/failed row, since that row was never successfully delivered and
-- there is nothing on the recipient's calendar yet to update. Starts at 0 (the
-- value used for every invitee's first .ics), matching generateIcs()'s existing
-- `sequence` parameter which already defaults callers to treating 0 as "first
-- send" (see lib/events/ics.ts ICS-13).
--
-- .env.local on the dev machine resolves to PRODUCTION. This migration only
-- ALTERs to add a column with a DEFAULT — no data rewrite, no destructive
-- statement — but flagging per the standing guard for any migration touching prod.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'event_invitations'
  ) THEN
    RAISE EXCEPTION 'event_invitations missing — T3 migration must run first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_invitations' AND column_name = 'sequence'
  ) THEN
    RAISE EXCEPTION 'event_invitations.sequence already exists — prod drift, aborting';
  END IF;
END $$;

ALTER TABLE event_invitations ADD COLUMN sequence integer NOT NULL DEFAULT 0;
