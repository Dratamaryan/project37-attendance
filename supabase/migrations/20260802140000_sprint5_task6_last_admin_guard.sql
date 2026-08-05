-- Migration: sprint5_task6_last_admin_guard
-- Sprint 5 Task 6 — enforce_last_admin() trigger on app_users.
--
-- Prevents any UPDATE or DELETE on app_users from leaving zero active admins
-- (role='admin' AND active=true). Covers both a role demotion (admin ->
-- organizer) and a deactivation (active true -> false), and DELETE for
-- defense-in-depth even though the app only ever soft-deactivates via the
-- `active` flag.
--
-- Concurrency: pg_advisory_xact_lock on a fixed key serializes the
-- count-and-check across concurrent transactions removing DIFFERENT admins.
-- Two concurrent demotes of two different admins (starting from exactly 2
-- active admins) must not both succeed — see docs/sprint-5-task-6-verify.md
-- for the two-connection concurrency test proving this.
--
-- Sequenced AFTER the T6 orphan cleanup (docs/sprint-5-task-6-verify.md):
-- prod's active-admin count is confirmed a true 1 (admin@example.com)
-- before this trigger goes live, so the invariant isn't immediately
-- tested against polluted test-residue data.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_users'
  ) THEN
    RAISE EXCEPTION 'app_users missing in prod — cannot attach last-admin trigger';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_last_admin') THEN
    RAISE EXCEPTION 'enforce_last_admin() already exists — prod drift, aborting';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_last_admin') THEN
    RAISE EXCEPTION 'trg_enforce_last_admin already exists — prod drift, aborting';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_last_admin()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  active_admin_count int;
  removing boolean;
BEGIN
  removing := (OLD.role = 'admin' AND OLD.active = true) AND
    (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.active = false);

  IF NOT removing THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Serialize every concurrent admin-count-affecting write on one fixed key
  -- so two transactions demoting/deactivating two DIFFERENT admins can't
  -- both observe count=2 and both succeed, leaving zero admins.
  PERFORM pg_advisory_xact_lock(hashtext('app_users:last_admin_guard'));

  SELECT count(*) INTO active_admin_count
  FROM app_users
  WHERE role = 'admin' AND active = true;

  IF active_admin_count <= 1 THEN
    RAISE EXCEPTION 'last_admin: cannot remove the last active admin' USING ERRCODE = 'P0001';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_enforce_last_admin
  BEFORE UPDATE OR DELETE ON app_users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_last_admin();
