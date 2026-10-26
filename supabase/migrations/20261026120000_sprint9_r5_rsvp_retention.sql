-- Migration: sprint9_r5_rsvp_retention
-- Sprint 9 R5 (decisions E1–E12, 2026-10-26) — RSVP retention:
--   A1 app_settings.rsvp_retention_days  smallint NOT NULL DEFAULT 90, CHECK > 0
--   A2 event_rsvps.retained_person_id    uuid NULL → people(id), NO ACTION
--   A3 run_rsvp_retention_pass()          new, service_role only
--   A4 anonymize_person()                 CREATE OR REPLACE, signature unchanged
--   A5 rsvp_checkin_crosstab              CREATE OR REPLACE, same columns
--   A6 app_settings.consent_policy_version = 'v2'
--
-- Scrub = anonymize-in-place, same as people (S6-T4): phone_e164 → NULL,
-- name → NULL, anonymized_at set; person_id, status, children_count and
-- followup_consent are kept so headcount history survives. updated_at is NOT
-- touched: it keeps meaning "last answer change" (shown as "Updated" in the
-- panel and export); anonymized_at alone records the scrub. NULL (not the
-- people-style 'anon:{uuid}') because event_rsvps.phone_e164 is nullable and
-- its CHECK would reject the 'anon:' form; UNIQUE (instance, phone) treats
-- NULLs as distinct, so any number of scrubbed rows can share an instance.
--
-- retained_person_id exists so a scrub never changes the cross-tab. A newcomer
-- RSVP (person_id NULL) is linked to a roster person only at read time, through
-- its phone (R3). Nulling the phone would drop that link and move the row from
-- *_came to *_no_show plus a spurious walk_in. Both scrub paths therefore copy
-- the person the cross-tab resolves to RIGHT NOW into retained_person_id in the
-- same UPDATE that nulls the phone — the link is frozen, never re-derived, and
-- nothing that the view did not already resolve is ever added.
--
-- run_rsvp_retention_pass is a separate function, not folded into
-- run_retention_pass: the people pass's [F] guard returns early when
-- retention_archive_years is NULL/<= 0, which must not also switch off RSVP
-- retention. The cron route calls both.

-- Pre-flight: hard-abort before any DDL if the target has drifted.
DO $$
BEGIN
  IF to_regclass('public.event_rsvps') IS NULL THEN
    RAISE EXCEPTION 'event_rsvps missing — R0 not applied, aborting';
  END IF;
  IF to_regclass('public.rsvp_checkin_crosstab') IS NULL THEN
    RAISE EXCEPTION 'rsvp_checkin_crosstab missing — R3 not applied, aborting';
  END IF;
  IF to_regprocedure('public.anonymize_person(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'anonymize_person(uuid,uuid,text) missing — S6-T4 migration must run first';
  END IF;
  IF to_regprocedure('public.log_audit(uuid,text,text,text,jsonb,inet,text)') IS NULL THEN
    RAISE EXCEPTION 'log_audit(...) missing — drift, aborting';
  END IF;
  IF to_regprocedure('public.run_rsvp_retention_pass(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'run_rsvp_retention_pass(uuid) already exists — drift, aborting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'app_settings' AND column_name = 'rsvp_retention_days')
         OR (table_name = 'event_rsvps'  AND column_name = 'retained_person_id'))
  ) THEN
    RAISE EXCEPTION 'rsvp_retention_days / retained_person_id already exist — drift, aborting';
  END IF;
END $$;

-- ============================================================
-- § A1–A2  Columns
-- ============================================================

-- NOT NULL + constant DEFAULT is metadata-only on PG15+; app_settings is one row.
ALTER TABLE app_settings
  ADD COLUMN rsvp_retention_days smallint NOT NULL DEFAULT 90
    CONSTRAINT app_settings_rsvp_retention_days_positive CHECK (rsvp_retention_days > 0);

-- NO ACTION, like person_id: people only soft-delete.
ALTER TABLE event_rsvps
  ADD COLUMN retained_person_id uuid REFERENCES people (id);

-- ============================================================
-- § A3  run_rsvp_retention_pass() — scheduled RSVP scrub
-- ============================================================
-- Eligible: anonymized_at IS NULL and the instance's end WIB date + N days is
-- before today's WIB date. End = the same expression as rsvp_instance_open(),
-- so "N days after the RSVP window closed". Every instance status, cancelled
-- included. One UPDATE per instance (SET reads the pre-update row, so the
-- phone match runs before the phone is nulled) and one audit row per instance
-- that changed — never per RSVP, never with a phone or name. Idempotent and
-- double-fire safe: a concurrent second pass re-checks anonymized_at IS NULL
-- after the row lock and updates 0 rows, so it writes no audit row.

CREATE FUNCTION public.run_rsvp_retention_pass(
  p_actor_user_id uuid DEFAULT NULL
)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_days        integer;
  v_instance_id uuid;
  v_rows        integer;
  v_total       integer := 0;
BEGIN
  SELECT rsvp_retention_days INTO v_days FROM app_settings WHERE id = 1;

  -- Fail-safe, own guard (unreachable while NOT NULL + CHECK hold): never
  -- "scrub everything that has ended".
  IF v_days IS NULL OR v_days <= 0 THEN
    RETURN 0;
  END IF;

  FOR v_instance_id IN
    SELECT ei.id
      FROM event_instances ei
      JOIN events e ON e.id = ei.event_id
     WHERE ((ei.scheduled_at + make_interval(mins => e.duration_min)) AT TIME ZONE 'Asia/Jakarta')::date + v_days
           < (now() AT TIME ZONE 'Asia/Jakarta')::date
       AND EXISTS (SELECT 1 FROM event_rsvps er
                    WHERE er.event_instance_id = ei.id
                      AND er.anonymized_at IS NULL)
     ORDER BY ei.id
  LOOP
    UPDATE event_rsvps er SET
      -- Exactly the person rsvp_checkin_crosstab resolves this row to today.
      retained_person_id = CASE WHEN er.person_id IS NULL THEN
                             (SELECT pm.id FROM people pm
                               WHERE pm.phone_e164 = er.phone_e164
                                 AND pm.deleted_at IS NULL
                                 AND pm.anonymized_at IS NULL)
                           ELSE er.retained_person_id END,
      phone_e164    = NULL,
      name          = NULL,
      anonymized_at = now()
     WHERE er.event_instance_id = v_instance_id
       AND er.anonymized_at IS NULL;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows > 0 THEN
      PERFORM log_audit(
        p_actor_user_id,
        'rsvp.anonymize',
        'event_instances',
        v_instance_id::text,
        jsonb_build_object(
          'instance_id', v_instance_id,
          'rows',        v_rows,
          'trigger',     'scheduled_retention_pass'
        ),
        NULL,
        NULL
      );
      v_total := v_total + v_rows;
    END IF;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.run_rsvp_retention_pass(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_rsvp_retention_pass(uuid) TO service_role;

-- ============================================================
-- § A4  anonymize_person() — also scrubs the person's RSVPs
-- ============================================================
-- CREATE OR REPLACE, signature unchanged (uuid, uuid, text) -> boolean, so no
-- DROP. SECURITY DEFINER + search_path restated (CREATE OR REPLACE resets
-- them if omitted). Changes vs 20261007120000: v_old_phone / v_was_live
-- captured before the people UPDATE, the event_rsvps UPDATE after it, and
-- rsvp_rows in the audit details.
--
-- RSVP rows scrubbed: the person's own (person_id) plus newcomer rows on the
-- phone they had before the scrub. A newcomer row is frozen to this person
-- only if they were live — the cross-tab's phone match skips soft-deleted
-- people, so a soft-deleted person's newcomer rows were never resolved to
-- them and are scrubbed without a link. Rows already anonymized are skipped.

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
  v_old_phone            text;
  v_was_live             boolean;
  v_rsvp_rows            integer;
BEGIN
  -- Captured BEFORE the UPDATE: RETURNING would only hand back the
  -- post-image (NULL / 'anon:…', since this statement is the one scrubbing it).
  SELECT photo_url, phone_e164, (deleted_at IS NULL AND anonymized_at IS NULL)
    INTO v_photo_url, v_old_phone, v_was_live
    FROM people WHERE id = p_person_id;

  IF v_photo_url IS NULL THEN
    v_photo_disposition   := 'none';
    v_reapable_photo_path := NULL;
  ELSIF v_photo_url LIKE 'https://%' THEN
    -- external, known legacy host or not — never persisted. See the [E]
    -- comment in 20260810130000 for why this is checked before any
    -- storage-path branch.
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
    wedding_anniversary       = NULL,
    spouse_name               = NULL,
    anniversary_consent_state = 'unknown',
    anniversary_consent_at    = NULL,
    anonymized_at             = now(),
    updated_at                = now(),
    deleted_at                = COALESCE(deleted_at, now())
  WHERE id = p_person_id
    AND anonymized_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE event_rsvps SET                                    -- S9-R5
    retained_person_id = CASE WHEN person_id IS NULL AND v_was_live THEN p_person_id
                              ELSE retained_person_id END,
    phone_e164         = NULL,
    name               = NULL,
    anonymized_at      = now()
  WHERE anonymized_at IS NULL
    AND (person_id = p_person_id
         OR (person_id IS NULL AND phone_e164 = v_old_phone));

  GET DIAGNOSTICS v_rsvp_rows = ROW_COUNT;                  -- S9-R5

  PERFORM log_audit(
    p_actor_user_id,
    'people.anonymize',
    'people',
    v_id::text,
    jsonb_build_object(
      'trigger',             p_trigger_source,
      'photo_disposition',   v_photo_disposition,
      'reapable_photo_path', v_reapable_photo_path,
      'rsvp_rows',           v_rsvp_rows                    -- S9-R5
    ),
    NULL,
    NULL
  );

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_person(uuid, uuid, text) TO service_role;

-- ============================================================
-- § A5  rsvp_checkin_crosstab — read the frozen link first
-- ============================================================
-- Same columns, same order, same security_invoker + is_admin() filter as
-- 20261024120000. Only r changes: resolved_person_id prefers person_id, then
-- retained_person_id, then the live phone match — and the phone match is
-- skipped once a link is frozen.

CREATE OR REPLACE VIEW public.rsvp_checkin_crosstab WITH (security_invoker = on) AS
WITH r AS (
  SELECT er.id, er.event_instance_id, er.person_id, er.status,
         er.children_count,
         COALESCE(er.person_id, er.retained_person_id, pm.id) AS resolved_person_id
    FROM event_rsvps er
    LEFT JOIN people pm
      ON er.person_id IS NULL
     AND er.retained_person_id IS NULL
     AND er.phone_e164 IS NOT NULL
     AND pm.phone_e164 = er.phone_e164
     AND pm.deleted_at IS NULL
     AND pm.anonymized_at IS NULL
),
units AS (
  SELECT r.event_instance_id, r.id AS rsvp_id, a.id AS attendance_id,
         r.resolved_person_id,
         (r.person_id IS NOT NULL) AS matched_at_submit,
         r.status AS rsvp_status, r.children_count,
         (a.id IS NOT NULL) AS attended
    FROM r
    LEFT JOIN attendance a
      ON a.event_instance_id = r.event_instance_id
     AND a.person_id = r.resolved_person_id
  UNION ALL
  SELECT a.event_instance_id, NULL::uuid, a.id, a.person_id, false,
         NULL::text, NULL::integer, true
    FROM attendance a
   WHERE EXISTS (SELECT 1 FROM event_rsvp_links l
                  WHERE l.event_instance_id = a.event_instance_id)
     AND NOT EXISTS (SELECT 1 FROM r
                      WHERE r.event_instance_id = a.event_instance_id
                        AND r.resolved_person_id = a.person_id)
)
SELECT u.*,
       CASE WHEN u.rsvp_id IS NULL THEN 'walk_in'
            ELSE u.rsvp_status || CASE WHEN u.attended THEN '_came'
                                       ELSE '_no_show' END
       END AS bucket
  FROM units u
 WHERE public.is_admin();

REVOKE ALL ON public.rsvp_checkin_crosstab FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rsvp_checkin_crosstab TO authenticated;

-- ============================================================
-- § A6  Consent policy version
-- ============================================================

UPDATE app_settings SET consent_policy_version = 'v2' WHERE id = 1;
