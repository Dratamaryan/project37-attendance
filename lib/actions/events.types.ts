// Types for event server actions — imported by events.impl.ts and events.ts.

export type EventInput = {
  name: string
  name_id?: string | null
  event_type: 'friday_monthly' | 'saturday_monthly' | 'sunday_monthly' | 'adhoc' | 'other_recurring'
  start_date: string          // YYYY-MM-DD
  start_time: string          // HH:mm or HH:mm:ss
  duration_min?: number       // default 120
  location?: string | null
  description?: string | null
  recurrence_rule?: string | null  // null for adhoc
  active?: boolean            // default true
}

export type UpdateEventInput = Partial<EventInput>

export type EventRow = {
  id: string
  name: string
  name_id: string | null
  event_type: string
  start_date: string
  start_time: string
  duration_min: number
  location: string | null
  description: string | null
  recurrence_rule: string | null
  active: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export type EventInstanceRow = {
  id: string
  event_id: string
  scheduled_at: string
  event_name_snapshot: string
  event_name_snapshot_id: string | null
  status: 'scheduled' | 'cancelled' | 'completed'
  notes: string | null
  image_url: string | null
  created_at: string
}

// Occurrence-details edit surface (T10) — no fields today: image_url moved to
// lib/storage/event-images (S9-P0). Room for more fields later
// (subtopics/description) as an add-a-field change to this type.
export type UpdateInstanceInput = Record<string, never>

export type UpdateInstanceResult =
  | { status: 'ok'; instance_id: string }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

export type CreateEventResult =
  | { status: 'ok'; event_id: string; instances_created: number }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

export type UpdateEventResult =
  | { status: 'ok'; event_id: string }
  | { status: 'invalid_input'; field: string; message: string }
  | { status: 'not_found' }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

export type CancelInstanceResult =
  | { status: 'ok'; instance_id: string }
  | { status: 'not_found' }
  | { status: 'already_cancelled' }
  | { status: 'not_cancellable'; current_status: string }
  | { status: 'forbidden'; message: string }
  | { status: 'error'; message: string }

export type ListEventsFilters = {
  active?: boolean
  event_type?: string
}

export type ListEventsResult =
  | { status: 'ok'; events: EventRow[] }
  | { status: 'error'; message: string }

export type ListInstancesResult =
  | { status: 'ok'; instances: EventInstanceRow[] }
  | { status: 'error'; message: string }

// ── listNearestInstances ───────────────────────────────────────────────────────

export type NearestInstanceRow = {
  id: string
  event_id: string
  scheduled_at: string
  status: 'scheduled' | 'cancelled' | 'completed'
  event_name_snapshot: string
  event_name_snapshot_id: string | null
}

export type ListNearestResult =
  | { status: 'ok'; instances: NearestInstanceRow[] }
  | { status: 'error'; message: string }

// ── rescheduleInstance (S9.5-T4) ───────────────────────────────────────────────

// SQL refusal codes raised by public.reschedule_instance() as 'reschedule:<code>',
// plus the action's own pre-RPC validation codes. Each has an en + id message
// under admin.events.instance.reschedule.errors.
export type RescheduleErrorCode =
  | 'not_admin'
  | 'not_found'
  | 'not_scheduled'
  | 'original_in_past'
  | 'event_inactive'
  | 'not_recurring'
  | 'new_in_past'
  | 'beyond_horizon'
  | 'same_time'
  | 'slot_taken'
  | 'reason_required'
  | 'reason_too_long'
  | 'invalid_instance'
  | 'invalid_date'
  | 'invalid_time'
  | 'unauthenticated'
  | 'unknown'

export type RescheduleInstanceResult =
  | { status: 'ok'; instance_id: string; event_id: string }
  | { status: 'error'; code: RescheduleErrorCode }
