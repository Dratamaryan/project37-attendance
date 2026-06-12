// No 'use server' — imported by attendance.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  CreateAttendanceInput,
  AttendanceRow,
  CreateAttendanceResult,
} from './attendance.types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ATTENDANCE_FIELDS =
  'id, event_instance_id, person_id, checked_in_at, checked_in_by, source'

const DEFAULT_SOURCE = 'volunteer_checkin'

// ── createAttendance ──────────────────────────────────────────────────────────

export async function impl_createAttendance({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: CreateAttendanceInput
}): Promise<CreateAttendanceResult> {
  // 1. Validate input shape
  if (!UUID_RE.test(input.personId)) {
    return { status: 'invalid_input', field: 'personId', message: 'Invalid person id' }
  }
  if (!UUID_RE.test(input.eventInstanceId)) {
    return { status: 'invalid_input', field: 'eventInstanceId', message: 'Invalid event instance id' }
  }

  // 2. Auth — getClaims validates the JWT signature (never getSession)
  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'forbidden', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  // 3. Pre-flight: active app_user + instance/event status + person, in parallel.
  //    All three run under the user-session client (RLS enforced). A tiny race
  //    window between this check and the INSERT is accepted — an admin cancelling
  //    the instance mid-check-in still yields a valid attendance row; T10's
  //    display layer absorbs the edge with status badges.
  const [appUserRes, instanceRes, personRes] = await Promise.all([
    supabase
      .from('app_users')
      .select('id, active')
      .eq('id', actorId)
      .maybeSingle(),
    supabase
      .from('event_instances')
      .select('id, status, events!inner(active)')
      .eq('id', input.eventInstanceId)
      .maybeSingle(),
    supabase
      .from('people')
      .select('id, deleted_at')
      .eq('id', input.personId)
      .maybeSingle(),
  ])

  const appUser = appUserRes.data as { id: string; active: boolean } | null
  if (!appUser || !appUser.active) {
    return { status: 'forbidden', message: 'Not an active app user' }
  }

  if (instanceRes.error) {
    console.error('[createAttendance] instance pre-flight', instanceRes.error)
    return { status: 'error', message: 'Failed to validate event instance' }
  }
  const instance = instanceRes.data as unknown as {
    id: string
    status: string
    events: { active: boolean }
  } | null
  if (!instance) return { status: 'instance_not_found' }

  const person = personRes.data as { id: string; deleted_at: string | null } | null
  if (!person) {
    // Organizer RLS hides soft-deleted people (deleted_at IS NULL filter), so a
    // missing row is ambiguous: truly absent vs soft-deleted. Disambiguate via
    // admin client — same idiom as impl_updateEvent / impl_cancelInstance.
    const { data: adminPerson } = await adminSupabase
      .from('people')
      .select('id, deleted_at')
      .eq('id', input.personId)
      .maybeSingle()
    if (!adminPerson) return { status: 'person_not_found' }
    if ((adminPerson as { deleted_at: string | null }).deleted_at !== null) {
      return { status: 'person_soft_deleted' }
    }
    return { status: 'person_not_found' }
  }
  if (person.deleted_at !== null) return { status: 'person_soft_deleted' }

  if (instance.status === 'cancelled') return { status: 'event_cancelled' }
  if (!instance.events.active) return { status: 'event_inactive' }

  // 4. INSERT under the user-session client. RLS WITH CHECK enforces
  //    checked_in_by = auth.uid() — the impl never accepts it from input.
  const { data: inserted, error: insertError } = await supabase
    .from('attendance')
    .insert({
      event_instance_id: input.eventInstanceId,
      person_id:         input.personId,
      checked_in_by:     actorId,
      source:            input.source ?? DEFAULT_SOURCE,
    })
    .select(ATTENDANCE_FIELDS)
    .single()

  // 5. Error mapping by Postgres code — never rely on error === null alone
  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation (uniq_attendance) — duplicate check-in, possibly from a
      // concurrent racer. Fetch the winning row for the friendly result.
      const { data: existing, error: existingError } = await supabase
        .from('attendance')
        .select(ATTENDANCE_FIELDS)
        .eq('event_instance_id', input.eventInstanceId)
        .eq('person_id', input.personId)
        .single()
      if (existingError || !existing) {
        console.error('[createAttendance] 23505 follow-up select failed', existingError)
        return { status: 'error', message: 'Duplicate check-in could not be resolved' }
      }
      return { status: 'already_checked_in', existing: existing as unknown as AttendanceRow }
    }
    if (insertError.code === '42501') {
      return { status: 'forbidden', message: 'Permission denied' }
    }
    if (insertError.code === '23503') {
      // FK violation — pre-flight should have caught this; log and map by constraint
      console.error('[createAttendance] unexpected FK violation', insertError)
      if (insertError.message.includes('person_id')) return { status: 'person_not_found' }
      return { status: 'instance_not_found' }
    }
    console.error('[createAttendance] insert', insertError)
    return { status: 'error', message: 'Failed to record attendance' }
  }

  if (!inserted) {
    return { status: 'error', message: 'Failed to record attendance' }
  }

  const attendance = inserted as unknown as AttendanceRow

  // 6. Audit on success only — already_checked_in is not a state change
  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.ATTENDANCE_CREATE,
    entityType:  'attendance',
    entityId:    attendance.id,
    detailsJson: {
      person_id:         input.personId,
      event_instance_id: input.eventInstanceId,
      source:            attendance.source,
    },
  }, supabase)

  return { status: 'ok', attendance }
}
