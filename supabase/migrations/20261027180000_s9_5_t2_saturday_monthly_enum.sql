-- Migration: s9_5_t2_saturday_monthly_enum
-- Sprint 9.5 T2 — Project Day moves from the 2nd Friday to the 2nd Saturday
-- from November 2026 (Option B: a new series, the Friday series is retired by
-- the owner SQL scripts/s9-5/t2-retire-friday-series.<env>.sql).
--
-- Adds 'saturday_monthly' to event_type_enum (UI preset → FREQ=MONTHLY;BYDAY=2SA,
-- app/admin/events/_components/RRuleBuilder.tsx). Enum DDL only — the new
-- value is NOT used in this migration (a value added by ALTER TYPE ... ADD
-- VALUE cannot be used in the transaction that adds it).

-- Pre-flight: hard-abort before any DDL if the target has drifted. The label
-- set must be exactly the four known values, or those four plus
-- 'saturday_monthly' (already added by hand → the ADD below is a no-op).
DO $$
DECLARE
  v_labels text[];
BEGIN
  IF to_regtype('public.event_type_enum') IS NULL THEN
    RAISE EXCEPTION 'event_type_enum missing — drift, aborting';
  END IF;

  SELECT array_agg(e.enumlabel::text ORDER BY e.enumlabel)
    INTO v_labels
    FROM pg_enum e
   WHERE e.enumtypid = 'public.event_type_enum'::regtype;

  IF v_labels IS DISTINCT FROM ARRAY['adhoc', 'friday_monthly', 'other_recurring', 'sunday_monthly']
     AND v_labels IS DISTINCT FROM ARRAY['adhoc', 'friday_monthly', 'other_recurring', 'saturday_monthly', 'sunday_monthly']
  THEN
    RAISE EXCEPTION 'event_type_enum labels % unexpected — drift, aborting', v_labels;
  END IF;
END $$;

ALTER TYPE public.event_type_enum ADD VALUE IF NOT EXISTS 'saturday_monthly' AFTER 'friday_monthly';
