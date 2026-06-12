// Types for attendance server actions — imported by attendance.impl.ts and attendance.ts.

export type CreateAttendanceInput = {
  personId: string
  eventInstanceId: string
  /**
   * Defaults to 'volunteer_checkin' (the schema default) for the organizer-driven
   * /checkin flow. Other known values: 'self_qr', 'imported', 'manual_correction'.
   * Never accepts checked_in_by — that is always derived from the session and
   * enforced by RLS WITH CHECK (checked_in_by = auth.uid()).
   */
  source?: string
}

// Mirrors the attendance table — note: no created_at column; checked_in_at is the record timestamp.
export type AttendanceRow = {
  id: string
  event_instance_id: string
  person_id: string
  checked_in_at: string   // ISO timestamptz
  checked_in_by: string
  source: string
}

export type CreateAttendanceResult =
  | { status: 'ok'; attendance: AttendanceRow }
  | { status: 'already_checked_in'; existing: AttendanceRow }
  | { status: 'event_cancelled' }
  | { status: 'event_inactive' }
  | { status: 'instance_not_found' }
  | { status: 'person_not_found' }
  | { status: 'person_soft_deleted' }
  | { status: 'forbidden'; message: string }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'error'; message: string }

export type AttendanceWithPerson = {
  id: string
  event_instance_id: string
  checked_in_at: string   // ISO timestamptz
  source: string | null
  person: {
    id: string
    full_name: string
    nickname: string | null
    photo_url: string | null      // raw storage path or legacy URL
    photo_signed_url: string | null  // signed 1h URL, or null if no photo / signing failed
    deleted_at: string | null    // ISO if soft-deleted, else null
  }
}

export type ListRecentAttendanceInput = {
  eventInstanceId: string
  limit?: number  // default 20, max 50
}

export type ListRecentAttendanceResult =
  | { status: 'ok'; attendances: AttendanceWithPerson[] }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'error'; message: string }
