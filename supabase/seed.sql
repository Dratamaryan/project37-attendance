-- Local development / test seed. Runs ONLY on `supabase db reset` / `db start`
-- against local Docker. Never applied to prod — `supabase db push` only ever
-- pushes supabase/migrations/*.sql; seed.sql has no equivalent prod concept.
--
-- Baseline admin so local integration tests are never accidentally the "sole
-- active admin" — a scenario the T6 last-admin trigger (enforce_last_admin(),
-- 20260802140000_sprint5_task6_last_admin_guard.sql) now correctly blocks.
-- Test suites that create + tear down their own temporary admin fixture
-- (e.g. tests/integration/events-actions.test.ts) need at least one other
-- admin already present, or their teardown gets correctly rejected by the
-- trigger. No auth.users row needed — app_users.id has no FK there (same
-- pattern events-actions.test.ts already uses for its FAKE_ADMIN_ID).
INSERT INTO app_users (id, email, full_name, role, active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'baseline-admin@local.test',
  'Local Baseline Admin (seed.sql — local Docker only, never in prod)',
  'admin',
  true
)
ON CONFLICT (id) DO NOTHING;
