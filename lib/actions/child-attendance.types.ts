// Types for child attendance server actions — imported by child-attendance.impl.ts
// and child-attendance.ts. Mirrors attendance.types.ts; child_id replaces person_id.

export type CreateChildAttendanceInput = {
  childId: string
  eventInstanceId: string
  /**
   * Defaults to 'volunteer_checkin' (the schema default) for the organizer-driven
   * /checkin flow. Never accepts checked_in_by — that is always derived from the
   * session and enforced by RLS WITH CHECK (checked_in_by = auth.uid()).
   */
  source?: string
}

// Mirrors the child_attendance table — like attendance, no created_at column;
// checked_in_at is the record timestamp.
export type ChildAttendanceRow = {
  id: string
  event_instance_id: string
  child_id: string
  checked_in_at: string   // ISO timestamptz
  checked_in_by: string
  source: string
}

export type CreateChildAttendanceResult =
  | { status: 'ok'; attendance: ChildAttendanceRow }
  | { status: 'already_checked_in'; existing: ChildAttendanceRow }
  | { status: 'event_cancelled' }
  | { status: 'event_inactive' }
  | { status: 'instance_not_found' }
  | { status: 'child_not_found' }
  | { status: 'child_soft_deleted' }
  | { status: 'forbidden'; message: string }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'error'; message: string }
