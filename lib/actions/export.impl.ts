// No 'use server' — imported directly by the export route handler and by tests.
// Never import this file in Client Components.
//
// impl_getRawAttendanceRows is the only DB-touching export: it queries via the
// SERVER Supabase client (user session, RLS-applied through the security_invoker
// attendance_summary view). The admin guard is the route handler's responsibility.
//
// getPersonAttendanceSummary / getEventAttendanceSummary are PURE functions that
// reduce over an already-fetched RawAttendanceRow[] — no Supabase client, no async.
// The route handler fetches attendance_summary rows ONCE and derives both summaries
// from that same array, so the reconciliation invariant
// (sum(event_summary.count) === raw.length === sum(person_summary.count)) holds
// structurally, not by coincidence of matching filters across three queries.

import type { SupabaseClient } from '@supabase/supabase-js'
import { validateFilters } from './analytics.types'
import { applyRawParishFilter } from './analytics.impl'
import type {
  ExportFilters,
  RawAttendanceRow,
  PersonAttendanceSummaryRow,
  EventAttendanceSummaryRow,
  GetRawAttendanceRowsResult,
} from './export.types'

// Confirmed prod PostgREST max_rows = 1000 (Management API /postgrest, 2026-07-01).
// Kept safely BELOW the cap: a full page always returns exactly PAGE_SIZE rows, so
// "page.length < pageSize" is a reliable termination signal regardless of where the
// server ceiling actually sits. Equal-to-cap is brittle — if max_rows ever drops,
// .limit(1000) would silently return fewer than 1000 and terminate the loop early,
// truncating the export.
const DEFAULT_PAGE_SIZE = 500

const RAW_COLUMNS =
  'attendance_id, checked_in_at, source, checked_in_by, person_id, full_name, nickname, ' +
  'phone_e164, origin_parish, gender, marital_status, tribe, kepanitiaan, person_deleted_at, ' +
  'event_instance_id, scheduled_at, instance_status, event_name_snapshot, event_id, event_type'

type RawRowFromDb = {
  attendance_id: string
  checked_in_at: string
  source: string
  checked_in_by: string | null
  person_id: string
  full_name: string
  nickname: string
  phone_e164: string
  origin_parish: string | null
  gender: string | null
  marital_status: string | null
  tribe: string | null
  kepanitiaan: string | null
  person_deleted_at: string | null
  event_instance_id: string
  scheduled_at: string
  instance_status: string
  event_name_snapshot: string
  event_id: string
  event_type: string
}

/**
 * Returns the calendar day immediately after dateStr (YYYY-MM-DD).
 * Same helper as analytics.impl.ts's nextDay — duplicated rather than imported
 * to keep the two modules' filter logic independently readable (it's 4 lines).
 */
function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  const dt = new Date(Date.UTC(y, m - 1, d + 1))
  return dt.toISOString().slice(0, 10)
}

/**
 * Builds the base attendance_summary query with the four export filters applied.
 * Deliberately does NOT exclude cancelled instances or soft-deleted people — export
 * fidelity to the attendance table is the locked Sprint 3 decision (dashboard views
 * apply a "meaningful attendance" lens; this export does not).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFilteredQuery(supabase: SupabaseClient, filters: ExportFilters): any {
  let query = supabase.from('attendance_summary').select(RAW_COLUMNS)

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

  return query
}

/**
 * Keyset-paginates through the filtered attendance_summary rows by
 * (checked_in_at, attendance_id) until exhausted. A fixed .range() ceiling would
 * just move the truncation cliff to a different row count — keyset pagination has
 * no cliff.
 *
 * Cursor values are normalized to Z-form (new Date(...).toISOString()) before
 * interpolation into the PostgREST .or() filter string. Without normalization,
 * a raw timestamptz value like "2026-01-09T12:00:00+00:00" contains a literal
 * "+", which the query string parser decodes as a space — corrupting the filter
 * on every page after the first.
 */
async function fetchFilteredAttendanceRows(
  { supabase, filters }: { supabase: SupabaseClient; filters: ExportFilters },
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<{ status: 'ok'; rows: RawRowFromDb[] } | { status: 'error'; message: string }> {
  const rows: RawRowFromDb[] = []
  let cursor: { checkedInAt: string; attendanceId: string } | null = null

  while (true) {
    let query = buildFilteredQuery(supabase, filters)
      .order('checked_in_at', { ascending: true })
      .order('attendance_id', { ascending: true })
      .limit(pageSize)

    if (cursor) {
      const c = new Date(cursor.checkedInAt).toISOString()
      query = query.or(
        `checked_in_at.gt.${c},and(checked_in_at.eq.${c},attendance_id.gt.${cursor.attendanceId})`,
      )
    }

    const { data, error } = await query

    if (error) {
      console.error('[getRawAttendanceRows] pagination', error)
      return { status: 'error', message: 'Failed to fetch attendance rows' }
    }

    const page = (data ?? []) as unknown as RawRowFromDb[]
    if (page.length === 0) break

    rows.push(...page)

    if (page.length < pageSize) break

    const last = page[page.length - 1]!
    cursor = { checkedInAt: last.checked_in_at, attendanceId: last.attendance_id }
  }

  return { status: 'ok', rows }
}

// ── impl_getRawAttendanceRows ──────────────────────────────────────────────────

/**
 * Fetches one row per attendance record over the filtered set — the raw sheet's
 * data source, and the single source of truth the two summary reducers below
 * both derive from.
 *
 * Filter semantics (identical to impl_getKpiSummary):
 *   from / to   → checked_in_at (attendance-grained)
 *   eventType   → event_type
 *   parish      → origin_parish (raw; '(Unknown)' = IS NULL)
 *
 * Unlike impl_getKpiSummary, this does NOT filter out cancelled instances or
 * soft-deleted people (locked T6 decision: export = fidelity, not dashboard lens).
 */
export async function impl_getRawAttendanceRows(
  { supabase, filters }: { supabase: SupabaseClient; filters: ExportFilters },
  pageSize?: number,
): Promise<GetRawAttendanceRowsResult> {
  const validationError = validateFilters(filters)
  if (validationError) return { status: 'invalid_filter', message: validationError }

  const result = await fetchFilteredAttendanceRows({ supabase, filters }, pageSize)
  if (result.status === 'error') return result

  const data: RawAttendanceRow[] = result.rows.map(r => ({
    attendance_id: r.attendance_id,
    checked_in_at: r.checked_in_at,
    source: r.source,
    checked_in_by: r.checked_in_by,
    person_id: r.person_id,
    full_name: r.full_name,
    nickname: r.nickname,
    phone_e164: r.phone_e164,
    origin_parish: r.origin_parish,
    gender: r.gender,
    marital_status: r.marital_status,
    tribe: r.tribe,
    kepanitiaan: r.kepanitiaan,
    is_deleted: r.person_deleted_at !== null,
    event_instance_id: r.event_instance_id,
    scheduled_at: r.scheduled_at,
    instance_status: r.instance_status,
    event_name_snapshot: r.event_name_snapshot,
    event_id: r.event_id,
    event_type: r.event_type,
  }))

  return { status: 'ok', data }
}

// ── getPersonAttendanceSummary ────────────────────────────────────────────────

/**
 * Pure reducer — groups an already-fetched RawAttendanceRow[] by person_id.
 * No Supabase client, no async: takes the SAME array impl_getRawAttendanceRows
 * returned, so its total row count and this summary's sum(count) are structurally
 * equal (same source array, not two queries that might drift).
 *
 * distinct_events counts distinct event_id (event templates) — NOT distinct
 * event_instance_id, which would just duplicate `count` for events with no
 * repeat instances in range.
 */
export function getPersonAttendanceSummary(rows: RawAttendanceRow[]): PersonAttendanceSummaryRow[] {
  const byPerson = new Map<string, { row: RawAttendanceRow; count: number; events: Set<string> }>()

  for (const row of rows) {
    let entry = byPerson.get(row.person_id)
    if (!entry) {
      entry = { row, count: 0, events: new Set<string>() }
      byPerson.set(row.person_id, entry)
    }
    entry.count += 1
    entry.events.add(row.event_id)
  }

  return Array.from(byPerson.values()).map(({ row, count, events }) => ({
    person_id: row.person_id,
    full_name: row.full_name,
    nickname: row.nickname,
    phone_e164: row.phone_e164,
    origin_parish: row.origin_parish,
    is_deleted: row.is_deleted,
    count,
    distinct_events: events.size,
  }))
}

// ── getEventAttendanceSummary ─────────────────────────────────────────────────

/**
 * Pure reducer — groups an already-fetched RawAttendanceRow[] by event_instance_id.
 *
 * Locked semantics: this is "instances that had attendance in the filtered set,"
 * not "all instances." Because it's derived purely from attendance rows (no
 * event_instances left-join), zero-attendance instances are absent — same
 * limitation event_attendance_trend avoids via LEFT JOIN, deliberately not
 * replicated here to keep the reconciliation invariant structural.
 */
export function getEventAttendanceSummary(rows: RawAttendanceRow[]): EventAttendanceSummaryRow[] {
  const byInstance = new Map<string, { row: RawAttendanceRow; count: number }>()

  for (const row of rows) {
    let entry = byInstance.get(row.event_instance_id)
    if (!entry) {
      entry = { row, count: 0 }
      byInstance.set(row.event_instance_id, entry)
    }
    entry.count += 1
  }

  return Array.from(byInstance.values()).map(({ row, count }) => ({
    event_instance_id: row.event_instance_id,
    event_id: row.event_id,
    event_type: row.event_type,
    event_name_snapshot: row.event_name_snapshot,
    scheduled_at: row.scheduled_at,
    instance_status: row.instance_status,
    count,
  }))
}
