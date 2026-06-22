-- Migration: sprint3_analytics_views
-- Creates 5 read-only analytics views.
-- Sprint 3 Task 2 — migration only. No seed data.
--
-- All views: WITH (security_invoker = on) — runs as querying user, respects their RLS.
-- Grants:    GRANT SELECT … TO authenticated; REVOKE SELECT … FROM anon on each view.
--
-- Invariants (locked Sprint 3 decisions):
--   • Cancelled instances (status = 'cancelled') excluded from all aggregates;
--     attendance_summary keeps them and exposes instance_status for consumers to filter.
--   • Soft-delete asymmetry:
--       person_attendance_counts, parish_breakdown → current roster (deleted_at IS NULL)
--       event_attendance_trend, new_vs_returning_monthly → include soft-deleted (historical
--         turnout must not shrink retroactively when a person is later soft-deleted)
--       attendance_summary → everyone; exposes person_deleted_at
--   • Month bucketing in Asia/Jakarta: date_trunc('month', … AT TIME ZONE 'Asia/Jakarta')
--       Never UTC — a check-in at 2026-01-31T22:00Z = 2026-02-01T05:00+07 belongs to Feb.
--   • Parish: COALESCE(origin_parish, '(Unknown)'), raw free-text, no trim/case-merge until Sprint 5.
--
-- Index coverage (no new indexes — tables are tiny):
--   attendance_summary       → idx_attendance_person, idx_attendance_event, events PK
--   person_attendance_counts → same; partial people indexes cover deleted_at IS NULL filter
--   event_attendance_trend   → idx_attendance_event; status has no index (seq scan fine at scale)
--   parish_breakdown         → same as person_attendance_counts
--   new_vs_returning_monthly → idx_attendance_event, idx_attendance_person, idx_attendance_checked_in;
--       AT TIME ZONE transform prevents index use on checked_in_at.
--   Deferred index candidate: attendance(person_id, checked_in_at) for first-attendance CTE in
--   new_vs_returning_monthly — revisit when attendance table exceeds ~10k rows.

-- ============================================================
-- § 0  Precheck — Postgres 15+ required for security_invoker
-- ============================================================

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'S3-T2 LOUD-FAIL: Postgres 15+ required for security_invoker views. Found: %',
      current_setting('server_version');
  END IF;
END $$;

-- ============================================================
-- § 1  attendance_summary
--      Raw denormalized base. All instance statuses, all persons.
-- ============================================================

DROP VIEW IF EXISTS public.attendance_summary;
CREATE VIEW public.attendance_summary
  WITH (security_invoker = on)
AS
SELECT
  a.id                    AS attendance_id,
  a.checked_in_at,
  a.source,
  a.checked_in_by,
  p.id                    AS person_id,
  p.full_name,
  p.nickname,
  p.phone_e164,
  p.origin_parish,
  p.gender,
  p.marital_status,
  p.tribe,
  p.kepanitiaan,
  p.deleted_at            AS person_deleted_at,
  ei.id                   AS event_instance_id,
  ei.scheduled_at,
  ei.status               AS instance_status,
  ei.event_name_snapshot,
  ei.event_name_snapshot_id,
  e.id                    AS event_id,
  e.event_type
FROM attendance          a
JOIN people          p  ON p.id  = a.person_id
JOIN event_instances ei ON ei.id = a.event_instance_id
JOIN events          e  ON e.id  = ei.event_id;

GRANT  SELECT ON public.attendance_summary TO authenticated;
REVOKE SELECT ON public.attendance_summary FROM anon;

COMMENT ON VIEW public.attendance_summary IS
'Raw denormalized attendance base. Includes ALL instance statuses (including cancelled) '
'and ALL persons (including soft-deleted). '
'Soft-delete rule: everyone included; person_deleted_at exposed for UI (deleted) badge. '
'Cancelled rule: none excluded here; consumers filter on instance_status column.';

-- ============================================================
-- § 2  person_attendance_counts
--      Current roster only. FILTER pattern keeps zero-count rows.
-- ============================================================

DROP VIEW IF EXISTS public.person_attendance_counts;
CREATE VIEW public.person_attendance_counts
  WITH (security_invoker = on)
AS
SELECT
  p.id              AS person_id,
  p.full_name,
  p.nickname,
  p.phone_e164,
  p.origin_parish,
  count(a.id)                 FILTER (WHERE ei.status <> 'cancelled') AS total_attendance,
  count(DISTINCT ei.event_id) FILTER (WHERE ei.status <> 'cancelled') AS distinct_events,
  min(a.checked_in_at)        FILTER (WHERE ei.status <> 'cancelled') AS first_attended_at,
  max(a.checked_in_at)        FILTER (WHERE ei.status <> 'cancelled') AS last_attended_at
FROM people              p
LEFT JOIN attendance      a  ON a.person_id        = p.id
LEFT JOIN event_instances ei ON ei.id              = a.event_instance_id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.full_name, p.nickname, p.phone_e164, p.origin_parish;

GRANT  SELECT ON public.person_attendance_counts TO authenticated;
REVOKE SELECT ON public.person_attendance_counts FROM anon;

COMMENT ON VIEW public.person_attendance_counts IS
'Per-person attendance summary for the current roster. '
'Soft-delete rule: soft-deleted people excluded (WHERE deleted_at IS NULL). '
'Cancelled rule: excluded from all aggregates via FILTER — zero-count roster members still appear '
'because the filter is on the aggregate, not on the join condition.';

-- ============================================================
-- § 3  event_attendance_trend
--      One row per non-cancelled instance; attendee_count zero-filled.
-- ============================================================

DROP VIEW IF EXISTS public.event_attendance_trend;
CREATE VIEW public.event_attendance_trend
  WITH (security_invoker = on)
AS
SELECT
  ei.id                   AS event_instance_id,
  ei.event_id,
  e.event_type,
  ei.event_name_snapshot,
  ei.event_name_snapshot_id,
  ei.scheduled_at,
  count(a.id)             AS attendee_count
FROM event_instances     ei
JOIN events              e   ON e.id               = ei.event_id
LEFT JOIN attendance     a   ON a.event_instance_id = ei.id
WHERE ei.status <> 'cancelled'
GROUP BY ei.id, ei.event_id, e.event_type,
         ei.event_name_snapshot, ei.event_name_snapshot_id, ei.scheduled_at;

GRANT  SELECT ON public.event_attendance_trend TO authenticated;
REVOKE SELECT ON public.event_attendance_trend FROM anon;

COMMENT ON VIEW public.event_attendance_trend IS
'Per-event-instance attendee count. '
'Soft-delete rule: includes soft-deleted people (historical turnout must not shrink retroactively). '
'Cancelled rule: cancelled instances excluded at WHERE clause; no row produced. '
'attendee_count zero-filled for instances with no attendance via LEFT JOIN.';

-- ============================================================
-- § 4  parish_breakdown
--      Current roster only.
-- ============================================================

DROP VIEW IF EXISTS public.parish_breakdown;
CREATE VIEW public.parish_breakdown
  WITH (security_invoker = on)
AS
SELECT
  COALESCE(p.origin_parish, '(Unknown)')                       AS parish,
  count(DISTINCT p.id)                                         AS people_count,
  count(a.id) FILTER (WHERE ei.status <> 'cancelled')         AS attendance_count
FROM people              p
LEFT JOIN attendance      a  ON a.person_id        = p.id
LEFT JOIN event_instances ei ON ei.id              = a.event_instance_id
WHERE p.deleted_at IS NULL
GROUP BY COALESCE(p.origin_parish, '(Unknown)');

GRANT  SELECT ON public.parish_breakdown TO authenticated;
REVOKE SELECT ON public.parish_breakdown FROM anon;

COMMENT ON VIEW public.parish_breakdown IS
'Parish-level roster and attendance counts. '
'Soft-delete rule: current roster only (deleted_at IS NULL). '
'Parish is raw free-text; NULLs shown as ''(Unknown)''. No trim/case-merge until Sprint 5 curation. '
'Cancelled rule: cancelled instances excluded from attendance_count via FILTER.';

-- ============================================================
-- § 5  new_vs_returning_monthly
--      Jakarta-bucketed. "new" = person's global first-ever month.
-- ============================================================

DROP VIEW IF EXISTS public.new_vs_returning_monthly;
CREATE VIEW public.new_vs_returning_monthly
  WITH (security_invoker = on)
AS
WITH person_first AS (
  SELECT
    a.person_id,
    date_trunc('month',
      min(a.checked_in_at) AT TIME ZONE 'Asia/Jakarta'
    ) AS first_month
  FROM attendance      a
  JOIN event_instances ei ON ei.id = a.event_instance_id
                         AND ei.status <> 'cancelled'
  GROUP BY a.person_id
),
person_month AS (
  SELECT DISTINCT
    a.person_id,
    date_trunc('month',
      a.checked_in_at AT TIME ZONE 'Asia/Jakarta'
    ) AS month
  FROM attendance      a
  JOIN event_instances ei ON ei.id = a.event_instance_id
                         AND ei.status <> 'cancelled'
)
SELECT
  pm.month,
  count(*) FILTER (WHERE pm.month = pf.first_month) AS new_count,
  count(*) FILTER (WHERE pm.month > pf.first_month) AS returning_count
FROM person_month pm
JOIN person_first pf ON pf.person_id = pm.person_id
GROUP BY pm.month
ORDER BY pm.month;

GRANT  SELECT ON public.new_vs_returning_monthly TO authenticated;
REVOKE SELECT ON public.new_vs_returning_monthly FROM anon;

COMMENT ON VIEW public.new_vs_returning_monthly IS
'Monthly new-vs-returning attendance breakdown, bucketed in Asia/Jakarta timezone. '
'"new" = person''s global first month ever (across all non-cancelled attendance). '
'Soft-delete rule: includes soft-deleted people (historical counts must not shrink retroactively). '
'Cancelled rule: excluded from both CTEs. '
'Deferred index candidate: attendance(person_id, checked_in_at) for first-attendance CTE — '
'not created at this scale; revisit when attendance table exceeds ~10k rows.';
