// Types for the S8-T5 per-instance attendee list (/checkin/[instanceId]/attendees)
// and the admin per-instance export — imported by instance-attendees.impl.ts,
// the page, the export route, and tests.

export type InstanceHeader = {
  id: string
  scheduled_at: string
  status: string
  event_name_snapshot: string
}

export type InstanceAdultAttendee = {
  attendance_id: string
  full_name: string
  nickname: string | null
  phone_masked: string        // "•••• 1234" — full number never leaves the server
  checked_in_at: string       // ISO; formatted HH:mm WIB at render
  is_first_timer: boolean
  checker_email: string | null // only populated when includeCheckerEmail (admin export)
}

export type InstanceChildAttendee = {
  child_attendance_id: string
  child_name: string
  parent_name: string | null          // null when the parent is soft-deleted / hidden by RLS
  parent_phone_masked: string | null
  checked_in_at: string
}

export type GetInstanceAttendeesResult =
  | { status: 'ok'; instance: InstanceHeader; adults: InstanceAdultAttendee[]; children: InstanceChildAttendee[] }
  | { status: 'invalid_input' }
  | { status: 'not_found' }
  | { status: 'error'; message: string }
