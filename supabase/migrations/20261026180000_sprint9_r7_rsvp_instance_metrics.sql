-- Migration: sprint9_r7_rsvp_instance_metrics
-- Sprint 9 R7 (definitions F1–F14 / G1–G4, 2026-10-26) — rsvp_instance_metrics:
-- one row of RSVP-vs-actual counts per instance, for /admin/analytics.
-- CREATE only — never writes.
--
-- Instance set: status <> 'cancelled', at least one event_rsvp_links row
-- (active OR deactivated — same rule as the cross-tab's walk_in arm), and
-- already ended (scheduled_at + duration_min <= now()).
--
-- RSVP counts come from rsvp_checkin_crosstab, so resolution (person_id →
-- retained_person_id → live phone match) is exactly the R3/R5 one:
--   coming_people / coming_headcount (Σ 1 + children_count) / maybe_people
--     — RSVP rows by rsvp_status
--   coming_came / coming_no_show / walk_ins — bucket counts
--   newcomer_rsvps — RSVP rows with matched_at_submit = false
--   became_members — those that resolve to a roster person ("as of last
--     submit": a resubmit after registering sets person_id and moves the row
--     out of newcomer_rsvps)
-- Head counts come from the base tables, every row at the instance:
--   actual_adults   — count(*) attendance
--   actual_children — count(*) child_attendance
-- Funnel (G): invited = event_invitations status = 'sent';
--   invited_responded — invited persons any cross-tab RSVP row resolves to;
--   invited_attended  — invited persons with an attendance row.
-- Soft-deleted / anonymized people are kept everywhere (historical counts
-- must not shrink retroactively — same rule as event_attendance_trend).
--
-- Access: security_invoker = on, so the caller's RLS applies to every base
-- table and the cross-tab's own is_admin() filter applies. The view repeats
-- WHERE public.is_admin(): organizers can read event_instances, attendance
-- and child_attendance, so without it they would get rows with zeroed RSVP
-- columns instead of no rows. anon: REVOKE ALL (not just SELECT — see R3).

-- Pre-flight: hard-abort before any DDL if the target has drifted.
DO $$
BEGIN
  IF to_regclass('public.rsvp_instance_metrics') IS NOT NULL THEN
    RAISE EXCEPTION 'rsvp_instance_metrics already exists — drift, aborting';
  END IF;
  IF to_regclass('public.rsvp_checkin_crosstab') IS NULL THEN
    RAISE EXCEPTION 'rsvp_checkin_crosstab missing — R3 not applied, aborting';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'event_rsvps'
       AND column_name = 'retained_person_id'
  ) THEN
    RAISE EXCEPTION 'event_rsvps.retained_person_id missing — R5 not applied, aborting';
  END IF;
  IF to_regclass('public.child_attendance') IS NULL THEN
    RAISE EXCEPTION 'child_attendance missing — S8-T1 not applied, aborting';
  END IF;
  IF to_regclass('public.event_invitations') IS NULL THEN
    RAISE EXCEPTION 'event_invitations missing — S4-T3 not applied, aborting';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'is_admin() missing — view filter would fail';
  END IF;
END $$;

CREATE VIEW public.rsvp_instance_metrics WITH (security_invoker = on) AS
WITH inst AS (
  SELECT ei.id AS event_instance_id, ei.event_id, e.event_type, ei.scheduled_at,
         ei.scheduled_at + make_interval(mins => e.duration_min) AS ended_at
    FROM event_instances ei
    JOIN events e ON e.id = ei.event_id
   WHERE ei.status <> 'cancelled'
     AND ei.scheduled_at + make_interval(mins => e.duration_min) <= now()
     AND EXISTS (SELECT 1 FROM event_rsvp_links l
                  WHERE l.event_instance_id = ei.id)
),
x AS (
  SELECT x.event_instance_id,
         count(*) FILTER (WHERE x.rsvp_status = 'coming')                    AS coming_people,
         COALESCE(sum(1 + x.children_count)
                    FILTER (WHERE x.rsvp_status = 'coming'), 0)              AS coming_headcount,
         count(*) FILTER (WHERE x.rsvp_status = 'maybe')                     AS maybe_people,
         count(*) FILTER (WHERE x.bucket = 'coming_came')                    AS coming_came,
         count(*) FILTER (WHERE x.bucket = 'coming_no_show')                 AS coming_no_show,
         count(*) FILTER (WHERE x.bucket = 'walk_in')                        AS walk_ins,
         count(*) FILTER (WHERE x.rsvp_id IS NOT NULL
                            AND NOT x.matched_at_submit)                     AS newcomer_rsvps,
         count(*) FILTER (WHERE x.rsvp_id IS NOT NULL
                            AND NOT x.matched_at_submit
                            AND x.resolved_person_id IS NOT NULL)            AS became_members
    FROM rsvp_checkin_crosstab x
   WHERE x.event_instance_id IN (SELECT event_instance_id FROM inst)
   GROUP BY x.event_instance_id
),
adults AS (
  SELECT a.event_instance_id, count(*) AS actual_adults
    FROM attendance a
   WHERE a.event_instance_id IN (SELECT event_instance_id FROM inst)
   GROUP BY a.event_instance_id
),
kids AS (
  SELECT ca.event_instance_id, count(*) AS actual_children
    FROM child_attendance ca
   WHERE ca.event_instance_id IN (SELECT event_instance_id FROM inst)
   GROUP BY ca.event_instance_id
),
-- Persons any RSVP row at the instance resolves to. DISTINCT so the funnel's
-- LEFT JOIN cannot fan out; joined once rather than probed per invitation.
responded AS (
  SELECT DISTINCT x.event_instance_id, x.resolved_person_id
    FROM rsvp_checkin_crosstab x
   WHERE x.rsvp_id IS NOT NULL
     AND x.resolved_person_id IS NOT NULL
     AND x.event_instance_id IN (SELECT event_instance_id FROM inst)
),
-- attendance is UNIQUE (event_instance_id, person_id), so its LEFT JOIN
-- cannot fan out either.
funnel AS (
  SELECT inv.event_instance_id,
         count(*)                                              AS invited,
         count(*) FILTER (WHERE r.resolved_person_id IS NOT NULL) AS invited_responded,
         count(*) FILTER (WHERE a.id IS NOT NULL)                 AS invited_attended
    FROM event_invitations inv
    LEFT JOIN responded r
      ON r.event_instance_id  = inv.event_instance_id
     AND r.resolved_person_id = inv.person_id
    LEFT JOIN attendance a
      ON a.event_instance_id = inv.event_instance_id
     AND a.person_id         = inv.person_id
   WHERE inv.status = 'sent'
     AND inv.event_instance_id IN (SELECT event_instance_id FROM inst)
   GROUP BY inv.event_instance_id
)
SELECT i.event_instance_id, i.event_id, i.event_type, i.scheduled_at, i.ended_at,
       COALESCE(x.coming_people, 0)::integer     AS coming_people,
       COALESCE(x.coming_headcount, 0)::integer  AS coming_headcount,
       COALESCE(x.maybe_people, 0)::integer      AS maybe_people,
       COALESCE(x.coming_came, 0)::integer       AS coming_came,
       COALESCE(x.coming_no_show, 0)::integer    AS coming_no_show,
       COALESCE(x.walk_ins, 0)::integer          AS walk_ins,
       COALESCE(ad.actual_adults, 0)::integer    AS actual_adults,
       COALESCE(k.actual_children, 0)::integer   AS actual_children,
       COALESCE(x.newcomer_rsvps, 0)::integer    AS newcomer_rsvps,
       COALESCE(x.became_members, 0)::integer    AS became_members,
       COALESCE(f.invited, 0)::integer           AS invited,
       COALESCE(f.invited_responded, 0)::integer AS invited_responded,
       COALESCE(f.invited_attended, 0)::integer  AS invited_attended
  FROM inst i
  LEFT JOIN x      ON x.event_instance_id  = i.event_instance_id
  LEFT JOIN adults ad ON ad.event_instance_id = i.event_instance_id
  LEFT JOIN kids   k  ON k.event_instance_id  = i.event_instance_id
  LEFT JOIN funnel f  ON f.event_instance_id  = i.event_instance_id
 WHERE public.is_admin();

REVOKE ALL ON public.rsvp_instance_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.rsvp_instance_metrics TO authenticated;

COMMENT ON VIEW public.rsvp_instance_metrics IS
'S9-R7: per-instance RSVP vs actual counts for /admin/analytics. One row per '
'non-cancelled, already-ended instance with any event_rsvp_links row (active or '
'deactivated). RSVP counts from rsvp_checkin_crosstab; actual_adults / '
'actual_children = every attendance / child_attendance row at the instance; '
'soft-deleted people kept. became_members is as of each RSVP''s last submit. '
'Admin-only: zero rows unless is_admin().';
