-- Migration: sprint6_task4_retention_anonymize
-- S6-T4 (plan approved 2026-08-10, decisions A-J locked) — additive only.
-- No ALTER TABLE: every touched column already exists (S1 people, S5 birthday
-- opt-in, S6-T3 photo_consent_state/anonymized_at).
--
-- Retention = ANONYMIZE-IN-PLACE, never DELETE. attendance.person_id and
-- event_invitations.person_id are NO ACTION FKs to people(id) (confirmed live)
-- so the row id must survive; this scrubs PII columns only and never touches
-- attendance/event_invitations.
--
-- Two SECURITY DEFINER functions:
--   anonymize_person()   — core primitive, single person, idempotent.
--   run_retention_pass() — batch orchestrator for the scheduled cron; loops
--                          anonymize_person() per eligible person so EVERY
--                          anonymize gets its own audit_log row.
--
-- [J] Invariant ANONYMIZED ⇒ SOFT-DELETED: anonymize_person() sets
-- deleted_at = COALESCE(deleted_at, now()), so a scrubbed row can never be
-- deleted_at IS NULL and therefore can never surface in the active
-- roster/attendance views that filter on it.
--
-- [E] photo_url is a MIXED column — Supabase Storage path for new in-app
-- uploads (impl_uploadPhoto writes '{personId}/{randomUUID}.{ext}', always a
-- relative, scheme-less string — lib/storage/photos.impl.ts), Google Drive /
-- googleusercontent URL for the Sprint 6 legacy import (per the Schema doc,
-- the entire legacy roster is Drive URLs). The disposition below is computed
-- at CAPTURE time (not deferred to a future reaper) because unconditionally
-- storing the raw URL would write a permanent, direct, identifying link to a
-- person's photo into append-only audit_log for a value a reaper — which
-- only ever acts on Storage-bucket paths — would never consume anyway.
--
-- Branch order mirrors impl_getPhotoSignedUrl (lib/storage/photos.impl.ts),
-- and is deliberately https:// -prefix-first rather than
-- host-allowlist-first: checking the exact legacy hosts (drive.google.com,
-- lh3.googleusercontent.com) FIRST and falling through to 'storage' for
-- anything else would let an unrecognized https:// host slip into the
-- reapable-storage bucket. Instead ANY https:// value is 'external' and
-- never captured, known host or not; only a non-https, schema-less string
-- (the only shape impl_uploadPhoto ever writes) is treated as a reapable
-- Storage path.
--
-- No Storage object deletion happens here (SQL can't reach the Storage API);
-- that is an explicitly deferred follow-up (a storage-reaper) that consumes
-- reapable_photo_path from people.anonymize audit rows where
-- photo_disposition = 'storage'.
--
-- [G] Scheduled-pass audit rows carry actor_user_id = NULL (no dummy
-- app_users row). Confirmed safe: lib/actions/audit-log.impl.ts embeds
-- actor:app_users(...) with no !inner (LEFT join), AuditLogActor has a
-- dedicated 'system' variant for actor_user_id IS NULL, and the UI renders
-- it via t('actor.system') — this path was already built for cron/system
-- rows, proven by audit-log.types.ts's own comment on that variant.

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

-- [I] service_role only. PUBLIC schema functions get EXECUTE granted to
-- anon/authenticated/service_role by default (Supabase's default ACL on
-- CREATE FUNCTION — confirmed live via pg_default_acl) so authenticated
-- must be revoked explicitly, not just anon/PUBLIC.
REVOKE EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.run_retention_pass(
  p_actor_user_id uuid DEFAULT NULL
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_years  smallint;
  v_count  integer := 0;
  v_person record;
BEGIN
  SELECT retention_archive_years INTO v_years FROM app_settings WHERE id = 1;

  -- [F] Fail-safe: an unconfigured or invalid horizon means "do nothing",
  -- never "anonymize on soft-delete" (a NULL or non-positive interval would
  -- otherwise make every soft-deleted row instantly eligible).
  IF v_years IS NULL OR v_years <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_person IN
    SELECT id FROM people
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - (v_years || ' years')::interval
      AND anonymized_at IS NULL
  LOOP
    IF anonymize_person(v_person.id, p_actor_user_id, 'scheduled_retention_pass') THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.run_retention_pass(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_retention_pass(uuid) TO service_role;
