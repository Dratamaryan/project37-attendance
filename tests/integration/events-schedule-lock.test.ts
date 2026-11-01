// Integration tests for S9.5-T5.5 Phase 1 — trg_events_schedule_lock +
// events.schedule_note / schedule_note_id + get_rsvp_context note fields.
//
// The trigger refuses a start_date / start_time / recurrence_rule / event_type
// change while the event has an occurrence after now() that is 'scheduled' or
// 'cancelled' — for every role (service role, admin, organizer). Everything
// else stays editable, and a no-op save (EventForm re-sending the stored values,
// time as 'HH:mm') passes.
//
// Runs against local Docker Supabase (.env.test.local); needs migration
// 20261102120000_s9_5_t5_5_schedule_lock_public_note.sql applied. The trigger
// uses the DB's real now(), so fixtures are placed relative to the real clock.
// Run: npm test -- events-schedule-lock

import { execFileSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { addDays, addMonths, subDays } from 'date-fns'
import { materializeEvents } from '@/lib/events/materialize.impl'
import { formatJakarta } from '@/lib/events/timezone'
import { impl_updateEvent, impl_hasFutureOccurrences } from '@/lib/actions/events.impl'
import { buildRRule } from '@/app/admin/events/_components/RRuleBuilder'
import type { UpdateEventInput } from '@/lib/actions/events.types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[events-schedule-lock.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This file creates users/events and runs the global materializer — ` +
      `local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

const ts = Date.now()
const NOTE_ID = '15.00 snack & kopi · 16.00 Project Day dimulai'
const NOTE_EN = '15:00 snacks & coffee · 16:00 Project Day starts'

let svc: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let anonClient: SupabaseClient
const userIds: string[] = []
const eventIds: string[] = []
let adminId: string

let lockedEventId: string        // active 2SA series with future scheduled rows (materialized)
let rawRuleEventId: string       // active other_recurring raw RRULE with future rows
let cancelledOnlyEventId: string // inactive, only future CANCELLED rows (retired-series shape)
let pastOnlyEventId: string      // inactive, only past rows (completed + scheduled)

type EventRow = {
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
  schedule_note: string | null
  schedule_note_id: string | null
}

const EVENT_COLS =
  'id, name, name_id, event_type, start_date, start_time, duration_min, location, description, recurrence_rule, active, schedule_note, schedule_note_id'

async function eventById(id: string): Promise<EventRow> {
  const { data, error } = await svc.from('events').select(EVENT_COLS).eq('id', id).single()
  if (error || !data) throw new Error(`read event ${id}: ${error?.message}`)
  return data as EventRow
}

async function insertEvent(label: string, fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc
    .from('events')
    .insert({
      name: `[SYNTH] S95T55 ${label} ${ts}`,
      name_id: `[SYNTH] S95T55 ${label} ID ${ts}`,
      start_time: '15:00:00',
      duration_min: 180,
      location: 'Test Hall',
      created_by: adminId,
      ...fields,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert event ${label}: ${error?.message}`)
  eventIds.push((data as { id: string }).id)
  return (data as { id: string }).id
}

async function insertInstance(eventId: string, at: Date, status: 'scheduled' | 'cancelled' | 'completed'): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: at.toISOString(), event_name_snapshot: `S95T55 ${ts}`, status })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert instance: ${error?.message}`)
  return (data as { id: string }).id
}

async function instanceKeys(eventId: string): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`read instances: ${error.message}`)
  return JSON.stringify(data)
}

async function makeUser(role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s95t55-${role}-${ts}@test.invalid`
  const password = `S95T55Pass-${ts}!`
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${role}: ${error?.message}`)
  userIds.push(data.user.id)
  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: data.user.id, email, full_name: `S95T55 ${role}`, role, active: true })
  if (appErr) throw new Error(`insert app_user ${role}: ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`sign-in ${role}: ${signInErr.message}`)
  return { id: data.user.id, session }
}

/** What EventForm sends on an unchanged edit save (EventForm.tsx handleSubmit). */
function formPayload(e: EventRow): UpdateEventInput {
  return {
    name: e.name.trim(),
    name_id: e.name_id?.trim() || null,
    event_type: e.event_type as UpdateEventInput['event_type'],
    start_date: e.start_date,
    start_time: e.start_time.slice(0, 5),
    duration_min: e.duration_min,
    location: e.location?.trim() || null,
    description: e.description?.trim() || null,
    recurrence_rule: buildRRule(e.event_type, e.event_type === 'other_recurring' ? (e.recurrence_rule ?? '') : ''),
    active: e.active,
    schedule_note: e.schedule_note?.trim() || null,
    schedule_note_id: e.schedule_note_id?.trim() || null,
  }
}

const SCHEDULE_CHANGES: [string, (e: EventRow) => Record<string, unknown>][] = [
  ['start_date', e => ({ start_date: formatJakarta(addDays(new Date(`${e.start_date}T00:00:00Z`), 1), 'yyyy-MM-dd') })],
  ['start_time', () => ({ start_time: '16:00' })],
  ['recurrence_rule', () => ({ recurrence_rule: 'FREQ=MONTHLY;BYDAY=3SA' })],
  ['event_type', () => ({ event_type: 'other_recurring' })],
]

beforeAll(async () => {
  svc = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await makeUser('admin')
  adminId = admin.id
  adminSession = admin.session
  organizerSession = (await makeUser('organizer')).session

  const firstOfNextMonth = formatJakarta(addMonths(new Date(), 1), 'yyyy-MM-01')
  lockedEventId = await insertEvent('Saturday', {
    event_type: 'saturday_monthly',
    start_date: firstOfNextMonth,
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
    active: true,
  })
  rawRuleEventId = await insertEvent('RawRule', {
    event_type: 'other_recurring',
    start_date: firstOfNextMonth,
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=4SA',
    active: true,
  })
  cancelledOnlyEventId = await insertEvent('CancelledOnly', {
    event_type: 'friday_monthly',
    start_date: firstOfNextMonth,
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR',
    active: false,
  })
  pastOnlyEventId = await insertEvent('PastOnly', {
    event_type: 'saturday_monthly',
    start_date: formatJakarta(subDays(new Date(), 90), 'yyyy-MM-dd'),
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA',
    active: false,
  })
  await insertInstance(cancelledOnlyEventId, addDays(new Date(), 40), 'cancelled')
  await insertInstance(cancelledOnlyEventId, subDays(new Date(), 20), 'completed')
  await insertInstance(pastOnlyEventId, subDays(new Date(), 30), 'completed')
  await insertInstance(pastOnlyEventId, subDays(new Date(), 2), 'scheduled') // past, not yet flipped

  // Warm-up: brings every active event (fixtures + local seed) up to date so
  // SL-M01 can assert instances_inserted === 0.
  await materializeEvents({ supabase: svc, now: new Date() })
  for (const id of [lockedEventId, rawRuleEventId]) {
    const n = JSON.parse(await instanceKeys(id)).length
    if (n < 6) throw new Error(`expected a materialized series for ${id}, got ${n}`)
  }
}, 60_000)

afterAll(async () => {
  // Events cascade to instances (→ RSVP links). The trigger only guards UPDATE.
  if (eventIds.length) await svc.from('events').delete().in('id', eventIds)
  if (userIds.length) {
    await svc.from('audit_log').delete().in('actor_user_id', userIds)
    await svc.from('app_users').delete().in('id', userIds)
    for (const id of userIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

// ── Trigger: SQL level (service role — the trigger fires for every role) ────

describe('trg_events_schedule_lock — blocked', () => {
  for (const [field, change] of SCHEDULE_CHANGES) {
    it(`SL-01 ${field}: future scheduled rows → event:schedule_locked (P0001), row unchanged`, async () => {
      const before = await eventById(lockedEventId)
      const { error } = await svc.from('events').update(change(before)).eq('id', lockedEventId)
      expect(error?.message).toBe('event:schedule_locked')
      expect(error?.code).toBe('P0001')
      expect(await eventById(lockedEventId)).toEqual(before)
    })

    it(`SL-02 ${field}: only future CANCELLED rows → still locked`, async () => {
      const before = await eventById(cancelledOnlyEventId)
      const { error } = await svc.from('events').update(change(before)).eq('id', cancelledOnlyEventId)
      expect(error?.message).toBe('event:schedule_locked')
      expect(await eventById(cancelledOnlyEventId)).toEqual(before)
    })
  }

  it('SL-03: two schedule fields at once (type + rule, as EventForm sends) → locked', async () => {
    const before = await eventById(lockedEventId)
    const { error } = await svc
      .from('events')
      .update({ event_type: 'sunday_monthly', recurrence_rule: 'FREQ=MONTHLY;BYDAY=1SU' })
      .eq('id', lockedEventId)
    expect(error?.message).toBe('event:schedule_locked')
    expect(await eventById(lockedEventId)).toEqual(before)
  })

  it('SL-04: postgres superuser is refused too', () => {
    expect(() =>
      psql(`UPDATE public.events SET start_time = '16:00' WHERE id = '${lockedEventId}'`),
    ).toThrow(/event:schedule_locked/)
  })
})

describe('trg_events_schedule_lock — allowed', () => {
  it('SL-05: only past rows (completed + unflipped past scheduled) → each schedule field changes', async () => {
    const before = await eventById(pastOnlyEventId)
    for (const [field, change] of SCHEDULE_CHANGES) {
      const current = await eventById(pastOnlyEventId)
      const { error } = await svc.from('events').update(change(current)).eq('id', pastOnlyEventId)
      expect(error, field).toBeNull()
    }
    const after = await eventById(pastOnlyEventId)
    expect(after.start_time).toBe('16:00:00')
    expect(after.event_type).toBe('other_recurring')
    expect(after.recurrence_rule).toBe('FREQ=MONTHLY;BYDAY=3SA')
    expect(after.start_date).not.toBe(before.start_date)
  })

  it('SL-06: non-schedule fields on a locked event → ok (duration, location, name, name_id, description, notes, active)', async () => {
    const before = await eventById(lockedEventId)
    const patch = {
      duration_min: 210,
      location: 'Test Hall 2',
      name: `${before.name} (renamed)`,
      name_id: `${before.name_id} (diganti)`,
      description: 'desc',
      schedule_note: NOTE_EN,
      schedule_note_id: NOTE_ID,
      active: false,
    }
    const { error } = await svc.from('events').update(patch).eq('id', lockedEventId)
    expect(error).toBeNull()
    expect(await eventById(lockedEventId)).toMatchObject(patch)
    // restore
    const { error: restoreErr } = await svc
      .from('events')
      .update({
        duration_min: before.duration_min,
        location: before.location,
        name: before.name,
        name_id: before.name_id,
        description: before.description,
        schedule_note: null,
        schedule_note_id: null,
        active: true,
      })
      .eq('id', lockedEventId)
    expect(restoreErr).toBeNull()
  })

  it('SL-07: re-sending identical schedule values (time as HH:mm) → ok', async () => {
    const e = await eventById(lockedEventId)
    const { error } = await svc
      .from('events')
      .update({
        start_date: e.start_date,
        start_time: e.start_time.slice(0, 5),
        recurrence_rule: e.recurrence_rule,
        event_type: e.event_type,
      })
      .eq('id', lockedEventId)
    expect(error).toBeNull()
  })
})

// ── Action layer: impl_updateEvent ───────────────────────────────────────────

describe('impl_updateEvent with the lock', () => {
  for (const role of ['admin', 'organizer'] as const) {
    it(`SL-A01 ${role}: start_time change → schedule_locked, row unchanged, no audit row`, async () => {
      const session = role === 'admin' ? adminSession : organizerSession
      const before = await eventById(lockedEventId)
      const { count: auditsBefore } = await svc
        .from('audit_log').select('*', { count: 'exact', head: true })
        .eq('action', 'event.update').eq('entity_id', lockedEventId)
      const result = await impl_updateEvent({
        supabase: session, adminSupabase: svc, eventId: lockedEventId, input: { start_time: '16:00' },
      })
      expect(result).toEqual({ status: 'schedule_locked' })
      expect(await eventById(lockedEventId)).toEqual(before)
      const { count: auditsAfter } = await svc
        .from('audit_log').select('*', { count: 'exact', head: true })
        .eq('action', 'event.update').eq('entity_id', lockedEventId)
      expect(auditsAfter).toBe(auditsBefore)
    })
  }

  it('SL-A02: unchanged EventForm save (preset type) → ok', async () => {
    const e = await eventById(lockedEventId)
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: lockedEventId, input: formPayload(e),
    })
    expect(result).toEqual({ status: 'ok', event_id: lockedEventId })
    expect(await eventById(lockedEventId)).toEqual(e)
  })

  it('SL-A03: unchanged EventForm save (other_recurring raw RRULE) → ok', async () => {
    const e = await eventById(rawRuleEventId)
    const result = await impl_updateEvent({
      supabase: organizerSession, adminSupabase: svc, eventId: rawRuleEventId, input: formPayload(e),
    })
    expect(result).toEqual({ status: 'ok', event_id: rawRuleEventId })
    expect(await eventById(rawRuleEventId)).toEqual(e)
  })

  it('SL-A04: duration change via the action → ok', async () => {
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: lockedEventId, input: { duration_min: 210 },
    })
    expect(result).toEqual({ status: 'ok', event_id: lockedEventId })
    expect((await eventById(lockedEventId)).duration_min).toBe(210)
  })

  it('SL-A05: notes set, trimmed; audit row carries them; empty string clears to null', async () => {
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: lockedEventId,
      input: { schedule_note: `  ${NOTE_EN}  `, schedule_note_id: NOTE_ID },
    })
    expect(result).toEqual({ status: 'ok', event_id: lockedEventId })
    expect(await eventById(lockedEventId)).toMatchObject({ schedule_note: NOTE_EN, schedule_note_id: NOTE_ID })

    const { data: audits } = await svc
      .from('audit_log').select('actor_user_id, details_json')
      .eq('action', 'event.update').eq('entity_id', lockedEventId)
      .order('created_at', { ascending: false }).limit(1)
    const a = (audits ?? [])[0] as { actor_user_id: string; details_json: { changed_fields: string[] } }
    expect(a.actor_user_id).toBe(adminId)
    expect(a.details_json.changed_fields.sort()).toEqual(['schedule_note', 'schedule_note_id'])

    const cleared = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: rawRuleEventId,
      input: { schedule_note: '   ', schedule_note_id: '' },
    })
    expect(cleared.status).toBe('ok')
    expect(await eventById(rawRuleEventId)).toMatchObject({ schedule_note: null, schedule_note_id: null })
  })

  it('SL-A06: 160 code points (incl. emoji) ok; 161 → invalid_input (action) and CHECK violation (DB)', async () => {
    const ok160 = '☕'.repeat(10) + 'x'.repeat(150) // 160 code points, 160 UTF-16 units too
    const emoji160 = '😀'.repeat(160)              // 160 code points, 320 UTF-16 units
    for (const note of [ok160, emoji160]) {
      const r = await impl_updateEvent({
        supabase: adminSession, adminSupabase: svc, eventId: rawRuleEventId, input: { schedule_note: note },
      })
      expect(r.status).toBe('ok')
    }
    const tooLong = 'y'.repeat(161)
    const r = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: rawRuleEventId, input: { schedule_note_id: tooLong },
    })
    expect(r).toMatchObject({ status: 'invalid_input', field: 'schedule_note_id' })
    const { error } = await svc.from('events').update({ schedule_note: tooLong }).eq('id', rawRuleEventId)
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('events_schedule_note_len')
    await svc.from('events').update({ schedule_note: null, schedule_note_id: null }).eq('id', rawRuleEventId)
  })

  it('SL-A07: impl_hasFutureOccurrences matches the trigger predicate (admin + organizer)', async () => {
    for (const session of [adminSession, organizerSession]) {
      expect(await impl_hasFutureOccurrences({ supabase: session, eventId: lockedEventId })).toBe(true)
      expect(await impl_hasFutureOccurrences({ supabase: session, eventId: cancelledOnlyEventId })).toBe(true)
      expect(await impl_hasFutureOccurrences({ supabase: session, eventId: pastOnlyEventId })).toBe(false)
    }
  })
})

// ── get_rsvp_context + anon surface ──────────────────────────────────────────

describe('get_rsvp_context schedule note', () => {
  it('SL-R01: open link returns schedule_note / schedule_note_id read live from events', async () => {
    const { data: inst } = await svc
      .from('event_instances').select('id')
      .eq('event_id', lockedEventId).eq('status', 'scheduled')
      .gt('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true }).limit(1).single()
    const { data: link, error: linkErr } = await svc
      .from('event_rsvp_links')
      .insert({ event_instance_id: (inst as { id: string }).id, is_active: true, created_by: adminId })
      .select('token').single()
    expect(linkErr).toBeNull()
    const token = (link as { token: string }).token

    await svc.from('events').update({ schedule_note: NOTE_EN, schedule_note_id: NOTE_ID }).eq('id', lockedEventId)
    const { data, error } = await anonClient.rpc('get_rsvp_context', { p_token: token })
    expect(error).toBeNull()
    expect(data).toMatchObject({ open: true, schedule_note: NOTE_EN, schedule_note_id: NOTE_ID })

    await svc.from('events').update({ schedule_note: null, schedule_note_id: NOTE_ID }).eq('id', lockedEventId)
    const { data: d2 } = await anonClient.rpc('get_rsvp_context', { p_token: token })
    expect(d2).toMatchObject({ schedule_note: null, schedule_note_id: NOTE_ID })
  })

  it('SL-R02: anon reads nothing new — no rows from events, no EXECUTE on the trigger function', async () => {
    const { data } = await anonClient.from('events').select('id, schedule_note, schedule_note_id').eq('id', lockedEventId)
    expect(data ?? []).toEqual([])
    expect(psql(`SELECT has_function_privilege('anon', 'public.events_schedule_lock()', 'EXECUTE')`)).toBe('f')
    expect(psql(`SELECT has_function_privilege('authenticated', 'public.events_schedule_lock()', 'EXECUTE')`)).toBe('f')
    expect(psql(
      `SELECT array_to_string(array_agg(r ORDER BY r), ',') FROM unnest(ARRAY['anon','authenticated','service_role']) r ` +
      `WHERE has_function_privilege(r, 'public.get_rsvp_context(text)', 'EXECUTE')`,
    )).toBe('anon')
  })

  it('SL-R03: trigger is BEFORE UPDATE FOR EACH ROW on events, function SECURITY DEFINER with pinned search_path', () => {
    expect(psql(
      `SELECT tgenabled::text || ':' || (tgtype & 2 = 2)::text || ':' || (tgtype & 16 = 16)::text || ':' || (tgtype & 1 = 1)::text ` +
      `FROM pg_trigger WHERE tgname = 'trg_events_schedule_lock' AND tgrelid = 'public.events'::regclass`,
    )).toBe('O:true:true:true') // enabled : BEFORE : UPDATE : ROW
    expect(psql(
      `SELECT prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = 'public.events_schedule_lock()'::regprocedure`,
    )).toBe('true:search_path=public, pg_temp')
  })
})

// ── Materializer unaffected ──────────────────────────────────────────────────

describe('materializer with notes + lock', () => {
  it('SL-M01: after note/duration edits, a run inserts 0 and leaves the series unchanged', async () => {
    const before = await instanceKeys(lockedEventId)
    const result = await materializeEvents({ supabase: svc, now: new Date() })
    expect(result.events_with_errors).toEqual([])
    expect(result.instances_inserted).toBe(0)
    expect(await instanceKeys(lockedEventId)).toBe(before)
  })
})
