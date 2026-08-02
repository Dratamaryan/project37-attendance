// No 'use server' — imported by events.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { subDays, addDays } from 'date-fns'
import { expandRRule } from '@/lib/events/recurrence'
import { materializeEvents } from '@/lib/events/materialize.impl'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  EventInput,
  UpdateEventInput,
  EventRow,
  EventInstanceRow,
  CreateEventResult,
  UpdateEventResult,
  CancelInstanceResult,
  ListEventsFilters,
  ListEventsResult,
  ListInstancesResult,
  NearestInstanceRow,
  ListNearestResult,
} from './events.types'

const VALID_EVENT_TYPES = ['friday_monthly', 'sunday_monthly', 'adhoc', 'other_recurring']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

const EVENT_FIELDS =
  'id, name, name_id, event_type, start_date, start_time, duration_min, location, description, recurrence_rule, active, created_by, created_at, updated_at'

const INSTANCE_FIELDS =
  'id, event_id, scheduled_at, event_name_snapshot, event_name_snapshot_id, status, notes, created_at'

// ── validation helpers ────────────────────────────────────────────────────────

function validateCreateInput(input: EventInput): { field: string; message: string } | null {
  if (!input.name?.trim()) {
    return { field: 'name', message: 'Name is required' }
  }
  if (!VALID_EVENT_TYPES.includes(input.event_type)) {
    return { field: 'event_type', message: 'Invalid event type' }
  }
  if (!input.start_date || !DATE_RE.test(input.start_date)) {
    return { field: 'start_date', message: 'Invalid date format (YYYY-MM-DD)' }
  }
  if (!input.start_time || !TIME_RE.test(input.start_time)) {
    return { field: 'start_time', message: 'Invalid time format (HH:mm)' }
  }
  // Validate recurrence_rule via dry expand (D7) — skipped for null/adhoc
  if (input.recurrence_rule) {
    const expandResult = expandRRule({
      recurrenceRule: input.recurrence_rule,
      startDate: input.start_date,
      startTime: input.start_time,
      horizonMonths: 1,
    })
    if (expandResult.status === 'invalid_rrule') {
      return { field: 'recurrence_rule', message: expandResult.message }
    }
  }
  return null
}

function validateUpdateInput(input: UpdateEventInput): { field: string; message: string } | null {
  if ('name' in input && input.name !== undefined && !input.name.trim()) {
    return { field: 'name', message: 'Name is required' }
  }
  if ('event_type' in input && input.event_type !== undefined) {
    if (!VALID_EVENT_TYPES.includes(input.event_type)) {
      return { field: 'event_type', message: 'Invalid event type' }
    }
  }
  if ('start_date' in input && input.start_date !== undefined) {
    if (!DATE_RE.test(input.start_date)) {
      return { field: 'start_date', message: 'Invalid date format (YYYY-MM-DD)' }
    }
  }
  if ('start_time' in input && input.start_time !== undefined) {
    if (!TIME_RE.test(input.start_time)) {
      return { field: 'start_time', message: 'Invalid time format (HH:mm)' }
    }
  }
  // RRULE string validation — only requires parsing, not start_date/start_time context
  if ('recurrence_rule' in input && input.recurrence_rule) {
    const rruleCheck = expandRRule({
      recurrenceRule: input.recurrence_rule,
      startDate: '2026-01-01',
      startTime: '00:00',
      horizonMonths: 1,
    })
    if (rruleCheck.status === 'invalid_rrule') {
      return { field: 'recurrence_rule', message: rruleCheck.message }
    }
  }
  return null
}

// ── createEvent ──────────────────────────────────────────────────────────────

export async function impl_createEvent({
  supabase,
  adminSupabase,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  input: EventInput
}): Promise<CreateEventResult> {
  const validationError = validateCreateInput(input)
  if (validationError) {
    return { status: 'invalid_input', ...validationError }
  }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  const { data: rows, error: insertError } = await supabase
    .from('events')
    .insert({
      name:            input.name.trim(),
      name_id:         input.name_id ?? null,
      event_type:      input.event_type,
      start_date:      input.start_date,
      start_time:      input.start_time,
      duration_min:    input.duration_min ?? 120,
      location:        input.location ?? null,
      description:     input.description ?? null,
      recurrence_rule: input.recurrence_rule ?? null,
      active:          input.active ?? true,
      created_by:      actorId,
      updated_at:      new Date().toISOString(),
    })
    .select('id')

  if (insertError) {
    if (insertError.code === '42501') {
      return { status: 'forbidden', message: 'Permission denied' }
    }
    console.error('[createEvent] insert', insertError)
    return { status: 'error', message: 'Failed to create event' }
  }

  if (!rows || rows.length === 0) {
    return { status: 'error', message: 'Failed to create event' }
  }

  const newEventId = (rows as { id: string }[])[0].id

  // Materialize instances immediately via admin client (D2: organizer cannot INSERT event_instances)
  // If materialize fails, event is still created — cron will handle it next run.
  let instancesCreated = 0
  try {
    await materializeEvents({ supabase: adminSupabase, now: new Date() })
    // D8: follow-up SELECT to count instances for this specific event
    const { count } = await adminSupabase
      .from('event_instances')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', newEventId)
    instancesCreated = count ?? 0
  } catch (e) {
    console.error('[createEvent] materialize failed — cron will retry', e)
  }

  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.EVENT_CREATE,
    entityType:  'event',
    entityId:    newEventId,
    detailsJson: {
      name:              input.name.trim(),
      event_type:        input.event_type,
      start_date:        input.start_date,
      recurrence_rule:   input.recurrence_rule ?? null,
      instances_created: instancesCreated,
    },
  }, supabase)

  return { status: 'ok', event_id: newEventId, instances_created: instancesCreated }
}

// ── updateEvent ──────────────────────────────────────────────────────────────

export async function impl_updateEvent({
  supabase,
  adminSupabase,
  eventId,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  eventId: string
  input: UpdateEventInput
}): Promise<UpdateEventResult> {
  const validationError = validateUpdateInput(input)
  if (validationError) {
    return { status: 'invalid_input', ...validationError }
  }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  // Trim name in payload if provided
  const updatePayload = {
    ...input,
    ...(input.name !== undefined && { name: input.name.trim() }),
    updated_at: new Date().toISOString(),
  }

  const { data: rows, error: updateError } = await supabase
    .from('events')
    .update(updatePayload)
    .eq('id', eventId)
    .select('id')

  if (updateError) {
    console.error('[updateEvent] update', updateError)
    return { status: 'error', message: 'Failed to update event' }
  }

  if (!rows || rows.length === 0) {
    // D4: silent block or not found — disambiguate via admin client (bypasses RLS)
    const { data: existing } = await adminSupabase
      .from('events')
      .select('id')
      .eq('id', eventId)
      .limit(1)

    if (!existing || existing.length === 0) {
      return { status: 'not_found' }
    }
    return { status: 'forbidden', message: 'Permission denied' }
  }

  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.EVENT_UPDATE,
    entityType:  'event',
    entityId:    eventId,
    detailsJson: {
      changed_fields: Object.keys(input),
      updates:        input as Record<string, unknown>,
    },
  }, supabase)

  return { status: 'ok', event_id: eventId }
}

// ── cancelInstance ────────────────────────────────────────────────────────────

export async function impl_cancelInstance({
  supabase,
  adminSupabase,
  instanceId,
  reason,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  instanceId: string
  reason?: string
}): Promise<CancelInstanceResult> {
  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  const updatePayload: Record<string, unknown> = { status: 'cancelled' }
  if (reason !== undefined) {
    updatePayload.notes = reason
  }

  const { data: rows, error: updateError } = await supabase
    .from('event_instances')
    .update(updatePayload)
    .eq('id', instanceId)
    .eq('status', 'scheduled')
    .select('id')

  if (updateError) {
    console.error('[cancelInstance] update', updateError)
    return { status: 'error', message: 'Failed to cancel instance' }
  }

  if (rows && rows.length > 0) {
    await logAudit({
      actorUserId: actorId,
      action:      AUDIT_ACTIONS.EVENT_INSTANCE_CANCEL,
      entityType:  'event_instance',
      entityId:    instanceId,
      detailsJson: { reason: reason ?? null },
    }, supabase)

    return { status: 'ok', instance_id: instanceId }
  }

  // D4: 0 rows — disambiguate via admin client (bypasses RLS)
  const { data: instanceRows } = await adminSupabase
    .from('event_instances')
    .select('id, status')
    .eq('id', instanceId)
    .limit(1)

  if (!instanceRows || instanceRows.length === 0) {
    return { status: 'not_found' }
  }

  const inst = instanceRows[0] as { id: string; status: string }
  if (inst.status === 'cancelled') {
    return { status: 'already_cancelled' }
  }
  if (inst.status !== 'scheduled') {
    // 'completed' (or any other non-scheduled, non-cancelled state) — a state/
    // business-rule denial, distinct from an RLS/permission denial below.
    return { status: 'not_cancellable', current_status: inst.status }
  }

  // Found scheduled but UPDATE returned 0 rows → RLS blocked organizer
  return { status: 'forbidden', message: 'Permission denied' }
}

// ── listEvents ────────────────────────────────────────────────────────────────

export async function impl_listEvents({
  supabase,
  filters,
}: {
  supabase: SupabaseClient
  filters?: ListEventsFilters
}): Promise<ListEventsResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from('events')
    .select(EVENT_FIELDS)
    .order('start_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (filters?.active !== undefined) {
    query = query.eq('active', filters.active)
  }
  if (filters?.event_type) {
    query = query.eq('event_type', filters.event_type)
  }

  const { data, error } = await query

  if (error) {
    console.error('[listEvents]', error)
    return { status: 'error', message: 'Failed to list events' }
  }

  return { status: 'ok', events: (data ?? []) as EventRow[] }
}

// ── listNearestInstances ──────────────────────────────────────────────────────

export async function impl_listNearestInstances({
  supabase,
  limit = 5,
  windowDays = 30,
}: {
  supabase: SupabaseClient
  limit?: number
  windowDays?: number
}): Promise<ListNearestResult> {
  const now = new Date()
  const from = subDays(now, 1)
  const to = addDays(now, windowDays)

  // Step 1: Get IDs of active events
  const { data: activeEvents, error: eventsError } = await supabase
    .from('events')
    .select('id')
    .eq('active', true)

  if (eventsError) {
    console.error('[listNearestInstances] events query', eventsError)
    return { status: 'error', message: 'Failed to list instances' }
  }

  const activeEventIds = (activeEvents ?? []).map((e: { id: string }) => e.id)
  if (activeEventIds.length === 0) {
    return { status: 'ok', instances: [] }
  }

  // Step 2: Get scheduled instances within the time window for active events
  const { data, error } = await supabase
    .from('event_instances')
    .select('id, event_id, scheduled_at, status, event_name_snapshot, event_name_snapshot_id')
    .eq('status', 'scheduled')
    .in('event_id', activeEventIds)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())

  if (error) {
    console.error('[listNearestInstances] instances query', error)
    return { status: 'error', message: 'Failed to list instances' }
  }

  const rows = (data ?? []) as NearestInstanceRow[]
  const nowMs = now.getTime()

  // Sort nearest-first by absolute time difference from now
  rows.sort((a, b) => {
    const aDiff = Math.abs(new Date(a.scheduled_at).getTime() - nowMs)
    const bDiff = Math.abs(new Date(b.scheduled_at).getTime() - nowMs)
    return aDiff - bDiff
  })

  return { status: 'ok', instances: rows.slice(0, limit) }
}

// ── listInstancesForEvent ─────────────────────────────────────────────────────

export async function impl_listInstancesForEvent({
  supabase,
  eventId,
  range,
}: {
  supabase: SupabaseClient
  eventId: string
  range?: { from: Date; to: Date }
}): Promise<ListInstancesResult> {
  // D6: default range [now - 30d, now + 90d]; T10 UI may pass a custom range
  const now = new Date()
  const from = range?.from ?? subDays(now, 30)
  const to = range?.to ?? addDays(now, 90)

  const { data, error } = await supabase
    .from('event_instances')
    .select(INSTANCE_FIELDS)
    .eq('event_id', eventId)
    .gte('scheduled_at', from.toISOString())
    .lte('scheduled_at', to.toISOString())
    .order('scheduled_at', { ascending: true })

  if (error) {
    console.error('[listInstancesForEvent]', error)
    return { status: 'error', message: 'Failed to list instances' }
  }

  return { status: 'ok', instances: (data ?? []) as EventInstanceRow[] }
}
