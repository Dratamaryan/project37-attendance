-- Migration: sprint1_task4_log_audit_body
-- Replaces the log_audit() scaffold from Task 1 with the real INSERT body.
--
-- Signature change from Task 1 scaffold:
--   Added p_actor_user_id uuid (required, no default) as first param.
--   The old 6-param scaffold must be dropped first — CREATE OR REPLACE does
--   not replace across different argument type lists in Postgres; it would
--   silently create a second overload instead.
--   No callers existed (scaffold always raised EXCEPTION), so this is safe.
--
-- Param ordering rule: all required (no-default) params must precede optional ones.
--   Required : p_actor_user_id, p_action, p_entity_type, p_entity_id
--   Optional : p_details_json, p_ip_address, p_user_agent

-- Drop old scaffold (6 params, no actor_user_id)
DROP FUNCTION IF EXISTS public.log_audit(text, text, text, jsonb, inet, text);

-- Only sanctioned path to write audit_log.
-- RLS blocks direct INSERT for all roles; SECURITY DEFINER bypasses that here.
-- Pass NULL for p_actor_user_id from cron/system callers — COALESCE falls back
-- to auth.uid() from the current JWT (also NULL for cron, producing a NULL-actor
-- audit row, which the nullable FK allows and is intentional for system events).
CREATE FUNCTION public.log_audit(
  p_actor_user_id uuid,
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
  INSERT INTO audit_log (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    details_json,
    ip_address,
    user_agent
  ) VALUES (
    COALESCE(p_actor_user_id, auth.uid()),
    p_action,
    p_entity_type,
    p_entity_id,
    p_details_json,
    p_ip_address,
    p_user_agent
  );
END;
$$;
