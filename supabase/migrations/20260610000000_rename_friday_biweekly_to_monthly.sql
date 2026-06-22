-- Migration: rename friday_biweekly → friday_monthly in event_type_enum
--
-- Run in: Supabase Dashboard → SQL Editor (production)
--         supabase migration up  (Docker dev)
--
-- Effect:
--   • Adds friday_monthly to the enum
--   • Updates all friday_biweekly events to friday_monthly + correct RRULE
--   • Deletes future scheduled instances so the cron re-materialises correctly
--   • Recreates the enum without the old value
--
-- After running: trigger /api/cron/materialize-events to regenerate instances.

BEGIN;

-- Step 1: Add new value to the existing enum
ALTER TYPE event_type_enum ADD VALUE IF NOT EXISTS 'friday_monthly';

COMMIT;
-- Enum additions must be committed before the value can be used in DML.

BEGIN;

-- Steps 2-4: guarded so the migration is idempotent on fresh resets.
-- On a fresh `supabase db reset`, Sprint 2 already creates event_type_enum
-- without 'friday_biweekly', so there is nothing to rename. Without this
-- guard the UPDATE fails with "invalid input value for enum event_type_enum:
-- 'friday_biweekly'" because PostgreSQL validates the literal at parse time.
DO $$
DECLARE
  v_has_old_value boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'event_type_enum' AND e.enumlabel = 'friday_biweekly'
  ) INTO v_has_old_value;

  IF NOT v_has_old_value THEN
    RAISE NOTICE 'rename_friday: friday_biweekly not in enum — steps 2-4 skipped (already migrated or fresh reset)';
    RETURN;
  END IF;

  -- Step 2: Update affected events (cast to text to avoid enum literal validation)
  UPDATE events
  SET
    event_type      = 'friday_monthly',
    recurrence_rule = 'FREQ=MONTHLY;BYDAY=2FR',
    updated_at      = now()
  WHERE event_type::text = 'friday_biweekly';

  -- Step 3: Delete future scheduled instances so they re-materialise on the
  -- correct schedule. Past instances (completed/cancelled) are left intact.
  DELETE FROM event_instances
  WHERE event_id IN (
    SELECT id FROM events WHERE event_type = 'friday_monthly'
  )
  AND status = 'scheduled'
  AND scheduled_at > now();

  -- Step 4: Recreate enum without the old value (DDL via EXECUTE inside DO block)
  EXECUTE 'ALTER TYPE event_type_enum RENAME TO event_type_enum_old';
  EXECUTE $q$
    CREATE TYPE event_type_enum AS ENUM (
      'friday_monthly', 'sunday_monthly', 'adhoc', 'other_recurring'
    )
  $q$;
  EXECUTE 'ALTER TABLE events ALTER COLUMN event_type TYPE event_type_enum USING event_type::text::event_type_enum';
  EXECUTE 'DROP TYPE event_type_enum_old';

  RAISE NOTICE 'rename_friday: friday_biweekly → friday_monthly migration complete';
END $$;

COMMIT;
