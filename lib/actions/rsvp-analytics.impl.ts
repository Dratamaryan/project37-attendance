// No 'use server' — imported by analytics.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// S9-R7 RSVP analytics. SERVER client (RLS) by contract: callers pass their
// createClient() session; this module never imports lib/supabase/admin.
// rsvp_instance_metrics is is_admin()-filtered (and built on the
// is_admin()-filtered rsvp_checkin_crosstab), so a service-role or organizer
// client would read zero rows — the admin guard below makes that explicit.

import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'
import { validateFilters, type AnalyticsFilters } from './analytics.types'
import type {
  GetRsvpAnalyticsResult,
  RsvpChartRow,
  RsvpInstanceMetricsRow,
  RsvpKpis,
} from './rsvp-analytics.types'

const PAGE_SIZE = 500          // below PostgREST max_rows=1000, same as rsvp/admin.impl.ts

const COLUMNS =
  'event_instance_id, event_id, event_type, scheduled_at, ended_at, ' +
  'coming_people, coming_headcount, coming_came, coming_no_show, walk_ins, ' +
  'actual_adults, actual_children, newcomer_rsvps, became_members, ' +
  'invited, invited_responded, invited_attended'

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[] | null> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error('[getRsvpAnalytics] page', error)
      return null
    }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

/** The calendar day after dateStr (YYYY-MM-DD). */
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

/**
 * scheduled_at bounds for the from/to filters, on Asia/Jakarta day boundaries:
 * gte = 00:00 WIB on `from`; lt = 00:00 WIB on the day after `to` (to is
 * inclusive). Filters must already be validated.
 */
export function jakartaScheduledRange(filters: Pick<AnalyticsFilters, 'from' | 'to'>): { gte?: string; lt?: string } {
  const range: { gte?: string; lt?: string } = {}
  if (filters.from !== undefined) range.gte = toJakartaInstant(filters.from, '00:00').toISOString()
  if (filters.to !== undefined) range.lt = toJakartaInstant(nextDay(filters.to), '00:00').toISOString()
  return range
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/** Pooled KPIs: Σ numerator / Σ denominator over all rows; zero denominator -> null. */
export function poolRsvpMetrics(rows: RsvpInstanceMetricsRow[]): RsvpKpis {
  const sum = (pick: (r: RsvpInstanceMetricsRow) => number, from = rows) =>
    from.reduce((acc, r) => acc + pick(r), 0)

  const comingPeople = sum(r => r.coming_people)
  const actualAdults = sum(r => r.actual_adults)
  const invitedRows = rows.filter(r => r.invited > 0)
  const invited = sum(r => r.invited, invitedRows)

  return {
    instances: rows.length,
    coming_headcount: sum(r => r.coming_headcount),
    coming_people: comingPeople,
    actual_adults: actualAdults,
    actual_children: sum(r => r.actual_children),
    show_up_rate: rate(sum(r => r.coming_came), comingPeople),
    no_show_rate: rate(sum(r => r.coming_no_show), comingPeople),
    walk_in_share: rate(sum(r => r.walk_ins), actualAdults),
    newcomer_rsvps: sum(r => r.newcomer_rsvps),
    became_members: sum(r => r.became_members),
    funnel_response_rate: rate(sum(r => r.invited_responded, invitedRows), invited),
    funnel_attendance_rate: rate(sum(r => r.invited_attended, invitedRows), invited),
  }
}

// ── impl_getRsvpAnalytics ────────────────────────────────────────────────────

/**
 * Per-instance RSVP-vs-actual rows (chart) + pooled KPIs (cards) from
 * rsvp_instance_metrics. Read-only.
 *
 * Filter semantics:
 *   from / to   → scheduled_at, Asia/Jakarta day boundaries, to inclusive
 *   eventType   → event_type
 *   parish      → IGNORED (instance-level view, no per-person parish)
 */
export async function impl_getRsvpAnalytics({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters: AnalyticsFilters
}): Promise<GetRsvpAnalyticsResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }

  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  const range = jakartaScheduledRange(filters)

  const rows = await fetchAllPages<RsvpInstanceMetricsRow>((from, to) => {
    let query = supabase
      .from('rsvp_instance_metrics')
      .select(COLUMNS)
      .order('scheduled_at', { ascending: true })
      .order('event_instance_id', { ascending: true })
    if (range.gte !== undefined) query = query.gte('scheduled_at', range.gte)
    if (range.lt !== undefined) query = query.lt('scheduled_at', range.lt)
    if (filters.eventType !== undefined) query = query.eq('event_type', filters.eventType)
    return query.range(from, to)
  })
  if (!rows) return { status: 'error', message: 'Failed to fetch RSVP analytics' }

  const chartRows: RsvpChartRow[] = rows.map(r => ({
    ...r,
    scheduled_date: formatJakarta(new Date(r.scheduled_at), 'yyyy-MM-dd'),
  }))

  return { status: 'ok', data: { rows: chartRows, kpis: poolRsvpMetrics(rows) } }
}
