-- Migration: sprint5_task7_default_language_rpc
-- Sprint 5 Task 7 — public.get_default_language() SECURITY DEFINER RPC.
--
-- i18n/request.ts resolves a locale for every page render, including
-- anonymous ones (check-in, login) where no admin/organizer session exists.
-- app_settings RLS has no anon policy (admin_select/organizer_select only —
-- see docs/4. Database Schema.md), so an anonymous visitor cannot read
-- app_settings.default_language directly, and CLAUDE.md rule 12 forbids
-- putting the service-role client (lib/supabase/admin.ts) in a page-render
-- hot path to work around that.
--
-- This function exposes exactly ONE column (default_language) through a
-- controlled surface, mirroring the existing is_admin()/is_organizer()
-- SECURITY DEFINER pattern rather than widening RLS to expose the whole row
-- (which would leak telegram_admin_chat_id etc. to anon).
--
-- search_path is pinned, matching is_admin()/is_organizer() — a SECURITY
-- DEFINER function without a pinned search_path is a privilege-escalation
-- hole (an attacker-controlled search_path could shadow app_settings with a
-- same-named object in another schema the caller controls).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_default_language') THEN
    RAISE EXCEPTION 'get_default_language() already exists — prod drift, aborting';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_default_language()
  RETURNS text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT default_language FROM app_settings WHERE id = 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_default_language() TO anon, authenticated;
