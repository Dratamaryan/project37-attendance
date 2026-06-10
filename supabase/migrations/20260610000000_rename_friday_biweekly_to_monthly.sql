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

-- Step 2: Update affected events (event_type + recurrence_rule)
UPDATE events
SET
  event_type      = 'friday_monthly',
  recurrence_rule = 'FREQ=MONTHLY;BYDAY=2FR',
  updated_at      = now()
WHERE event_type = 'friday_biweekly';

-- Step 3: Delete future scheduled instances so they re-materialise on the
-- correct schedule. Past instances (completed/cancelled) are left intact
-- to preserve any historical attendance records.
DELETE FROM event_instances
WHERE event_id IN (
  SELECT id FROM events WHERE event_type = 'friday_monthly'
)
AND status = 'scheduled'
AND scheduled_at > now();

-- Step 4: Recreate enum without the old value
ALTER TYPE event_type_enum RENAME TO event_type_enum_old;
CREATE TYPE event_type_enum AS ENUM (
  'friday_monthly',
  'sunday_monthly',
  'adhoc',
  'other_recurring'
);
ALTER TABLE events
  ALTER COLUMN event_type TYPE event_type_enum
  USING event_type::text::event_type_enum;
DROP TYPE event_type_enum_old;

COMMIT;
