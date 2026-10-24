-- Migration: sprint9_r3_rsvp_crosstab
-- Sprint 9 R3 — rsvp_checkin_crosstab: read-time RSVP-vs-check-in cross-tab
-- for the admin instance panel (shared with R7). CREATE only — never writes
-- attendance, event_rsvps or people.
--
-- One row per "unit" of an instance that has (or had) an RSVP link:
--   * every RSVP, LEFT JOINed to the attendance row of the person it
--     resolves to — person_id when matched at submit, else a live,
--     non-anonymized roster person whose phone_e164 equals the RSVP phone
--     (a newcomer later registered at the door);
--   * every check-in at a linked instance that no RSVP resolves to
--     (bucket 'walk_in').
-- bucket ∈ coming_came, coming_no_show, maybe_came, maybe_no_show,
--          not_coming_came, not_coming_no_show, walk_in.
--
-- Access: security_invoker = on, so the caller's RLS applies to every base
-- table; the WHERE public.is_admin() filter additionally returns zero rows
-- (not an error) to organizers, who can read attendance but not RSVPs and
-- would otherwise see every attendee as a walk-in. anon gets no privilege at
-- all: REVOKE ALL (not just SELECT — the S3 analytics views revoked SELECT
-- only and anon kept the default write-type grants), then SELECT back to
-- authenticated only.

-- Pre-flight: hard-abort before any DDL if the target has drifted.
DO $$
BEGIN
  IF to_regclass('public.rsvp_checkin_crosstab') IS NOT NULL THEN
    RAISE EXCEPTION 'rsvp_checkin_crosstab already exists — drift, aborting';
  END IF;
  IF to_regclass('public.event_rsvps') IS NULL THEN
    RAISE EXCEPTION 'event_rsvps missing — R0 not applied, aborting';
  END IF;
  IF to_regclass('public.event_rsvp_links') IS NULL THEN
    RAISE EXCEPTION 'event_rsvp_links missing — R0 not applied, aborting';
  END IF;
  IF to_regclass('public.attendance') IS NULL THEN
    RAISE EXCEPTION 'attendance missing — drift, aborting';
  END IF;
  IF to_regprocedure('public.is_admin()') IS NULL THEN
    RAISE EXCEPTION 'is_admin() missing — view filter would fail';
  END IF;
END $$;

CREATE VIEW public.rsvp_checkin_crosstab WITH (security_invoker = on) AS
WITH r AS (
  SELECT er.id, er.event_instance_id, er.person_id, er.status,
         er.children_count,
         COALESCE(er.person_id, pm.id) AS resolved_person_id
    FROM event_rsvps er
    LEFT JOIN people pm
      ON er.person_id IS NULL
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
