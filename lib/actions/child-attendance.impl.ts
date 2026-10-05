// No 'use server' — imported by child-attendance.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// S8-T2: mirrors impl_createAttendance's shape but is its own function. It writes
// ONLY to child_attendance — table names below are string literals, never a
// parameter, so this path cannot reach the adult `attendance` table.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  CreateChildAttendanceInput,
  ChildAttendanceRow,
  CreateChildAttendanceResult,
} from './child-attendance.types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CHILD_ATTENDANCE_FIELDS =
  'id, event_instance_id, child_id, checked_in_at, checked_in_by, source'

const DEFAULT_SOURCE = 'volunteer_checkin'

// ── createChildAttendance ─────────────────────────────────────────────────────

export async function impl_createChildAttendance({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: CreateChildAttendanceInput
}): Promise<CreateChildAttendanceResult> {
  // 1. Validate input shape
  if (!UUID_RE.test(input.childId)) {
    return { status: 'invalid_input', field: 'childId', message: 'Invalid child id' }
  }
  if (!UUID_RE.test(input.eventInstanceId)) {
    return { status: 'invalid_input', field: 'eventInstanceId', message: 'Invalid event instance id' }
  }

  // 2. Auth — getClaims validates the JWT signature (never getSession)
  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'forbidden', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  // 3. Pre-flight: active app_user + instance/event status + child, in parallel.
  //    All three run under the user-session client (RLS enforced). Same accepted
  //    race window as the adult path between this check and the INSERT.
  const [appUserRes, instanceRes, childRes] = await Promise.all([
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
      .from('children')
      .select('id, deleted_at')
      .eq('id', input.childId)
      .maybeSingle(),
  ])

  const appUser = appUserRes.data as { id: string; active: boolean } | null
  if (!appUser || !appUser.active) {
    return { status: 'forbidden', message: 'Not an active app user' }
  }

  if (instanceRes.error) {
    console.error('[createChildAttendance] instance pre-flight', instanceRes.error)
    return { status: 'error', message: 'Failed to validate event instance' }
  }
  const instance = instanceRes.data as unknown as {
    id: string
    status: string
    events: { active: boolean }
  } | null
  if (!instance) return { status: 'instance_not_found' }

  const child = childRes.data as { id: string; deleted_at: string | null } | null
  if (!child) {
    // Organizer RLS hides soft-deleted children (children_organizer_select:
    // deleted_at IS NULL), so a missing row is ambiguous: truly absent vs
    // soft-deleted. Disambiguate via admin client — same idiom as the adult path.
    const { data: adminChild } = await adminSupabase
      .from('children')
      .select('id, deleted_at')
      .eq('id', input.childId)
      .maybeSingle()
    if (!adminChild) return { status: 'child_not_found' }
    if ((adminChild as { deleted_at: string | null }).deleted_at !== null) {
      return { status: 'child_soft_deleted' }
    }
    return { status: 'child_not_found' }
  }
  if (child.deleted_at !== null) return { status: 'child_soft_deleted' }

  if (instance.status === 'cancelled') return { status: 'event_cancelled' }
  if (!instance.events.active) return { status: 'event_inactive' }

  // 4. INSERT under the user-session client. RLS WITH CHECK enforces
  //    checked_in_by = auth.uid() — the impl never accepts it from input.
  const { data: inserted, error: insertError } = await supabase
    .from('child_attendance')
    .insert({
      event_instance_id: input.eventInstanceId,
      child_id:          input.childId,
      checked_in_by:     actorId,
      source:            input.source ?? DEFAULT_SOURCE,
    })
    .select(CHILD_ATTENDANCE_FIELDS)
    .single()

  // 5. Error mapping by Postgres code — never rely on error === null alone
  if (insertError) {
    if (insertError.code === '23505') {
      // Unique violation (uniq_child_attendance) — duplicate check-in, possibly
      // from a concurrent racer. Fetch the winning row for the friendly result.
      const { data: existing, error: existingError } = await supabase
        .from('child_attendance')
        .select(CHILD_ATTENDANCE_FIELDS)
        .eq('event_instance_id', input.eventInstanceId)
        .eq('child_id', input.childId)
        .single()
      if (existingError || !existing) {
        console.error('[createChildAttendance] 23505 follow-up select failed', existingError)
        return { status: 'error', message: 'Duplicate check-in could not be resolved' }
      }
      return { status: 'already_checked_in', existing: existing as unknown as ChildAttendanceRow }
    }
    if (insertError.code === '42501') {
      return { status: 'forbidden', message: 'Permission denied' }
    }
    if (insertError.code === '23503') {
      // FK violation — pre-flight should have caught this; log and map by constraint
      console.error('[createChildAttendance] unexpected FK violation', insertError)
      if (insertError.message.includes('child_id')) return { status: 'child_not_found' }
      return { status: 'instance_not_found' }
    }
    console.error('[createChildAttendance] insert', insertError)
    return { status: 'error', message: 'Failed to record child attendance' }
  }

  if (!inserted) {
    return { status: 'error', message: 'Failed to record child attendance' }
  }

  const attendance = inserted as unknown as ChildAttendanceRow

  // 6. Audit on success only — already_checked_in is not a state change
  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.CHILD_ATTENDANCE_CREATE,
    entityType:  'child_attendance',
    entityId:    attendance.id,
    detailsJson: {
      child_id:          input.childId,
      event_instance_id: input.eventInstanceId,
      source:            attendance.source,
    },
  }, supabase)

  return { status: 'ok', attendance }
}
