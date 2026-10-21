-- Migration: sprint9_r0_rsvp
-- Sprint 9 R0 — public RSVP foundation: event_rsvp_links + event_rsvps,
-- admin-only RLS, rsvp_instance_open() window helper, and the two anon RPCs
-- (get_rsvp_context, submit_rsvp) that are the ONLY public path to these
-- tables. CREATE only — no ALTER/DROP of existing objects.
--
-- Public-access shape: anon has no table privilege and no policy on either
-- table. The public RSVP page reaches them exclusively through the two
-- SECURITY DEFINER RPCs below, which are granted to anon only (not
-- authenticated — the R1/R4 server action calls them through a cookie-less
-- anon client, same idiom as lib/settings/default-language-cache.ts).
--
-- submit_rsvp never touches people, attendance or audit_log: an RSVP row is
-- not a PII mutation of `people`. A newcomer's name lives only on the RSVP
-- row; a matched member's row stores person_id and a NULL name. The response
-- body is the same constant for member and newcomer so the endpoint cannot be
-- used to probe whether a phone number belongs to a congregation member.
--
-- Gate: submit_rsvp requires p_gate to equal the vault secret 'rsvp_gate'
-- (server-held; never sent to the browser). Missing vault secret fails
-- closed ('unavailable'). Comparison is over sha256 digests so the compare
-- runs over fixed-length values regardless of input length.
--
-- REVOKE ... MAINTAIN requires Postgres 17 (MAINTAIN privilege is new in 17);
-- local config.toml major_version = 17.

-- Pre-flight: hard-abort before any DDL if the target has drifted from the
-- state this migration was written against. Supabase runs each migration in
-- a transaction, so RAISE EXCEPTION here rolls back cleanly.
DO $$
DECLARE
  v_missing text;
BEGIN
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'requires Postgres 17+ (MAINTAIN privilege) — aborting';
  END IF;
  IF to_regclass('public.event_rsvp_links') IS NOT NULL THEN
    RAISE EXCEPTION 'event_rsvp_links already exists — drift, aborting';
  END IF;
  IF to_regclass('public.event_rsvps') IS NOT NULL THEN
    RAISE EXCEPTION 'event_rsvps already exists — drift, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_admin') THEN
    RAISE EXCEPTION 'is_admin() missing — RLS would half-apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    RAISE EXCEPTION 'supabase_vault extension missing — submit_rsvp gate cannot read its secret';
  END IF;
  IF to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
    RAISE EXCEPTION 'extensions.gen_random_bytes(integer) missing — token default would fail';
  END IF;
  IF to_regprocedure('extensions.digest(text,text)') IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(text,text) missing — submit_rsvp gate compare would fail';
  END IF;

  SELECT string_agg(e.tbl || '.' || e.col, ', ')
    INTO v_missing
    FROM (VALUES
      ('people',          'phone_e164'),
      ('people',          'deleted_at'),
      ('people',          'anonymized_at'),
      ('event_instances', 'scheduled_at'),
      ('event_instances', 'status'),
      ('event_instances', 'image_url'),
      ('event_instances', 'event_name_snapshot'),
      ('event_instances', 'event_name_snapshot_id'),
      ('events',          'duration_min'),
      ('events',          'location')
    ) AS e (tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name   = e.tbl
        AND c.column_name  = e.col
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'expected column(s) missing: % — drift, aborting', v_missing;
  END IF;
END $$;

-- ============================================================
-- § 1  Tables
-- ============================================================

CREATE TABLE event_rsvp_links (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 24 random bytes → 32 URL-safe base64 chars (no padding at 24 bytes).
  token             text        NOT NULL UNIQUE
                       DEFAULT translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'),
  event_instance_id uuid        NOT NULL REFERENCES event_instances (id) ON DELETE CASCADE,
  is_active         boolean     NOT NULL DEFAULT true,
  expires_at        timestamptz,          -- manual earlier cutoff only; NULL = instance window governs
  created_by        uuid        NOT NULL REFERENCES app_users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- At most one active link per instance.
CREATE UNIQUE INDEX uniq_event_rsvp_links_active_instance
  ON event_rsvp_links (event_instance_id)
  WHERE is_active;

CREATE TABLE event_rsvps (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_instance_id uuid        NOT NULL REFERENCES event_instances (id) ON DELETE CASCADE,
  -- Default NO ACTION, deliberately not RESTRICT: NO ACTION is checked at end
  -- of statement, so deleting an event_instance cascades to both its links
  -- and its RSVPs in one statement without tripping this FK.
  link_id           uuid        NOT NULL REFERENCES event_rsvp_links (id),
  phone_e164        text        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  name              text        CHECK (char_length(name) <= 100),
  children_count    integer     NOT NULL DEFAULT 0 CHECK (children_count BETWEEN 0 AND 20),
  followup_consent  boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL CHECK (status IN ('coming', 'not_coming', 'maybe')),
  person_id         uuid        REFERENCES people (id),   -- NO ACTION: people only soft-delete
  anonymized_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_event_rsvps_instance_phone UNIQUE (event_instance_id, phone_e164)
);

CREATE INDEX idx_event_rsvps_person ON event_rsvps (person_id);

-- ============================================================
-- § 2  Grants + RLS
-- ============================================================

REVOKE ALL ON event_rsvp_links FROM anon, PUBLIC;
REVOKE ALL ON event_rsvps      FROM anon, PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON event_rsvp_links FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON event_rsvps      FROM authenticated;

ALTER TABLE event_rsvp_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_rsvps      ENABLE ROW LEVEL SECURITY;

-- Admin: full CRUD. No organizer policy, no anon policy — RLS default-denies.
CREATE POLICY event_rsvp_links_admin_all
  ON event_rsvp_links FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY event_rsvps_admin_all
  ON event_rsvps FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- ============================================================
-- § 3  rsvp_instance_open() — RSVP window helper
-- ============================================================
-- True iff the instance is still 'scheduled' and today (WIB) is on or before
-- the WIB calendar date the instance ends. SQL twin of
-- lib/events/timezone.ts instanceEndWibDate() (parity-tested). Not SECURITY
-- DEFINER and not executable by any API role — only the two SECURITY DEFINER
-- RPCs below (running as owner) call it.

CREATE FUNCTION public.rsvp_instance_open(p_instance_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT ei.status = 'scheduled'
       AND (now() AT TIME ZONE 'Asia/Jakarta')::date
           <= ((ei.scheduled_at + make_interval(mins => e.duration_min)) AT TIME ZONE 'Asia/Jakarta')::date
      FROM event_instances ei
      JOIN events e ON e.id = ei.event_id
     WHERE ei.id = p_instance_id
  ), false);
$$;

REVOKE EXECUTE ON FUNCTION public.rsvp_instance_open(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ============================================================
-- § 4  get_rsvp_context(p_token) — public page context
-- ============================================================
-- Any closed/unknown state returns exactly {"open": false} — no hint whether
-- the token exists, is inactive, expired, or the instance has ended.

CREATE FUNCTION public.get_rsvp_context(p_token text)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR length(p_token) > 64 THEN
    RETURN '{"open":false}'::jsonb;
  END IF;

  SELECT jsonb_build_object(
           'open',          true,
           'event_name',    ei.event_name_snapshot,
           'event_name_id', ei.event_name_snapshot_id,
           'scheduled_at',  ei.scheduled_at,
           'duration_min',  e.duration_min,
           'location',      e.location,
           'image_url',     ei.image_url
         )
    INTO v_result
    FROM event_rsvp_links l
    JOIN event_instances ei ON ei.id = l.event_instance_id
    JOIN events e           ON e.id = ei.event_id
   WHERE l.token = p_token
     AND l.is_active
     AND (l.expires_at IS NULL OR l.expires_at > now())
     AND rsvp_instance_open(l.event_instance_id);

  RETURN COALESCE(v_result, '{"open":false}'::jsonb);
END;
$$;

-- ============================================================
-- § 5  submit_rsvp(...) — public RSVP upsert
-- ============================================================

CREATE FUNCTION public.submit_rsvp(
  p_gate             text,
  p_token            text,
  p_phone_e164       text,
  p_name             text,
  p_children_count   integer,
  p_followup_consent boolean,
  p_status           text
)
  RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_secret      text;
  v_link_id     uuid;
  v_instance_id uuid;
  v_name        text;
  v_followup    boolean;
  v_person_id   uuid;
  v_distinct    integer;
BEGIN
  -- 1. Gate
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'rsvp_gate';

  IF v_secret IS NULL
     OR p_gate IS NULL
     OR extensions.digest(p_gate, 'sha256') <> extensions.digest(v_secret, 'sha256') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'unavailable');
  END IF;

  -- 2. Token / link / window — same conditions as get_rsvp_context
  IF p_token IS NULL OR length(p_token) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed');
  END IF;

  SELECT l.id, l.event_instance_id
    INTO v_link_id, v_instance_id
    FROM event_rsvp_links l
   WHERE l.token = p_token
     AND l.is_active
     AND (l.expires_at IS NULL OR l.expires_at > now())
     AND rsvp_instance_open(l.event_instance_id);

  IF v_link_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'closed');
  END IF;

  -- 3. Validate
  v_name     := NULLIF(btrim(p_name), '');
  v_followup := COALESCE(p_followup_consent, false);

  IF p_phone_e164 IS NULL
     OR p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$'
     OR (v_name IS NOT NULL AND char_length(v_name) > 100)
     OR p_children_count IS NULL
     OR p_children_count NOT BETWEEN 0 AND 20
     OR p_status IS NULL
     OR p_status NOT IN ('coming', 'not_coming', 'maybe') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid');
  END IF;

  -- 4. Per-instance cap (300 distinct phones), serialized per instance so two
  -- concurrent newcomers can't both pass at 299. Two-key lock: 9001 is the
  -- RSVP advisory-lock namespace, keeping these keys apart from any other
  -- hashtext()-based advisory lock in this database.
  PERFORM pg_advisory_xact_lock(9001, hashtext(v_instance_id::text));

  IF NOT EXISTS (
    SELECT 1 FROM event_rsvps
     WHERE event_instance_id = v_instance_id
       AND phone_e164 = p_phone_e164
  ) THEN
    SELECT count(DISTINCT phone_e164) INTO v_distinct
      FROM event_rsvps
     WHERE event_instance_id = v_instance_id;
    IF v_distinct >= 300 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'limit');
    END IF;
  END IF;

  -- 5. Member match — live, non-anonymized people only
  SELECT id INTO v_person_id
    FROM people
   WHERE phone_e164 = p_phone_e164
     AND deleted_at IS NULL
     AND anonymized_at IS NULL;

  -- 6. Upsert. Matched member: person_id set, name NULL (the people row is
  -- the source of truth). Newcomer: keep the previously given name when a
  -- resubmit omits it.
  INSERT INTO event_rsvps AS r (
    event_instance_id, link_id, phone_e164, name,
    children_count, followup_consent, status, person_id
  )
  VALUES (
    v_instance_id, v_link_id, p_phone_e164,
    CASE WHEN v_person_id IS NULL THEN v_name END,
    p_children_count, v_followup, p_status, v_person_id
  )
  ON CONFLICT (event_instance_id, phone_e164) DO UPDATE
    SET person_id        = EXCLUDED.person_id,
        name             = CASE WHEN EXCLUDED.person_id IS NOT NULL THEN NULL
                                ELSE COALESCE(EXCLUDED.name, r.name) END,
        status           = EXCLUDED.status,
        children_count   = EXCLUDED.children_count,
        followup_consent = EXCLUDED.followup_consent,
        link_id          = EXCLUDED.link_id,
        updated_at       = now();

  -- 7. Constant response — identical for member and newcomer.
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Function grants: anon ONLY. Revoke the implicit PUBLIC grant AND the
-- per-role grants this schema's default privileges hand to anon/
-- authenticated/service_role on every new function, then re-grant anon.
REVOKE EXECUTE ON FUNCTION public.get_rsvp_context(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.submit_rsvp(text, text, text, text, integer, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_rsvp_context(text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_rsvp(text, text, text, text, integer, boolean, text) TO anon;
