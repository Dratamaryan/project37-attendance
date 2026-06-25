// Types for analytics server actions — imported by analytics.impl.ts and analytics.ts.

export type EventType = 'friday_monthly' | 'sunday_monthly' | 'adhoc' | 'other_recurring'

export const VALID_EVENT_TYPES = new Set<string>([
  'friday_monthly',
  'sunday_monthly',
  'adhoc',
  'other_recurring',
])

// ISO YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type AnalyticsFilters = {
  from?: string        // ISO YYYY-MM-DD — inclusive lower bound on date range
  to?: string          // ISO YYYY-MM-DD — inclusive upper bound on date range
  eventType?: EventType
  parish?: string      // raw origin_parish text; '(Unknown)' maps to IS NULL in base-table views
}

/**
 * Parses raw URL searchParams into typed AnalyticsFilters.
 * Strips array-valued params, ignores unknown keys, silently drops invalid eventType.
 */
export function parseAnalyticsFilters(
  params: Record<string, string | string[] | undefined>,
): AnalyticsFilters {
  const filters: AnalyticsFilters = {}

  const from = typeof params['from'] === 'string' ? params['from'] : undefined
  const to   = typeof params['to']   === 'string' ? params['to']   : undefined
  const et   = typeof params['eventType'] === 'string' ? params['eventType'] : undefined
  const par  = typeof params['parish'] === 'string' ? params['parish'] : undefined

  if (from !== undefined) filters.from = from
  if (to   !== undefined) filters.to   = to
  if (et !== undefined && VALID_EVENT_TYPES.has(et)) filters.eventType = et as EventType
  if (par  !== undefined) filters.parish = par

  return filters
}

/** Returns an error message string if filters are invalid, else null. */
export function validateFilters(f: AnalyticsFilters): string | null {
  if (f.from !== undefined && !ISO_DATE_RE.test(f.from)) {
    return `invalid 'from' date: ${f.from}`
  }
  if (f.to !== undefined && !ISO_DATE_RE.test(f.to)) {
    return `invalid 'to' date: ${f.to}`
  }
  if (f.eventType !== undefined && !VALID_EVENT_TYPES.has(f.eventType)) {
    return `invalid eventType: ${f.eventType}`
  }
  return null
}

// ── Row types ─────────────────────────────────────────────────────────────────

/**
 * KPI totals for the dashboard header cards.
 * Current-roster semantics throughout: soft-deleted people excluded from all counts
 * so these numbers reconcile with parish_breakdown and person_attendance_counts.
 */
export type KpiSummary = {
  total_checkins: number       // non-cancelled attendance rows for non-soft-deleted people
  distinct_people: number      // distinct people (deleted_at IS NULL) with ≥1 check-in in range
  distinct_events: number      // distinct event templates
  distinct_instances: number   // distinct event instances (always ≥ distinct_events)
}

export type TrendRow = {
  event_instance_id: string
  event_id: string
  event_type: string
  event_name_snapshot: string
  event_name_snapshot_id: string | null
  scheduled_at: string             // ISO timestamptz
  attendee_count: number
}

export type ParishRow = {
  parish: string                   // COALESCE'd; '(Unknown)' for null origin_parish
  people_count: number
  attendance_count: number
}

export type TopAttendeeRow = {
  person_id: string
  full_name: string
  nickname: string
  phone_e164: string
  origin_parish: string | null
  total_attendance: number
  distinct_events: number
  first_attended_at: string | null
  last_attended_at: string | null
}

export type NewVsReturningRow = {
  month: string                    // ISO date string — Jakarta-bucketed month start
  new_count: number
  returning_count: number
}

// ── Result types ──────────────────────────────────────────────────────────────

export type GetKpiSummaryResult =
  | { status: 'ok'; data: KpiSummary }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }

export type GetEventAttendanceTrendResult =
  | { status: 'ok'; data: TrendRow[] }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }

export type GetParishBreakdownResult =
  | { status: 'ok'; data: ParishRow[] }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }

export type GetTopAttendeesResult =
  | { status: 'ok'; data: TopAttendeeRow[] }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }

export type GetNewVsReturningMonthlyResult =
  | { status: 'ok'; data: NewVsReturningRow[] }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }
