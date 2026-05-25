-- Migration: create_app_users
-- Creates user_role_enum, app_users table, is_admin() helper, and RLS policies.

CREATE TYPE user_role_enum AS ENUM ('admin', 'organizer');

CREATE TABLE app_users (
  id            uuid PRIMARY KEY,           -- matches auth.users.id
  email         text UNIQUE NOT NULL,
  full_name     text,
  role          user_role_enum NOT NULL DEFAULT 'organizer',
  active        boolean NOT NULL DEFAULT true,
  invited_by    uuid REFERENCES app_users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- SECURITY DEFINER: runs as function owner (bypasses RLS on app_users),
-- preventing infinite recursion when called from RLS policies on this table.
CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_users
    WHERE id = auth.uid()
      AND role = 'admin'
      AND active = true
  );
$$;

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- Admins: full CRUD
CREATE POLICY "admin_select" ON app_users
  FOR SELECT USING (is_admin());

CREATE POLICY "admin_insert" ON app_users
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "admin_update" ON app_users
  FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());

CREATE POLICY "admin_delete" ON app_users
  FOR DELETE USING (is_admin());

-- Organizers (and admins): read own row
CREATE POLICY "self_select" ON app_users
  FOR SELECT USING (auth.uid() = id);
