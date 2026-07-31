-- Migration: sprint5_task2_image_url_birthday_opt_in
-- Sprint 5 Task 2 — three additive columns, no index, no RLS change:
--   event_instances.image_url            text         NULLABLE, no default
--   people.birthday_email_opt_in         boolean      NOT NULL DEFAULT false
--   people.birthday_email_opt_in_at      timestamptz  NULLABLE
--
-- Lock safety: NOT NULL + constant DEFAULT is metadata-only on PG11+ (no table
-- rewrite, no backfill) — confirmed at plan review, this project runs PG15.
--
-- No index: image_url is display-only, never filtered/sorted. birthday_email_opt_in
-- is a low-cardinality boolean over ~200 people rows — seq scan is trivial; revisit
-- once a birthday-email send path exists and reads it at volume.
--
-- No RLS change: RLS predicates are row-level (USING/WITH CHECK), not per-column —
-- new columns on people / event_instances are already covered by the existing
-- policies (admin full CRUD, organizer read/create/update).
--
-- .env.local on the dev machine resolves to PRODUCTION. This migration only ALTERs
-- to add columns — no data rewrite, no destructive statement — but flagging per the
-- standing guard for any migration touching prod.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'event_instances'
  ) THEN
    RAISE EXCEPTION 'event_instances missing — earlier migration must run first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'people'
  ) THEN
    RAISE EXCEPTION 'people missing — earlier migration must run first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'event_instances' AND column_name = 'image_url'
  ) THEN
    RAISE EXCEPTION 'event_instances.image_url already exists — prod drift, aborting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'birthday_email_opt_in'
  ) THEN
    RAISE EXCEPTION 'people.birthday_email_opt_in already exists — prod drift, aborting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'people' AND column_name = 'birthday_email_opt_in_at'
  ) THEN
    RAISE EXCEPTION 'people.birthday_email_opt_in_at already exists — prod drift, aborting';
  END IF;
END $$;

ALTER TABLE event_instances ADD COLUMN image_url text;
ALTER TABLE people ADD COLUMN birthday_email_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE people ADD COLUMN birthday_email_opt_in_at timestamptz;
