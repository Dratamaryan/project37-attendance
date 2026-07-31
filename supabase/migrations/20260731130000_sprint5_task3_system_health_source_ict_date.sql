-- Migration: sprint5_task3_system_health_source_ict_date
-- Sprint 5 Task 3 — additive: typed source/ict_date columns on system_health
-- + partial unique index, ahead of T5's cron rewrite.
--
-- Today source/ict_date live only as keys inside table_row_counts (jsonb),
-- written inconsistently by birthday-digest, attendance-summary, and
-- materialize crons. This migration adds typed columns and the going-forward
-- idempotency constraint; the crons themselves aren't rewired until T5.
--
-- No backfill from table_row_counts jsonb:
--   (a) historical rows don't need the going-forward idempotency constraint.
--   (b) backfilling risks surfacing a duplicate (source, ict_date) already
--       present in history -- the exact double-send this index guards
--       against -- which would make CREATE UNIQUE INDEX fail at creation.
-- Typed columns stay NULL for all existing rows and interim cron writes
-- until T5. The partial index (WHERE ict_date IS NOT NULL) excludes every
-- NULL-ict_date row, so it's dormant for the whole T3->T5 window -- no
-- conflict risk, since nothing writes non-null values to these columns yet.
--
-- No DO-block drift guard (deviation from T2's precedent, confirmed at plan
-- review): ADD COLUMN and CREATE UNIQUE INDEX already fail loud natively
-- (42701 column exists, 42P07 duplicate index, 42P01 missing table). Both
-- columns are added in the same transaction as the index, so they're
-- guaranteed empty at index-creation time -- the partial index can't fail on
-- duplicate data either. A guard here would be custom error text over native
-- safety, nothing more.
--
-- Index: plain non-concurrent CREATE UNIQUE INDEX. system_health is a tiny
-- heartbeat table; the brief ACCESS EXCLUSIVE lock is fine. CONCURRENTLY
-- can't run inside a migration transaction.
--
-- Lock safety: both ADD COLUMN are nullable, no default -- metadata-only, no
-- table rewrite. The index build is the only lock, and it's brief given
-- table size.
--
-- RLS: no policy changes. system_health only has admin_select (row-level
-- USING (is_admin())); new columns are covered automatically. Writes go
-- through the admin client (bypasses RLS) so no INSERT/UPDATE policy needed.
--
-- audit_log: not applicable -- system_health isn't PII, no audit write
-- required for this migration.
--
-- .env.local on the dev machine resolves to PRODUCTION. This migration only
-- ALTERs to add columns + one index -- no data rewrite, no destructive
-- statement -- flagging per the standing guard for any migration touching
-- prod.

ALTER TABLE system_health ADD COLUMN source text;
ALTER TABLE system_health ADD COLUMN ict_date date;

CREATE UNIQUE INDEX idx_system_health_source_ict_date
  ON system_health (source, ict_date) WHERE ict_date IS NOT NULL;
