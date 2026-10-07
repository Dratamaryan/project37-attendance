-- Migration: sprint8_task3_anniversary_spouse
-- S8-T3 (re-scoped AC) — additive only. Two data columns + one consent pair:
--   people.wedding_anniversary        date                NULLABLE
--   people.spouse_name                text                NULLABLE (PII)
--   people.anniversary_consent_state  consent_state_enum  NOT NULL DEFAULT 'unknown'
--   people.anniversary_consent_at     timestamptz         NULLABLE
-- has_children / couple_photo_url from the S1 foundation deferred list are
-- deliberately NOT added (re-scoped out).
--
-- Lock safety: NOT NULL + constant DEFAULT is metadata-only on PG15.
-- No index (~230 rows). No RLS change: policies are row-level, new columns are
-- covered by the existing people policies. No CHECK tying consent_at to
-- consent_state — mirrors photo_consent_state (S6-T3), which is intentionally
-- unconstrained.
--
-- Drift guard instead of ADD COLUMN IF NOT EXISTS (S5-T2 pattern): IF NOT
-- EXISTS would silently accept a pre-existing column of the wrong type/default.
--
-- anonymize_person(): CREATE OR REPLACE, signature unchanged (uuid, uuid, text)
-- -> boolean, so no DROP. SECURITY DEFINER + search_path restated verbatim
-- (CREATE OR REPLACE resets them if omitted); REVOKE/GRANT re-issued as-is.
-- Only change vs 20260810130000: the four "-- S8-T3" lines in the UPDATE.

DO $$
BEGIN
  IF to_regclass('public.people') IS NULL THEN
    RAISE EXCEPTION 'people missing — earlier migration must run first';
  END IF;
  IF to_regtype('public.consent_state_enum') IS NULL THEN
    RAISE EXCEPTION 'consent_state_enum missing — S6-T3 migration must run first';
  END IF;
  IF to_regprocedure('public.anonymize_person(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'anonymize_person(uuid,uuid,text) missing — S6-T4 migration must run first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'people'
      AND column_name IN ('wedding_anniversary', 'spouse_name',
                          'anniversary_consent_state', 'anniversary_consent_at')
  ) THEN
    RAISE EXCEPTION 'people anniversary/spouse column(s) already exist — drift, aborting';
  END IF;
END $$;

ALTER TABLE people
  ADD COLUMN wedding_anniversary       date,
  ADD COLUMN spouse_name               text,
  ADD COLUMN anniversary_consent_state consent_state_enum NOT NULL DEFAULT 'unknown',
  ADD COLUMN anniversary_consent_at    timestamptz;

CREATE OR REPLACE FUNCTION public.anonymize_person(
  p_person_id      uuid,
  p_actor_user_id  uuid DEFAULT NULL,
  p_trigger_source text DEFAULT 'admin'
)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_id                   uuid;
  v_photo_url            text;
  v_photo_disposition    text;
  v_reapable_photo_path  text;
BEGIN
  -- Captured BEFORE the UPDATE: RETURNING would only hand back the
  -- post-image (NULL, since this statement is the one nulling it).
  SELECT photo_url INTO v_photo_url FROM people WHERE id = p_person_id;

  IF v_photo_url IS NULL THEN
    v_photo_disposition   := 'none';
    v_reapable_photo_path := NULL;
  ELSIF v_photo_url LIKE 'https://%' THEN
    -- external, known legacy host or not — never persisted. See the [E]
    -- comment above for why this is checked before any storage-path branch.
    v_photo_disposition   := 'external';
    v_reapable_photo_path := NULL;
  ELSE
    v_photo_disposition   := 'storage';
    v_reapable_photo_path := v_photo_url;
  END IF;

  UPDATE people SET
    full_name                 = '[anonymized]',
    nickname                  = '[anonymized]',
    email                     = NULL,
    birth_place               = NULL,
    birth_date                = NULL,
    photo_url                 = NULL,
    notes                     = NULL,
    current_city              = NULL,
    phone_e164                = 'anon:' || gen_random_uuid()::text,
    photo_consent_state       = 'unknown',
    photo_publish_consent     = false,
    photo_consent_at          = NULL,
    birthday_email_opt_in     = false,
    birthday_email_opt_in_at  = NULL,
    wedding_anniversary       = NULL,       -- S8-T3
    spouse_name               = NULL,       -- S8-T3
    anniversary_consent_state = 'unknown',  -- S8-T3
    anniversary_consent_at    = NULL,       -- S8-T3
    anonymized_at             = now(),
    updated_at                = now(),
    deleted_at                = COALESCE(deleted_at, now())
  WHERE id = p_person_id
    AND anonymized_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM log_audit(
    p_actor_user_id,
    'people.anonymize',
    'people',
    v_id::text,
    jsonb_build_object(
      'trigger',             p_trigger_source,
      'photo_disposition',   v_photo_disposition,
      'reapable_photo_path', v_reapable_photo_path
    ),
    NULL,
    NULL
  );

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) TO service_role;
