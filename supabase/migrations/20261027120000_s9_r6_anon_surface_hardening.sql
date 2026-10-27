-- Migration: s9_r6_anon_surface_hardening
-- Sprint 9 R6 — decisions D1 / D2 (AC 5, AC 17). Privilege changes only:
-- no DDL, no data.
--
-- D1 (AC 17) — the five S3 analytics views. Their SELECT was revoked from
-- anon in S3, but anon still held INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN (Supabase default grants), and
-- authenticated held the same write-side set. All seven are
-- security_invoker = on aggregates — nobody writes through them. After this:
-- anon / PUBLIC hold nothing, authenticated holds SELECT only.
--
-- D2 (AC 5) — the double-grant trap. Each of the four functions below held
-- BOTH a PUBLIC EXECUTE entry (=X, the CREATE FUNCTION default) AND explicit
-- role grants. Revoking from a single role leaves EXECUTE reachable through
-- PUBLIC, so PUBLIC is revoked explicitly in every statement.
--   - enforce_last_admin(): a trigger function (app_users.trg_enforce_last_admin
--     is its only user; triggers fire regardless of the caller's EXECUTE).
--     Revoked from PUBLIC AND anon.
--   - is_admin(), is_organizer(), is_active_app_user(): revoked from PUBLIC
--     ONLY — anon keeps its explicit EXECUTE on purpose. anon still holds the
--     Supabase default table grants on the legacy tables, so anon queries
--     evaluate the TO public RLS policies, which call these helpers with the
--     caller's privileges. Revoking anon now would turn today's empty results
--     into 42501 "permission denied for function is_admin". The anon revoke
--     on the helpers is deferred to S11-T12, after those table grants go.
-- authenticated and service_role keep their explicit EXECUTE on all four
-- (asserted in tests/integration/s9-r6-anon-surface.test.ts, not re-granted).
--
-- Deliberately NOT here: the legacy-table and sequence default grants to anon
-- (arwdDxtm / rwU) — left for S11-T12.

-- ── D1: S3 views ─────────────────────────────────────────────────────────────

REVOKE ALL ON public.attendance_summary FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.attendance_summary FROM authenticated;

REVOKE ALL ON public.event_attendance_trend FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.event_attendance_trend FROM authenticated;

REVOKE ALL ON public.new_vs_returning_monthly FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.new_vs_returning_monthly FROM authenticated;

REVOKE ALL ON public.parish_breakdown FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.parish_breakdown FROM authenticated;

REVOKE ALL ON public.person_attendance_counts FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.person_attendance_counts FROM authenticated;

-- ── D2: function EXECUTE ─────────────────────────────────────────────────────

-- anon keeps its explicit grant on these three until S11-T12 (see header).
REVOKE EXECUTE ON FUNCTION public.is_admin(), public.is_organizer(),
  public.is_active_app_user() FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.enforce_last_admin() FROM PUBLIC, anon;
