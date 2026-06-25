// No 'use server' — imported by analytics.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// All functions query via the SERVER Supabase client (user session, RLS-applied through
// security_invoker views). The admin guard is T5's responsibility — not enforced here.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  validateFilters,
  type AnalyticsFilters,
  type GetKpiSummaryResult,
  type GetEventAttendanceTrendResult,
  type GetParishBreakdownResult,
  type GetTopAttendeesResult,
  type GetNewVsReturningMonthlyResult,
  type TrendRow,
  type ParishRow,
  type TopAttendeeRow,
  type NewVsReturningRow,
} from './analytics.types'

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the calendar day immediately after dateStr (YYYY-MM-DD).
 * Used to express an inclusive `to` date as an exclusive upper bound on timestamptz
 * columns: .lt(col, nextDay(to)) captures all records through end of `to` day UTC.
 */
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return dt.toISOString().slice(0, 10)
}

// ── Parish filter helpers ─────────────────────────────────────────────────────

/**
 * Applies the parish filter to a Supabase query against a column that holds
 * the raw origin_parish value (nullable text, as in attendance_summary and
 * person_attendance_counts).
 * '(Unknown)' → IS NULL; all other values → exact equality.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyRawParishFilter<Q extends { is: any; eq: any }>(query: Q, parish: string): Q {
  if (parish === '(Unknown)') {
    return query.is('origin_parish', null)
  }
  return query.eq('origin_parish', parish)
}

// ── impl_getKpiSummary ────────────────────────────────────────────────────────

/**
 * Queries attendance_summary to produce KPI header totals.
 *
 * Current-roster semantics (person_deleted_at IS NULL):
 *   Soft-deleted people are excluded from all counts so these KPIs reconcile
 *   with parish_breakdown and person_attendance_counts (both current-roster only).
 *
 * Cancelled instances excluded (instance_status <> 'cancelled').
 *
 * Aggregation is done in TypeScript (single query, minimal columns).
 * Sprint 5 candidate: move to a DB aggregate view when attendance > ~10k rows.
 *
 * Filter semantics:
 *   from / to   → checked_in_at (attendance-grained)
 *   eventType   → event_type
 *   parish      → origin_parish (raw; '(Unknown)' = IS NULL)
 */
export async function impl_getKpiSummary({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
}): Promise<GetKpiSummaryResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  let query = supabase
    .from('attendance_summary')
    .select('attendance_id, person_id, event_id, event_instance_id')
    .neq('instance_status', 'cancelled')
    .is('person_deleted_at', null)

  if (filters.from !== undefined) {
    query = query.gte('checked_in_at', filters.from)
  }
  if (filters.to !== undefined) {
    query = query.lt('checked_in_at', nextDay(filters.to))
  }
  if (filters.eventType !== undefined) {
    query = query.eq('event_type', filters.eventType)
  }
  if (filters.parish !== undefined) {
    query = applyRawParishFilter(query, filters.parish)
  }

  const { data, error } = await query

  if (error) {
    console.error('[getKpiSummary]', error)
    return { status: 'error', message: 'Failed to fetch KPI summary' }
  }

  const rows = (data ?? []) as Array<{
    attendance_id: string
    person_id: string
    event_id: string
    event_instance_id: string
  }>

  const summary = {
    total_checkins:     rows.length,
    distinct_people:    new Set(rows.map(r => r.person_id)).size,
    distinct_events:    new Set(rows.map(r => r.event_id)).size,
    distinct_instances: new Set(rows.map(r => r.event_instance_id)).size,
  }

  return { status: 'ok', data: summary }
}

// ── impl_getEventAttendanceTrend ──────────────────────────────────────────────

/**
 * Queries event_attendance_trend for time-series chart data.
 *
 * Filter semantics:
 *   from / to   → scheduled_at (instance-grained, not check-in time)
 *   eventType   → event_type
 *   parish      → IGNORED (view has no origin_parish column)
 *
 * Parish is silently ignored — the view aggregates headcounts per instance
 * and has no per-person parish data. Pass a parish filter and you get the
 * full trend, unfiltered by parish — document this for T5 callers.
 */
export async function impl_getEventAttendanceTrend({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
}): Promise<GetEventAttendanceTrendResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  let query = supabase
    .from('event_attendance_trend')
    .select(
      'event_instance_id, event_id, event_type, event_name_snapshot, event_name_snapshot_id, scheduled_at, attendee_count',
    )
    .order('scheduled_at', { ascending: true })

  if (filters.from !== undefined) {
    query = query.gte('scheduled_at', filters.from)
  }
  if (filters.to !== undefined) {
    query = query.lt('scheduled_at', nextDay(filters.to))
  }
  if (filters.eventType !== undefined) {
    query = query.eq('event_type', filters.eventType)
  }
  // filters.parish intentionally not applied (see JSDoc)

  const { data, error } = await query

  if (error) {
    console.error('[getEventAttendanceTrend]', error)
    return { status: 'error', message: 'Failed to fetch attendance trend' }
  }

  const rows = (data ?? []) as unknown as TrendRow[]
  return { status: 'ok', data: rows.map(r => ({ ...r, attendee_count: Number(r.attendee_count) })) }
}

// ── impl_getParishBreakdown ───────────────────────────────────────────────────

/**
 * Queries parish_breakdown for current-roster parish distribution.
 *
 * Filter semantics:
 *   parish      → parish column (COALESCE'd; '(Unknown)' is a direct string match)
 *   from / to   → IGNORED (view aggregates all-time; no timestamp column)
 *   eventType   → IGNORED (no event_type column)
 *
 * Date range and eventType are silently ignored — the view is an all-time
 * aggregate over the current roster. Document for T5 callers.
 */
export async function impl_getParishBreakdown({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
}): Promise<GetParishBreakdownResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  let query = supabase
    .from('parish_breakdown')
    .select('parish, people_count, attendance_count')
    .order('people_count', { ascending: false })

  if (filters.parish !== undefined) {
    // parish_breakdown exposes the COALESCE'd value, so '(Unknown)' is a direct match
    query = query.eq('parish', filters.parish)
  }
  // filters.from, filters.to, filters.eventType intentionally not applied (see JSDoc)

  const { data, error } = await query

  if (error) {
    console.error('[getParishBreakdown]', error)
    return { status: 'error', message: 'Failed to fetch parish breakdown' }
  }

  const rows = (data ?? []) as unknown as ParishRow[]
  return {
    status: 'ok',
    data: rows.map(r => ({
      ...r,
      people_count:     Number(r.people_count),
      attendance_count: Number(r.attendance_count),
    })),
  }
}

// ── impl_getTopAttendees ──────────────────────────────────────────────────────

/**
 * Queries person_attendance_counts for the top-N most frequent attenders.
 * Current-roster only (view already excludes soft-deleted people).
 *
 * Filter semantics:
 *   parish      → origin_parish (raw; '(Unknown)' = IS NULL)
 *   from / to   → IGNORED (view pre-aggregates all-time counts; no date range applicable)
 *   eventType   → IGNORED (no event_type column — all events are aggregated together)
 *
 * Date range and eventType are silently ignored — the view cannot be filtered
 * by date after pre-aggregation. Document for T5 callers.
 *
 * @param limit default 10, max 100
 */
export async function impl_getTopAttendees({
  supabase,
  filters,
  limit = 10,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
  limit?: number
}): Promise<GetTopAttendeesResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  const clampedLimit = Math.max(1, Math.min(limit, 100))

  let query = supabase
    .from('person_attendance_counts')
    .select(
      'person_id, full_name, nickname, phone_e164, origin_parish, total_attendance, distinct_events, first_attended_at, last_attended_at',
    )
    .order('total_attendance', { ascending: false })
    .order('full_name',        { ascending: true })
    .limit(clampedLimit)

  if (filters.parish !== undefined) {
    query = applyRawParishFilter(query, filters.parish)
  }
  // filters.from, filters.to, filters.eventType intentionally not applied (see JSDoc)

  const { data, error } = await query

  if (error) {
    console.error('[getTopAttendees]', error)
    return { status: 'error', message: 'Failed to fetch top attendees' }
  }

  const rows = (data ?? []) as unknown as TopAttendeeRow[]
  return {
    status: 'ok',
    data: rows.map(r => ({
      ...r,
      total_attendance: Number(r.total_attendance),
      distinct_events:  Number(r.distinct_events),
    })),
  }
}

// ── impl_getNewVsReturningMonthly ─────────────────────────────────────────────

/**
 * Queries new_vs_returning_monthly for the month-by-month new/returning chart.
 * Includes soft-deleted people (historical counts must not shrink retroactively).
 *
 * Filter semantics:
 *   from / to   → month (Jakarta-bucketed month start; gte/lte comparison works
 *                  because month values are month-start timestamps)
 *   parish      → IGNORED (view has no origin_parish column)
 *   eventType   → IGNORED (view has no event_type column)
 *
 * Parish and eventType are silently ignored — the view aggregates all parishes
 * and event types. Document for T5 callers.
 */
export async function impl_getNewVsReturningMonthly({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
}): Promise<GetNewVsReturningMonthlyResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  let query = supabase
    .from('new_vs_returning_monthly')
    .select('month, new_count, returning_count')
    .order('month', { ascending: true })

  if (filters.from !== undefined) {
    query = query.gte('month', filters.from)
  }
  if (filters.to !== undefined) {
    // lte against the to date captures the month bucket whose start <= to
    // e.g. to='2026-01-31' captures the '2026-01-01T00:00:00' bucket correctly
    query = query.lte('month', filters.to)
  }
  // filters.parish, filters.eventType intentionally not applied (see JSDoc)

  const { data, error } = await query

  if (error) {
    console.error('[getNewVsReturningMonthly]', error)
    return { status: 'error', message: 'Failed to fetch new vs returning data' }
  }

  const rows = (data ?? []) as unknown as NewVsReturningRow[]
  return {
    status: 'ok',
    data: rows.map(r => ({
      ...r,
      new_count:       Number(r.new_count),
      returning_count: Number(r.returning_count),
    })),
  }
}
