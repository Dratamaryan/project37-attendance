// Types for the T6 Excel export data layer — imported by export.impl.ts and tests.

import type { AnalyticsFilters } from './analytics.types'

// Same shape/semantics as AnalyticsFilters (from/to/eventType/parish). Re-exported
// under an export-specific name so callers don't need to import from analytics.types.
export type ExportFilters = AnalyticsFilters

/**
 * One row per attendance record — fidelity view of the attendance table.
 * Unlike the dashboard views, this INCLUDES cancelled-instance attendance
 * (instance_status column lets consumers see/filter it) and soft-deleted
 * people (is_deleted column) — export is a raw historical record, not a
 * "meaningful attendance" dashboard metric.
 */
export type RawAttendanceRow = {
  attendance_id: string
  checked_in_at: string          // ISO timestamptz
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
  is_deleted: boolean            // derived from person_deleted_at IS NOT NULL
  event_instance_id: string
  scheduled_at: string           // ISO timestamptz
  instance_status: string
  event_name_snapshot: string
  event_id: string
  event_type: string
}

/**
 * Per-person aggregate over the SAME filtered row set as RawAttendanceRow.
 * distinct_events = distinct event_id (event templates), NOT distinct instances.
 */
export type PersonAttendanceSummaryRow = {
  person_id: string
  full_name: string
  nickname: string
  phone_e164: string
  origin_parish: string | null
  is_deleted: boolean
  count: number
  distinct_events: number
}

/**
 * Per-event-instance aggregate over the SAME filtered row set as RawAttendanceRow.
 * Derived purely from attendance rows — instances with ZERO attendance in the
 * filtered set are absent (no event_instances left-join). Locked semantics:
 * "instances that had attendance," not "all instances."
 */
export type EventAttendanceSummaryRow = {
  event_instance_id: string
  event_id: string
  event_type: string
  event_name_snapshot: string
  scheduled_at: string
  instance_status: string
  count: number
}

export type GetRawAttendanceRowsResult =
  | { status: 'ok'; data: RawAttendanceRow[] }
  | { status: 'invalid_filter'; message: string }
  | { status: 'error'; message: string }
