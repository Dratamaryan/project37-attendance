-- Migration: sprint1_task1_foundation
-- Creates: gender_enum, marital_status_enum, is_organizer() helper,
--          people, parishes, audit_log, app_settings tables + all indexes,
--          RLS policies for all four tables, log_audit() scaffold,
--          app_settings seed row.
-- Sprint 1 Task 1 — no application code, DB foundation only.

-- ============================================================
-- § 1  Enums
-- ============================================================

CREATE TYPE gender_enum AS ENUM ('male', 'female');
CREATE TYPE marital_status_enum AS ENUM ('married', 'single');

-- ============================================================
-- § 2  is_organizer() SECURITY DEFINER helper
--      Mirror of is_admin() from 20260525121800_create_app_users.sql.
--      SECURITY DEFINER: runs as function owner (bypasses RLS on app_users),
--      consistent with is_admin() pattern. Prevents any RLS interaction
--      concern when querying app_users from inside another table's policy.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_organizer()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users
    WHERE id = auth.uid()
      AND role = 'organizer'
      AND active = true
  );
$$;

-- ============================================================
-- § 3  people — master roster
-- ============================================================

CREATE TABLE people (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164            text        UNIQUE NOT NULL,     -- '+6282185352609'
  full_name             text        NOT NULL,            -- Nama Lengkap
  nickname              text        NOT NULL,            -- Nama Panggilan
  email                 text,
  birth_place           text,                            -- Tempat Lahir
  birth_date            date,                            -- nullable: legacy import edge cases
  gender                gender_enum,                     -- Jenis Kelamin
  origin_parish         text,                            -- Asal Paroki
  marital_status        marital_status_enum,
  kepanitiaan           text,                            -- Member/Servant/Shepherd/etc. — text until Sprint 5 enum promotion
  tribe                 text,                            -- Deborah/Daniel/Eden/etc. — text until Sprint 5 enum promotion
  current_city          text,
  current_area          text,
  photo_url             text,                            -- Storage path (new) or Google Drive URL (imported legacy)
  photo_publish_consent boolean     NOT NULL DEFAULT false,
  photo_consent_at      timestamptz,
  photo_consent_version text        DEFAULT 'v1',
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz                      -- soft delete; never hard-delete except scheduled retention job
  -- Deferred to Sprint 5 admin UI:
  --   wedding_anniversary   date
  --   spouse_name           text
  --   has_children          boolean
  --   children_info         text
  --   couple_photo_url      text
);

CREATE INDEX idx_people_phone ON people (phone_e164);

CREATE INDEX idx_people_birthday ON people
  (EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date))
  WHERE deleted_at IS NULL;

CREATE INDEX idx_people_parish ON people (origin_parish)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_people_tribe ON people (tribe)
  WHERE deleted_at IS NULL;

-- ============================================================
-- § 4  parishes — curated parish list
-- ============================================================

CREATE TABLE parishes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        UNIQUE NOT NULL,
  city       text,
  region     text,                               -- 'Jakarta Barat', 'Bekasi', etc.
  status     text        NOT NULL DEFAULT 'approved',  -- 'approved' | 'pending'
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- § 5  audit_log — append-only paper trail
--      Writes happen exclusively through log_audit() SECURITY DEFINER (Task 4).
--      No INSERT policy is granted to any role — direct writes are RLS-blocked.
-- ============================================================

CREATE TABLE audit_log (
  id            bigserial   PRIMARY KEY,
  actor_user_id uuid        REFERENCES app_users (id),
  action        text        NOT NULL,            -- 'person.create', 'person.update', etc.
  entity_type   text        NOT NULL,
  entity_id     text        NOT NULL,
  details_json  jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_actor  ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_log (action, created_at DESC);

-- log_audit() scaffold — BODY SCAFFOLD: replaced in Sprint 1 Task 4 with actual
-- audit write logic. Do not call until then. Raises EXCEPTION on any premature
-- invocation (loud-fail, not silent no-op) per Sprint 0 feedback pattern.
CREATE OR REPLACE FUNCTION public.log_audit(
  p_action        text,
  p_entity_type   text,
  p_entity_id     text,
  p_details_json  jsonb   DEFAULT NULL,
  p_ip_address    inet    DEFAULT NULL,
  p_user_agent    text    DEFAULT NULL
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'log_audit: not implemented — body added in Sprint 1 Task 4';
END;
$$;

-- ============================================================
-- § 6  app_settings — single-row config
--      CHECK (id = 1) + DEFAULT 1: enforces single-row invariant at the
--      constraint level. Only one settings row is ever structurally possible.
--      Do not remove the CHECK thinking it's redundant with the PRIMARY KEY —
--      it is the single-row enforcement mechanism.
-- ============================================================

CREATE TABLE app_settings (
  id                         smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_country_code       text        DEFAULT 'ID',
  default_language           text        DEFAULT 'id',
  materialization_horizon_mo smallint    DEFAULT 12,
  birthday_notify_time       time        DEFAULT '07:00',
  birthday_notify_timezone   text        DEFAULT 'Asia/Jakarta',
  birthday_notify_email      text,
  telegram_admin_chat_id     text,
  consent_policy_version     text        DEFAULT 'v1',
  retention_archive_years    smallint    DEFAULT 3,
  retention_aggregate_years  smallint    DEFAULT 5,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- § 7  Row Level Security
--      Soft-delete decision (locked): deleted_at IS NULL enforced in the
--      USING clause of organizer_select on people. admin_select_all has no
--      such filter — admin sees all rows including soft-deleted.
-- ============================================================

-- ── people ──────────────────────────────────────────────────

ALTER TABLE people ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_select_all" ON people
  FOR SELECT USING (is_admin());
COMMENT ON POLICY "admin_select_all" ON people IS
  'Admin sees all rows including soft-deleted; needed for data recovery and audit.';

CREATE POLICY "admin_insert" ON people
  FOR INSERT WITH CHECK (is_admin());
COMMENT ON POLICY "admin_insert" ON people IS
  'Admin can create any people record.';

CREATE POLICY "admin_update" ON people
  FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
COMMENT ON POLICY "admin_update" ON people IS
  'Admin can update any record including setting deleted_at for soft-delete.';

CREATE POLICY "admin_delete" ON people
  FOR DELETE USING (is_admin());
COMMENT ON POLICY "admin_delete" ON people IS
  'Admin hard-delete (rare; normal removal is soft-delete via UPDATE).';

CREATE POLICY "organizer_select" ON people
  FOR SELECT USING (deleted_at IS NULL AND is_organizer());
COMMENT ON POLICY "organizer_select" ON people IS
  'Organizers see only active (non-deleted) records; deleted_at IS NULL enforced at DB level.';

CREATE POLICY "organizer_insert" ON people
  FOR INSERT WITH CHECK (is_organizer());
COMMENT ON POLICY "organizer_insert" ON people IS
  'Organizers can create people records (e.g., new check-in registrations).';

CREATE POLICY "organizer_update" ON people
  FOR UPDATE
  USING     (deleted_at IS NULL AND is_organizer())
  WITH CHECK (deleted_at IS NULL AND is_organizer());
COMMENT ON POLICY "organizer_update" ON people IS
  'Organizers can update active records only. Both USING and WITH CHECK enforce deleted_at IS NULL — organizers cannot soft-delete (set deleted_at) via UPDATE. Soft-delete is admin-only.';

-- No DELETE policy for organizer — spec: organizer has UPDATE, no DELETE.

-- ── parishes ─────────────────────────────────────────────────

ALTER TABLE parishes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_select" ON parishes
  FOR SELECT USING (is_admin());
COMMENT ON POLICY "admin_select" ON parishes IS
  'Admin reads all parishes including pending ones awaiting approval.';

CREATE POLICY "admin_insert" ON parishes
  FOR INSERT WITH CHECK (is_admin());
COMMENT ON POLICY "admin_insert" ON parishes IS
  'Admin can seed or directly create approved parishes.';

CREATE POLICY "admin_update" ON parishes
  FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
COMMENT ON POLICY "admin_update" ON parishes IS
  'Admin approves pending parishes by setting status=approved.';

CREATE POLICY "admin_delete" ON parishes
  FOR DELETE USING (is_admin());
COMMENT ON POLICY "admin_delete" ON parishes IS
  'Admin can remove parishes (e.g., duplicates or errors).';

CREATE POLICY "organizer_select" ON parishes
  FOR SELECT USING (is_organizer());
COMMENT ON POLICY "organizer_select" ON parishes IS
  'Organizers read all parishes for check-in dropdown; includes pending entries.';

CREATE POLICY "organizer_insert" ON parishes
  FOR INSERT WITH CHECK (status = 'pending' AND is_organizer());
COMMENT ON POLICY "organizer_insert" ON parishes IS
  'Organizers can only insert parishes with status=pending; admins approve them in Sprint 5 Settings.';

-- ── audit_log ────────────────────────────────────────────────
-- No INSERT / UPDATE / DELETE policy for any role.
-- Append-only enforced by RLS absence — direct writes are blocked.
-- Writes go exclusively through log_audit() SECURITY DEFINER (Task 4).

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_select" ON audit_log
  FOR SELECT USING (is_admin());
COMMENT ON POLICY "admin_select" ON audit_log IS
  'Admin reads full audit trail.';

CREATE POLICY "organizer_select_own" ON audit_log
  FOR SELECT USING (actor_user_id = auth.uid() AND is_organizer());
COMMENT ON POLICY "organizer_select_own" ON audit_log IS
  'Organizers can only see their own audit rows; actor_user_id = auth.uid() enforced at DB level.';

-- ── app_settings ─────────────────────────────────────────────

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_select" ON app_settings
  FOR SELECT USING (is_admin());
COMMENT ON POLICY "admin_select" ON app_settings IS
  'Admin reads app configuration.';

CREATE POLICY "admin_update" ON app_settings
  FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
COMMENT ON POLICY "admin_update" ON app_settings IS
  'Admin can update app configuration (e.g., notification time, language).';

CREATE POLICY "organizer_select" ON app_settings
  FOR SELECT USING (is_organizer());
COMMENT ON POLICY "organizer_select" ON app_settings IS
  'Organizers read app settings (e.g., default_country_code for phone normalization).';

-- ============================================================
-- § 8  Seed — app_settings default row
--      ON CONFLICT DO NOTHING: idempotent across db reset cycles.
-- ============================================================

INSERT INTO app_settings (
  id,
  default_country_code,
  default_language,
  materialization_horizon_mo,
  birthday_notify_time,
  birthday_notify_timezone,
  consent_policy_version
) VALUES (
  1, 'ID', 'id', 12, '07:00', 'Asia/Jakarta', 'v1'
)
ON CONFLICT (id) DO NOTHING;
