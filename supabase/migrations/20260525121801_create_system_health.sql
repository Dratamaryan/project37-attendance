-- Migration: create_system_health
-- Free-tier keep-alive table. Written by /api/cron/heartbeat via admin client.
-- Remove this table and the cron when migrating to Supabase Pro.

CREATE TABLE system_health (
  id               bigserial PRIMARY KEY,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  table_row_counts jsonb,
  status           text NOT NULL DEFAULT 'ok',
  notes            text
);

CREATE INDEX idx_system_health_checked_at ON system_health (checked_at DESC);

ALTER TABLE system_health ENABLE ROW LEVEL SECURITY;

-- Only admins can read heartbeat rows. Writes bypass RLS via the admin client.
CREATE POLICY "admin_select" ON system_health
  FOR SELECT USING (is_admin());
