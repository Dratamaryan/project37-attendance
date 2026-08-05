-- Migration: sprint6_task0b_log_audit_actor_precedence
-- PROPOSED — not yet applied to prod. Second, independent fix from the
-- pre-public RLS audit's log_audit() finding (20260805120000 closed the
-- anon-EXECUTE hole at the ACL layer; this closes a behavioral hole in the
-- function body itself).
--
-- Problem: the original body resolves the audit actor as
--   COALESCE(p_actor_user_id, auth.uid())
-- which lets the CALLER'S PARAMETER win over the database's own notion of
-- who is actually connected. Since this app has no public self-signup, every
-- `authenticated` caller is an invited admin/organizer — but any one of them
-- could call this RPC directly (bypassing the app's logAudit() wrapper,
-- which always passes its own auth.uid()) with a DIFFERENT user's UUID and
-- have the row attributed to that other person. Revoking anon's EXECUTE
-- (20260805120000) closed the "any stranger on the internet" case; it does
-- not close this "one authenticated account impersonating another" case.
--
-- Fix: flip the COALESCE order to auth.uid() FIRST —
--   COALESCE(auth.uid(), p_actor_user_id)
-- — so whenever the database can identify the caller from their own verified
-- JWT, that identity always wins over anything the caller claims via the
-- parameter. p_actor_user_id is honored ONLY when auth.uid() is NULL, i.e.
-- there is no authenticated user context at all — which is exactly the
-- service_role / system-caller backfill path this parameter exists for
-- (service_role connections carry no 'sub' claim, so auth.uid() is NULL
-- under service_role — proven against local Docker, see the accompanying
-- test file). No application call site is affected: every existing caller
-- already passes its own auth.uid()-derived value as p_actor_user_id, which
-- is now simply redundant with (and consistent with) what auth.uid() itself
-- resolves to for that same session.
--
-- ONLY the actor-resolution line changes. Signature, SECURITY DEFINER, and
-- search_path are unchanged from 20260526140000. CREATE OR REPLACE on an
-- existing function (identical argument list — no DROP involved) does NOT
-- reset the function's ACL, so the anon-EXECUTE revoke + authenticated/
-- service_role grants from 20260805120000 remain intact after this runs —
-- verified against local Docker below rather than merely assumed.

CREATE OR REPLACE FUNCTION public.log_audit(
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
    COALESCE(auth.uid(), p_actor_user_id),
    p_action,
    p_entity_type,
    p_entity_id,
    p_details_json,
    p_ip_address,
    p_user_agent
  );
END;
$$;
