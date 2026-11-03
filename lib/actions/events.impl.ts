// No 'use server' — imported by events.ts (server actions) and by tests.
// Never import this file in Client Components.

import type { SupabaseClient } from '@supabase/supabase-js'
import { subDays, addDays } from 'date-fns'
import { expandRRule } from '@/lib/events/recurrence'
import { materializeEvents } from '@/lib/events/materialize.impl'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'
import {
  planScheduleChange,
  scheduleDiffers,
  normalizeTime,
  type PlanInstance,
  type ScheduleChangeRefusal,
  type ScheduleFields,
  type SchedulePlan,
} from '@/lib/events/schedule-change'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  EventInput,
  UpdateEventInput,
  UpdateInstanceInput,
  EventRow,
  EventInstanceRow,
  CreateEventResult,
  UpdateEventResult,
  CancelInstanceResult,
  UpdateInstanceResult,
  ListEventsFilters,
  ListEventsResult,
  ListInstancesResult,
  NearestInstanceRow,
  ListNearestResult,
  RescheduleErrorCode,
  RescheduleInstanceResult,
  UpdateEventOptions,
  ScheduleChangeInput,
  PreviewScheduleChangeResult,
} from './events.types'

const VALID_EVENT_TYPES = ['friday_monthly', 'saturday_monthly', 'sunday_monthly', 'adhoc', 'other_recurring']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/

const EVENT_FIELDS =
  'id, name, name_id, event_type, start_date, start_time, duration_min, location, description, recurrence_rule, active, schedule_note, schedule_note_id, created_by, created_at, updated_at'

// S9.5-T5.5 public schedule note — same cap as the SQL CHECK
// (char_length = code points, hence [...s].length, not s.length).
export const SCHEDULE_NOTE_MAX = 160
const SCHEDULE_NOTE_FIELDS = ['schedule_note', 'schedule_note_id'] as const

/** Trimmed note, '' → null. undefined stays undefined (field not sent). */
function normalizeNote(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

function validateNotes(input: Partial<EventInput>): { field: string; message: string } | null {
  for (const field of SCHEDULE_NOTE_FIELDS) {
    const v = normalizeNote(input[field])
    if (typeof v === 'string' && [...v].length > SCHEDULE_NOTE_MAX) {
      return { field, message: `Max ${SCHEDULE_NOTE_MAX} characters` }
    }
  }
  return null
}

/** Raised by trg_events_schedule_lock (migration 20261102120000). */
export const SCHEDULE_LOCKED_SQL_MESSAGE = 'event:schedule_locked'

const INSTANCE_FIELDS =
  'id, event_id, scheduled_at, event_name_snapshot, event_name_snapshot_id, status, notes, image_url, created_at'

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
  return validateNotes(input)
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
  return validateNotes(input)
}

// No field is updatable here today — image_url is owned by
// lib/storage/event-images (S9-P0 upload/remove actions). Any key, image_url
// included, is rejected before touching the DB.
function validateUpdateInstanceInput(
  input: UpdateInstanceInput,
): { field: string; message: string } | null {
  const [field] = Object.keys(input)
  if (field !== undefined) {
    return { field, message: 'Field is not updatable via updateInstance' }
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
      schedule_note:    normalizeNote(input.schedule_note) ?? null,
      schedule_note_id: normalizeNote(input.schedule_note_id) ?? null,
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

const SCHEDULE_KEYS = ['start_date', 'start_time', 'recurrence_rule', 'event_type'] as const

export async function impl_updateEvent({
  supabase,
  adminSupabase,
  eventId,
  input,
  options,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  eventId: string
  input: UpdateEventInput
  options?: UpdateEventOptions
}): Promise<UpdateEventResult> {
  const validationError = validateUpdateInput(input)
  if (validationError) {
    return { status: 'invalid_input', ...validationError }
  }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  // S9.5-T5.5 P2: an admin-confirmed R/A schedule change moves the upcoming
  // occurrences through apply_event_schedule_change(). The plan is always
  // re-derived here from current DB state — never taken from the client.
  // Anything that is not an applicable R/A plan falls through to the plain
  // update, where trg_events_schedule_lock decides (Phase 1 behaviour).
  if (options?.confirmScheduleChange && SCHEDULE_KEYS.some(k => input[k] !== undefined)) {
    const prep = await prepareScheduleChange({ supabase, eventId, input })
    if (prep.kind === 'refused' && prep.reason !== 'unsupported_change' && prep.reason !== 'not_admin') {
      return { status: 'schedule_change_refused', reason: prep.reason }
    }
    if (prep.kind === 'plan') {
      const applied = await applyScheduleChange({ supabase, eventId, prep })
      if (applied.status !== 'ok') return applied

      const rest: UpdateEventInput = { ...input }
      for (const k of SCHEDULE_KEYS) delete rest[k]
      if (Object.keys(rest).length === 0) {
        return { status: 'ok', event_id: eventId, schedule_change: applied.change }
      }
      const restResult = await plainUpdate({ supabase, adminSupabase, eventId, input: rest, actorId })
      if (restResult.status === 'ok') {
        return { status: 'ok', event_id: eventId, schedule_change: applied.change }
      }
      console.error('[updateEvent] schedule change applied, remaining fields failed', restResult)
      return { status: 'partial', event_id: eventId, schedule_change: applied.change }
    }
  }

  return plainUpdate({ supabase, adminSupabase, eventId, input, actorId })
}

async function plainUpdate({
  supabase,
  adminSupabase,
  eventId,
  input,
  actorId,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  eventId: string
  input: UpdateEventInput
  actorId: string
}): Promise<UpdateEventResult> {
  // Trim name in payload if provided; notes trimmed, '' → null
  const updatePayload = {
    ...input,
    ...(input.name !== undefined && { name: input.name.trim() }),
    ...(input.schedule_note !== undefined && { schedule_note: normalizeNote(input.schedule_note) }),
    ...(input.schedule_note_id !== undefined && { schedule_note_id: normalizeNote(input.schedule_note_id) }),
    updated_at: new Date().toISOString(),
  }

  const { data: rows, error: updateError } = await supabase
    .from('events')
    .update(updatePayload)
    .eq('id', eventId)
    .select('id')

  if (updateError) {
    // S9.5-T5.5: the DB trigger refuses schedule changes while upcoming
    // occurrences exist — a typed, expected refusal, not an error.
    if (updateError.message === SCHEDULE_LOCKED_SQL_MESSAGE) {
      return { status: 'schedule_locked' }
    }
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

// ── schedule change (S9.5-T5.5 P2) ───────────────────────────────────────────

type ScheduleRow = ScheduleFields & { id: string }

type PreparedScheduleChange =
  | { kind: 'not_found' }
  | { kind: 'error'; message: string }
  | { kind: 'unchanged' }
  | { kind: 'no_future_rows' }
  | { kind: 'refused'; reason: ScheduleChangeRefusal }
  | {
      kind: 'plan'
      current: ScheduleRow
      next: ScheduleFields
      plan: Extract<SchedulePlan, { status: 'ok' }>
    }

/**
 * Reads the current row, detects a schedule change by value (normalized) and,
 * when upcoming occurrences exist and the caller is an admin, plans it.
 * Read-only. Used by impl_updateEvent (commit) and impl_previewScheduleChange.
 */
async function prepareScheduleChange({
  supabase,
  eventId,
  input,
  now = new Date(),
}: {
  supabase: SupabaseClient
  eventId: string
  input: UpdateEventInput
  now?: Date
}): Promise<PreparedScheduleChange> {
  const { data: rawEvent, error: eventError } = await supabase
    .from('events')
    .select('id, start_date, start_time, recurrence_rule, event_type')
    .eq('id', eventId)
    .maybeSingle()
  if (eventError) {
    console.error('[scheduleChange] read event', eventError)
    return { kind: 'error', message: 'Failed to read event' }
  }
  if (!rawEvent) return { kind: 'not_found' }
  const current = rawEvent as ScheduleRow

  const next: ScheduleFields = {
    start_date:      input.start_date ?? current.start_date,
    start_time:      input.start_time ?? current.start_time,
    recurrence_rule: input.recurrence_rule !== undefined ? input.recurrence_rule : current.recurrence_rule,
    event_type:      input.event_type ?? current.event_type,
  }
  if (!scheduleDiffers(current, next)) return { kind: 'unchanged' }

  // Rows at or before now can never be a move target or an expected slot;
  // a one-day margin keeps the read small without touching that logic.
  const { data: rawRows, error: rowsError } = await supabase
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .gt('scheduled_at', subDays(now, 1).toISOString())
  if (rowsError) {
    console.error('[scheduleChange] read instances', rowsError)
    return { kind: 'error', message: 'Failed to read occurrences' }
  }
  const instances = (rawRows ?? []) as PlanInstance[]
  const hasFuture = instances.some(
    i => Date.parse(i.scheduled_at) > now.getTime() && (i.status === 'scheduled' || i.status === 'cancelled'),
  )
  if (!hasFuture) return { kind: 'no_future_rows' }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_admin')
  if (adminError) {
    console.error('[scheduleChange] is_admin', adminError)
    return { kind: 'error', message: 'Failed to check role' }
  }
  if (isAdmin !== true) return { kind: 'refused', reason: 'not_admin' }

  // Same source + fallback as the materializer (defaultHorizonMonths = 12).
  const { data: settings } = await supabase
    .from('app_settings')
    .select('materialization_horizon_mo')
    .limit(1)
    .maybeSingle()
  const horizonMonths =
    (settings as { materialization_horizon_mo: number | null } | null)?.materialization_horizon_mo ?? 12

  const plan = planScheduleChange({ old: current, new: next, instances, horizonMonths, now })
  if (plan.status === 'refused') return { kind: 'refused', reason: plan.reason }
  return { kind: 'plan', current, next, plan }
}

const SCHEDULE_CHANGE_SQL_CODES: Partial<Record<string, ScheduleChangeRefusal>> = {
  not_admin:          'not_admin',
  not_found:          'stale',
  stale:              'stale',
  move_invalid:       'stale',
  unsupported_change: 'unsupported_change',
  nothing_to_move:    'nothing_to_move',
  in_progress:        'in_progress',
  slot_taken:         'slot_taken',
  expected_missing:   'slots_mismatch',
  invalid_input:      'unknown',
}

export function mapScheduleChangeError(error: { code?: string; message?: string }): ScheduleChangeRefusal {
  const match = /^schedule_change:([a-z_]+)$/.exec(error.message ?? '')
  if (match) return SCHEDULE_CHANGE_SQL_CODES[match[1]] ?? 'unknown'
  if (error.code === '42501') return 'not_admin'
  return 'unknown'
}

async function applyScheduleChange({
  supabase,
  eventId,
  prep,
}: {
  supabase: SupabaseClient
  eventId: string
  prep: Extract<PreparedScheduleChange, { kind: 'plan' }>
}): Promise<
  | { status: 'ok'; change: { moved: number; cancelled_moved: number } }
  | { status: 'schedule_change_refused'; reason: ScheduleChangeRefusal }
> {
  const { current, next, plan } = prep
  const { data, error } = await supabase.rpc('apply_event_schedule_change', {
    p_event_id: eventId,
    // p_old carries the stored values verbatim (optimistic concurrency).
    p_old: {
      start_date:      current.start_date,
      start_time:      current.start_time,
      recurrence_rule: current.recurrence_rule,
      event_type:      current.event_type,
    },
    p_new: {
      start_date:      next.start_date,
      start_time:      normalizeTime(next.start_time),
      recurrence_rule: current.recurrence_rule,
      event_type:      current.event_type,
    },
    p_moves:          plan.moves.map(({ id, from_at, to_at }) => ({ id, from_at, to_at })),
    p_expected_slots: plan.expected,
  })
  if (error) {
    const reason = mapScheduleChangeError(error)
    if (reason === 'unknown') console.error('[updateEvent] apply_event_schedule_change', error)
    return { status: 'schedule_change_refused', reason }
  }
  const result = data as { moved?: unknown; cancelled_moved?: unknown } | null
  if (typeof result?.moved !== 'number' || typeof result.cancelled_moved !== 'number') {
    console.error('[updateEvent] apply_event_schedule_change returned', data)
    return { status: 'schedule_change_refused', reason: 'unknown' }
  }
  return { status: 'ok', change: { moved: result.moved, cancelled_moved: result.cancelled_moved } }
}

/**
 * EventForm confirm step: what an admin save of this date/time would do.
 * Read-only; the save re-plans from scratch (impl_updateEvent).
 */
export async function impl_previewScheduleChange({
  supabase,
  eventId,
  input,
}: {
  supabase: SupabaseClient
  eventId: string
  input: ScheduleChangeInput
}): Promise<PreviewScheduleChangeResult> {
  if (!UUID_RE.test(eventId)) return { status: 'not_found' }
  if (!DATE_RE.test(input.start_date)) return { status: 'refused', reason: 'unknown' }
  if (!HHMM_RE.test(input.start_time)) return { status: 'refused', reason: 'unknown' }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }

  const prep = await prepareScheduleChange({
    supabase,
    eventId,
    input: { start_date: input.start_date, start_time: input.start_time },
  })
  switch (prep.kind) {
    case 'not_found':      return { status: 'not_found' }
    case 'error':          return { status: 'error', message: prep.message }
    case 'unchanged':      return { status: 'unchanged' }
    case 'no_future_rows': return { status: 'no_future_rows' }
    case 'refused':        return { status: 'refused', reason: prep.reason }
    case 'plan':
      return {
        status:          'ok',
        shape:           prep.plan.shape,
        moved:           prep.plan.moved,
        cancelled_moved: prep.plan.cancelled_moved,
        to_date:         prep.next.start_date,
        to_time:         normalizeTime(prep.next.start_time).slice(0, 5),
      }
  }
}

// ── hasFutureOccurrences (S9.5-T5.5) ─────────────────────────────────────────
// Same predicate as trg_events_schedule_lock: any occurrence after now that is
// 'scheduled' or 'cancelled'. Drives the locked state of the edit form; the
// trigger stays the enforcement layer. RLS: admins and active organizers can
// SELECT event_instances. A failed read reports locked (fail closed in the UI).

export async function impl_hasFutureOccurrences({
  supabase,
  eventId,
}: {
  supabase: SupabaseClient
  eventId: string
}): Promise<boolean> {
  const { count, error } = await supabase
    .from('event_instances')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .gt('scheduled_at', new Date().toISOString())
    .in('status', ['scheduled', 'cancelled'])

  if (error) {
    console.error('[hasFutureOccurrences]', error)
    return true
  }
  return (count ?? 0) > 0
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

// ── rescheduleInstance (S9.5-T4) ─────────────────────────────────────────────
// Validates, converts the WIB date + time with toJakartaInstant (never through
// rrule), then calls public.reschedule_instance(), which does the cancel +
// one-off insert + audit row in one transaction and enforces admin-only, the
// recurring/future/horizon/slot guards. Refusals arrive as 'reschedule:<code>'.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HHMM_RE = /^\d{2}:\d{2}$/
const MAX_RESCHEDULE_REASON = 500  // same cap as the SQL guard (char_length = code points)

const RESCHEDULE_SQL_CODES: Partial<Record<string, RescheduleErrorCode>> = {
  not_admin:        'not_admin',
  invalid_input:    'invalid_instance',
  not_found:        'not_found',
  not_scheduled:    'not_scheduled',
  original_in_past: 'original_in_past',
  event_inactive:   'event_inactive',
  not_recurring:    'not_recurring',
  new_in_past:      'new_in_past',
  beyond_horizon:   'beyond_horizon',
  same_time:        'same_time',
  slot_taken:       'slot_taken',
  reason_required:  'reason_required',
  reason_too_long:  'reason_too_long',
}

export function mapRescheduleError(error: { code?: string; message?: string }): RescheduleErrorCode {
  const match = /^reschedule:([a-z_]+)$/.exec(error.message ?? '')
  if (match) return RESCHEDULE_SQL_CODES[match[1]] ?? 'unknown'
  if (error.code === '42501') return 'not_admin'
  return 'unknown'
}

export async function impl_rescheduleInstance({
  supabase,
  instanceId,
  wibDate,
  wibTime,
  reason,
}: {
  supabase: SupabaseClient
  instanceId: string
  wibDate: string
  wibTime: string
  reason: string
}): Promise<RescheduleInstanceResult> {
  if (!UUID_RE.test(instanceId)) return { status: 'error', code: 'invalid_instance' }
  if (!DATE_RE.test(wibDate)) return { status: 'error', code: 'invalid_date' }
  if (!HHMM_RE.test(wibTime)) return { status: 'error', code: 'invalid_time' }
  const trimmed = reason.trim()
  if (trimmed === '') return { status: 'error', code: 'reason_required' }
  if ([...trimmed].length > MAX_RESCHEDULE_REASON) return { status: 'error', code: 'reason_too_long' }

  let newAt: Date
  try {
    newAt = toJakartaInstant(wibDate, wibTime)
  } catch {
    return { status: 'error', code: 'invalid_date' }
  }
  // Round-trip: rejects calendar overflow (2026-02-30) and 24:00-style times
  // that date parsing would silently roll forward.
  if (formatJakarta(newAt, 'yyyy-MM-dd') !== wibDate) return { status: 'error', code: 'invalid_date' }
  if (formatJakarta(newAt, 'HH:mm') !== wibTime) return { status: 'error', code: 'invalid_time' }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', code: 'unauthenticated' }

  const { data: newId, error } = await supabase.rpc('reschedule_instance', {
    p_instance_id: instanceId,
    p_new_at:      newAt.toISOString(),
    p_reason:      trimmed,
  })

  if (error) {
    const code = mapRescheduleError(error)
    if (code === 'unknown') console.error('[rescheduleInstance] rpc', error)
    return { status: 'error', code }
  }
  if (typeof newId !== 'string') {
    console.error('[rescheduleInstance] rpc returned no id', newId)
    return { status: 'error', code: 'unknown' }
  }

  const { data: row, error: readError } = await supabase
    .from('event_instances')
    .select('event_id')
    .eq('id', newId)
    .single()
  if (readError || !row) {
    console.error('[rescheduleInstance] read new instance', readError)
    return { status: 'error', code: 'unknown' }
  }

  return { status: 'ok', instance_id: newId, event_id: (row as { event_id: string }).event_id }
}

// ── updateInstance ───────────────────────────────────────────────────────────
// Occurrence-details edit surface (T10): no fields today (image_url moved to
// lib/storage/event-images, S9-P0), structured so a future field
// (subtopics/description) is an add-a-field change here, not a redesign.
// Until then every call returns invalid_input without touching the DB.

export async function impl_updateInstance({
  supabase,
  adminSupabase,
  instanceId,
  input,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
  instanceId: string
  input: UpdateInstanceInput
}): Promise<UpdateInstanceResult> {
  const validationError = validateUpdateInstanceInput(input)
  if (validationError) {
    return { status: 'invalid_input', ...validationError }
  }

  const { data: claims } = await supabase.auth.getClaims()
  if (!claims) return { status: 'error', message: 'Not authenticated' }
  const actorId = claims.claims.sub

  const updatePayload: Record<string, unknown> = {}
  if (Object.keys(updatePayload).length === 0) {
    return { status: 'invalid_input', field: 'input', message: 'No updatable fields' }
  }

  const { data: rows, error: updateError } = await supabase
    .from('event_instances')
    .update(updatePayload)
    .eq('id', instanceId)
    .select('id')

  if (updateError) {
    console.error('[updateInstance] update', updateError)
    return { status: 'error', message: 'Failed to update instance' }
  }

  if (!rows || rows.length === 0) {
    // D4: silent block or not found — disambiguate via admin client (bypasses RLS)
    const { data: existing } = await adminSupabase
      .from('event_instances')
      .select('id')
      .eq('id', instanceId)
      .limit(1)

    if (!existing || existing.length === 0) {
      return { status: 'not_found' }
    }
    return { status: 'forbidden', message: 'Permission denied' }
  }

  await logAudit({
    actorUserId: actorId,
    action:      AUDIT_ACTIONS.EVENT_INSTANCE_UPDATE,
    entityType:  'event_instance',
    entityId:    instanceId,
    detailsJson: {
      changed_fields: Object.keys(updatePayload),
      updates:        updatePayload,
    },
  }, supabase)

  return { status: 'ok', instance_id: instanceId }
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
