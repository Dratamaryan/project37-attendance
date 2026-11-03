// Integration tests for S9.5-T5.5 Phase 2 — schedule-edit propagation:
// public.apply_event_schedule_change() + the flag-aware
// trg_events_schedule_lock + impl_updateEvent / impl_previewScheduleChange.
//
//   R  recurring: start_time only → future rows on old rule slots move to the
//      same WIB date at the new time (ids unchanged).
//   A  adhoc: start_date and/or start_time → its future row moves.
//
// Runs against local Docker Supabase (.env.test.local); needs migration
// 20261103120000_s9_5_t5_5_p2_schedule_change.sql applied. The trigger and the
// function use the DB's real now(), so fixtures sit relative to the real clock.
// Run: npm test -- event-schedule-change

import { execFileSync, spawn } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { addDays, addMinutes, addMonths, subDays, subMinutes } from 'date-fns'
import { materializeEvents } from '@/lib/events/materialize.impl'
import { expandRRule } from '@/lib/events/recurrence'
import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'
import { impl_updateEvent, impl_previewScheduleChange } from '@/lib/actions/events.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
const STAGING_PROJECT_REF = 'sijfyvaodqkawbeuyrpu'
if (url.includes(PROD_PROJECT_REF) || url.includes(STAGING_PROJECT_REF)) {
  throw new Error(
    `[event-schedule-change.test.ts] NEXT_PUBLIC_SUPABASE_URL is a hosted project. ` +
      `This file creates users/events and runs the global materializer — local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'

/** Each argument is sent as its own -c, i.e. its own transaction, in ONE session. */
function psql(...sqls: string[]): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', ...sqls.flatMap(s => ['-c', s])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

const ts = Date.now()
const HORIZON = 12
const FN = 'apply_event_schedule_change'

let svc: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let anonClient: SupabaseClient
let adminId: string
const userIds: string[] = []
const eventIds: string[] = []

type Inst = { id: string; scheduled_at: string; status: string }
type EventRow = {
  id: string
  event_type: string
  start_date: string
  start_time: string
  recurrence_rule: string | null
  active: boolean
  updated_at: string
}

const wib = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd HH:mm')
const wibDate = (iso: string) => formatJakarta(new Date(iso), 'yyyy-MM-dd')
const iso = (d: Date) => d.toISOString()

async function eventById(id: string): Promise<EventRow> {
  const { data, error } = await svc
    .from('events')
    .select('id, event_type, start_date, start_time, recurrence_rule, active, updated_at')
    .eq('id', id)
    .single()
  if (error || !data) throw new Error(`read event ${id}: ${error?.message}`)
  return data as EventRow
}

async function instances(eventId: string): Promise<Inst[]> {
  const { data, error } = await svc
    .from('event_instances')
    .select('id, scheduled_at, status')
    .eq('event_id', eventId)
    .order('scheduled_at', { ascending: true })
  if (error) throw new Error(`read instances: ${error.message}`)
  return (data ?? []).map(r => ({ ...(r as Inst), scheduled_at: new Date((r as Inst).scheduled_at).toISOString() }))
}

const future = (rows: Inst[]) =>
  rows.filter(r => Date.parse(r.scheduled_at) > Date.now() && (r.status === 'scheduled' || r.status === 'cancelled'))

async function insertEvent(label: string, fields: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc
    .from('events')
    .insert({
      name: `[SYNTH] S95T55P2 ${label} ${ts}`,
      name_id: `[SYNTH] S95T55P2 ${label} ID ${ts}`,
      start_time: '15:00:00',
      duration_min: 180,
      location: 'Test Hall',
      created_by: adminId,
      active: true,
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
    .insert({ event_id: eventId, scheduled_at: at.toISOString(), event_name_snapshot: `S95T55P2 ${ts}`, status })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert instance: ${error?.message}`)
  return (data as { id: string }).id
}

async function makeUser(role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s95t55p2-${role}-${ts}@test.invalid`
  const password = `S95T55P2Pass-${ts}!`
  const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${role}: ${error?.message}`)
  userIds.push(data.user.id)
  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: data.user.id, email, full_name: `S95T55P2 ${role}`, role, active: true })
  if (appErr) throw new Error(`insert app_user ${role}: ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password })
  if (signInErr) throw new Error(`sign-in ${role}: ${signInErr.message}`)
  return { id: data.user.id, session }
}

async function auditRows(eventId: string, action = 'event.schedule_change') {
  const { data, error } = await svc
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json')
    .eq('action', action)
    .eq('entity_id', eventId)
    .order('id', { ascending: true })
  if (error) throw new Error(`audit read: ${error.message}`)
  return (data ?? []) as {
    id: number
    actor_user_id: string | null
    action: string
    entity_type: string
    entity_id: string
    details_json: {
      old: Record<string, unknown>
      new: Record<string, unknown>
      moves: { id: string; from: string; to: string; status: string }[]
      expected_count: number
    }
  }[]
}

/** The NEW rule's slots exactly as the materializer computes them. */
function expectedSlots(e: { recurrence_rule: string | null; start_date: string }, time: string): string[] {
  const r = expandRRule({ recurrenceRule: e.recurrence_rule, startDate: e.start_date, startTime: time, horizonMonths: HORIZON, now: new Date() })
  if (r.status !== 'ok') throw new Error('expand failed')
  return r.occurrences.map(iso)
}

/** Whole-event snapshot used for "nothing changed" assertions. */
async function snapshot(eventId: string) {
  return { event: await eventById(eventId), rows: await instances(eventId) }
}

async function materializeTwiceZero(eventId: string) {
  for (let i = 0; i < 2; i++) {
    const before = JSON.stringify(await instances(eventId))
    const result = await materializeEvents({ supabase: svc, now: new Date() })
    expect(result.events_with_errors).toEqual([])
    expect(result.instances_inserted).toBe(0)
    expect(JSON.stringify(await instances(eventId))).toBe(before)
  }
}

let rEventId: string         // R happy path: 2SA 15:00, one cancelled, RSVP link + RSVP, T4 one-off
let rOneOffId: string        // scheduled one-off at 15:00 on a non-rule date (T4 shape)
let rLinkToken: string
let rLinkInstanceId: string
let rCancelledId: string
let takenEventId: string     // one-off sits exactly on a new 16:00 target
let early15EventId: string   // 2SA 15:00 → new 06:00
let early06EventId: string   // 2SA 06:00 (drifted rows) → new 15:00
let inactiveEventId: string  // materialized, then deactivated
let adhocEventId: string     // adhoc with one future row
let adhocPastEventId: string // adhoc with only a past row
let guardEventId: string     // SQL-level guards (stale, shapes, flag, roles)
let raceEventId: string      // function + materializer interleaving

beforeAll(async () => {
  svc = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await makeUser('admin')
  adminId = admin.id
  adminSession = admin.session
  organizerSession = (await makeUser('organizer')).session

  // Start a few months back so the series fills the whole 12-month window.
  const seriesStart = formatJakarta(subDays(new Date(), 120), 'yyyy-MM-01')
  const twoSA = { event_type: 'saturday_monthly', start_date: seriesStart, recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA' }

  rEventId        = await insertEvent('R', twoSA)
  takenEventId    = await insertEvent('Taken', twoSA)
  early15EventId  = await insertEvent('Early15', twoSA)
  early06EventId  = await insertEvent('Early06', { ...twoSA, start_time: '06:00:00' })
  inactiveEventId = await insertEvent('Inactive', twoSA)
  guardEventId    = await insertEvent('Guard', twoSA)
  raceEventId     = await insertEvent('Race', twoSA)
  const adhocDate = formatJakarta(addDays(new Date(), 10), 'yyyy-MM-dd')
  adhocEventId    = await insertEvent('Adhoc', { event_type: 'adhoc', start_date: adhocDate, recurrence_rule: null })
  adhocPastEventId = await insertEvent('AdhocPast', {
    event_type: 'adhoc', start_date: formatJakarta(subDays(new Date(), 10), 'yyyy-MM-dd'), recurrence_rule: null, active: false,
  })
  await insertInstance(adhocPastEventId, toJakartaInstant(formatJakarta(subDays(new Date(), 10), 'yyyy-MM-dd'), '15:00'), 'completed')

  // Warm-up: brings every active event (fixtures + local seed) up to date.
  const warm = await materializeEvents({ supabase: svc, now: new Date() })
  if (warm.events_with_errors.length || warm.events_skipped.length) {
    throw new Error(`warm-up: ${JSON.stringify({ errors: warm.events_with_errors, skipped: warm.events_skipped })}`)
  }

  // R fixture extras: one cancelled future row, an RSVP link + RSVP on another,
  // and a T4-style one-off at 15:00 on a non-rule date (2SA + 7 days).
  const rRows = future(await instances(rEventId))
  if (rRows.length < 11) throw new Error(`expected a materialized R series, got ${rRows.length}`)
  rCancelledId = rRows[3].id
  await svc.from('event_instances').update({ status: 'cancelled', notes: 'S95T55P2 cancelled' }).eq('id', rCancelledId)
  rLinkInstanceId = rRows[1].id
  const { data: link, error: linkErr } = await svc
    .from('event_rsvp_links')
    .insert({ event_instance_id: rLinkInstanceId, is_active: true, created_by: adminId })
    .select('id, token')
    .single()
  if (linkErr || !link) throw new Error(`insert link: ${linkErr?.message}`)
  rLinkToken = (link as { token: string }).token
  const { error: rsvpErr } = await svc.from('event_rsvps').insert({
    event_instance_id: rLinkInstanceId,
    link_id: (link as { id: string }).id,
    phone_e164: '+6299955500001',
    name: '[SYNTH] S95T55P2 RSVP',
    status: 'coming',
  })
  if (rsvpErr) throw new Error(`insert rsvp: ${rsvpErr.message}`)
  rOneOffId = await insertInstance(rEventId, addDays(new Date(rRows[2].scheduled_at), 7), 'scheduled')

  // Taken fixture: a one-off exactly where a 15:00 row would move (16:00, same date).
  const takenRows = future(await instances(takenEventId))
  await insertInstance(takenEventId, addMinutes(new Date(takenRows[4].scheduled_at), 60), 'scheduled')

  // Inactive fixture: materialized while active, then deactivated (non-schedule field).
  const { error: deactErr } = await svc.from('events').update({ active: false }).eq('id', inactiveEventId)
  if (deactErr) throw new Error(`deactivate: ${deactErr.message}`)
}, 120_000)

afterAll(async () => {
  // event_rsvps.link_id has no cascade — delete RSVPs before the event cascade.
  if (eventIds.length) {
    const { data: inst } = await svc.from('event_instances').select('id').in('event_id', eventIds)
    const ids = (inst ?? []).map(r => (r as { id: string }).id)
    if (ids.length) await svc.from('event_rsvps').delete().in('event_instance_id', ids)
    await svc.from('events').delete().in('id', eventIds)
  }
  if (userIds.length) {
    await svc.from('audit_log').delete().in('actor_user_id', userIds)
    await svc.from('app_users').delete().in('id', userIds)
    for (const id of userIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

// ── R: recurring start_time ──────────────────────────────────────────────────

describe('R — recurring start_time change', () => {
  it('SC-R01 happy path: scheduled + cancelled rows move 15:00→16:00, ids/RSVP stable, materializer 0 ×2, audit shape', async () => {
    const beforeRows = await instances(rEventId)
    const beforeFuture = future(beforeRows)
    const ruleRows = beforeFuture.filter(r => r.id !== rOneOffId)
    const nScheduled = ruleRows.filter(r => r.status === 'scheduled').length
    const nCancelled = ruleRows.filter(r => r.status === 'cancelled').length
    expect(nCancelled).toBe(1)
    console.log(`[SC-R01] moving ${nScheduled} scheduled + ${nCancelled} cancelled; one-off stays`)

    const preview = await impl_previewScheduleChange({
      supabase: adminSession, eventId: rEventId,
      input: { start_date: (await eventById(rEventId)).start_date, start_time: '16:00' },
    })
    expect(preview).toEqual({
      status: 'ok', shape: 'R', moved: nScheduled + nCancelled, cancelled_moved: 1,
      to_date: (await eventById(rEventId)).start_date, to_time: '16:00',
    })

    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: rEventId,
      input: { start_time: '16:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({
      status: 'ok', event_id: rEventId, schedule_change: { moved: nScheduled + nCancelled, cancelled_moved: 1 },
    })

    const after = await instances(rEventId)
    expect((await eventById(rEventId)).start_time).toBe('16:00:00')
    // Same ids, same count, same statuses; rule rows now at 16:00 on the same WIB date.
    expect(after.map(r => r.id).sort()).toEqual(beforeRows.map(r => r.id).sort())
    for (const b of ruleRows) {
      const a = after.find(r => r.id === b.id)!
      expect(a.status).toBe(b.status)
      expect(wibDate(a.scheduled_at)).toBe(wibDate(b.scheduled_at))
      expect(wib(a.scheduled_at).slice(11)).toBe('16:00')
    }
    // T4 one-off on a non-rule date at the old time: NOT moved.
    const oneOff = after.find(r => r.id === rOneOffId)!
    expect(oneOff.scheduled_at).toBe(beforeRows.find(r => r.id === rOneOffId)!.scheduled_at)
    expect(wib(oneOff.scheduled_at).slice(11)).toBe('15:00')

    // RSVP link + RSVP still attached to the same instance id; public context shows the new time.
    const { data: link } = await svc.from('event_rsvp_links').select('event_instance_id, is_active').eq('token', rLinkToken).single()
    expect(link).toEqual({ event_instance_id: rLinkInstanceId, is_active: true })
    const { count: rsvpCount } = await svc.from('event_rsvps').select('*', { count: 'exact', head: true }).eq('event_instance_id', rLinkInstanceId)
    expect(rsvpCount).toBe(1)
    const { data: ctx } = await anonClient.rpc('get_rsvp_context', { p_token: rLinkToken })
    expect(ctx).toMatchObject({ open: true })
    expect(wib((ctx as { scheduled_at: string }).scheduled_at).slice(11)).toBe('16:00')

    await materializeTwiceZero(rEventId)

    const audits = await auditRows(rEventId)
    expect(audits).toHaveLength(1)
    const a = audits[0]
    expect(a.actor_user_id).toBe(adminId)
    expect(a.entity_type).toBe('event')
    expect(a.details_json.old).toEqual({
      start_date: (await eventById(rEventId)).start_date, start_time: '15:00:00',
      recurrence_rule: 'FREQ=MONTHLY;BYDAY=2SA', event_type: 'saturday_monthly',
    })
    expect(a.details_json.new).toMatchObject({ start_time: '16:00:00' })
    expect(a.details_json.moves).toHaveLength(nScheduled + nCancelled)
    expect(a.details_json.moves.filter(m => m.status === 'cancelled').map(m => m.id)).toEqual([rCancelledId])
    expect(a.details_json.expected_count).toBe(expectedSlots(await eventById(rEventId), '16:00').length)
    // No event.update audit row from this save (schedule fields only).
    expect(await auditRows(rEventId, 'event.update')).toHaveLength(0)
  })

  it('SC-R02 and back 16:00→15:00 with a non-schedule field in the same save: both applied, ids stable, materializer 0', async () => {
    const beforeIds = (await instances(rEventId)).map(r => r.id).sort()
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: rEventId,
      input: { start_time: '15:00', duration_min: 200 }, options: { confirmScheduleChange: true },
    })
    expect(result.status).toBe('ok')
    const e = await eventById(rEventId)
    expect(e.start_time).toBe('15:00:00')
    const { data: d } = await svc.from('events').select('duration_min').eq('id', rEventId).single()
    expect((d as { duration_min: number }).duration_min).toBe(200)
    const after = await instances(rEventId)
    expect(after.map(r => r.id).sort()).toEqual(beforeIds)
    expect(future(after).every(r => wib(r.scheduled_at).slice(11) === '15:00')).toBe(true)
    await materializeTwiceZero(rEventId)
    expect(await auditRows(rEventId, 'event.update')).toHaveLength(1)
  })

  it('SC-R03 without confirmScheduleChange the Phase 1 lock still answers (schedule_locked, nothing changed)', async () => {
    const before = await snapshot(rEventId)
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: rEventId, input: { start_time: '17:00' },
    })
    expect(result).toEqual({ status: 'schedule_locked' })
    expect(await snapshot(rEventId)).toEqual(before)
  })

  it('SC-R04 one-off exactly on a new target → slot_taken (preview + save), nothing changed', async () => {
    const before = await snapshot(takenEventId)
    const preview = await impl_previewScheduleChange({
      supabase: adminSession, eventId: takenEventId, input: { start_date: before.event.start_date, start_time: '16:00' },
    })
    expect(preview).toEqual({ status: 'refused', reason: 'slot_taken' })
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: takenEventId,
      input: { start_time: '16:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_change_refused', reason: 'slot_taken' })
    expect(await snapshot(takenEventId)).toEqual(before)
    expect(await auditRows(takenEventId)).toHaveLength(0)
  })

  it('SC-R05 SQL: the same collision passed straight to the function → slot_taken, full rollback', async () => {
    const before = await snapshot(takenEventId)
    const fut = future(before.rows)
    // Every rule row (exclude the 16:00 one-off) → same date 16:00.
    const ruleRows = fut.filter(r => wib(r.scheduled_at).slice(11) === '15:00')
    const moves = ruleRows.map(r => ({
      id: r.id, from_at: r.scheduled_at, to_at: iso(addMinutes(new Date(r.scheduled_at), 60)),
    }))
    const { error } = await adminSession.rpc(FN, {
      p_event_id: takenEventId,
      p_old: { start_date: before.event.start_date, start_time: '15:00:00', recurrence_rule: before.event.recurrence_rule, event_type: before.event.event_type },
      p_new: { start_date: before.event.start_date, start_time: '16:00:00', recurrence_rule: before.event.recurrence_rule, event_type: before.event.event_type },
      p_moves: moves,
      p_expected_slots: expectedSlots(before.event, '16:00'),
    })
    expect(error?.message).toBe('schedule_change:slot_taken')
    expect(await snapshot(takenEventId)).toEqual(before)
  })

  it('SC-R06 pre-07:00 NEW time (15:00→06:00) → early_time, nothing changed', async () => {
    const before = await snapshot(early15EventId)
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: early15EventId,
      input: { start_time: '06:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_change_refused', reason: 'early_time' })
    expect(await snapshot(early15EventId)).toEqual(before)
  })

  it('SC-R07 pre-07:00 OLD time (06:00 drifted rows → 15:00) → early_time, nothing changed', async () => {
    const before = await snapshot(early06EventId)
    // The drift itself: 2SA at 06:00 WIB materializes on Sundays (BYDAY is evaluated in UTC).
    const days = new Set(future(before.rows).map(r => formatJakarta(new Date(r.scheduled_at), 'EEE')))
    expect([...days]).toEqual(['Sun'])
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: early06EventId,
      input: { start_time: '15:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_change_refused', reason: 'early_time' })
    expect(await snapshot(early06EventId)).toEqual(before)
  })

  it('SC-R08 SQL: pre-07:00 plan forced past the TS pre-flight → expected_missing, full rollback', async () => {
    const before = await snapshot(early15EventId)
    const moves = future(before.rows).map(r => ({
      id: r.id, from_at: r.scheduled_at, to_at: iso(toJakartaInstant(wibDate(r.scheduled_at), '06:00')),
    }))
    const { error } = await adminSession.rpc(FN, {
      p_event_id: early15EventId,
      p_old: { start_date: before.event.start_date, start_time: '15:00:00', recurrence_rule: before.event.recurrence_rule, event_type: before.event.event_type },
      p_new: { start_date: before.event.start_date, start_time: '06:00:00', recurrence_rule: before.event.recurrence_rule, event_type: before.event.event_type },
      p_moves: moves,
      p_expected_slots: expectedSlots(before.event, '06:00'),
    })
    expect(error?.message).toBe('schedule_change:expected_missing')
    expect(await snapshot(early15EventId)).toEqual(before)
    expect(await auditRows(early15EventId)).toHaveLength(0)
  })
})

// ── Event day ────────────────────────────────────────────────────────────────

describe('event day', () => {
  const now = new Date()
  const oldAt = subMinutes(now, 30)
  const newAt = addMinutes(now, 60)
  // Needs both times on today's WIB date; skip in the 90 minutes around WIB midnight.
  const sameDay = wibDate(iso(oldAt)) === wibDate(iso(now)) && wibDate(iso(newAt)) === wibDate(iso(now))

  it.skipIf(!sameDay)('SC-D01 today\'s occurrence already started at the old time, new time still ahead → in_progress, nothing changed', async () => {
    const today = wibDate(iso(now))
    const weekday = formatJakarta(now, 'EEEEEE').toUpperCase().slice(0, 2) // MO..SU
    const oldTime = formatJakarta(oldAt, 'HH:mm')
    const newTime = formatJakarta(newAt, 'HH:mm')
    if (oldTime < '07:00' || newTime < '07:00') return // early_time would answer first; covered by SC-R06/R07
    const id = await insertEvent('EventDay', {
      event_type: 'other_recurring', start_date: today, start_time: `${oldTime}:00`,
      recurrence_rule: `FREQ=WEEKLY;BYDAY=${weekday}`,
    })
    // Today's row was materialized earlier (before it started); the rest now.
    await insertInstance(id, toJakartaInstant(today, oldTime), 'scheduled')
    await materializeEvents({ supabase: svc, now: new Date() })
    const before = await snapshot(id)
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: id,
      input: { start_time: newTime }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_change_refused', reason: 'in_progress' })
    expect(await snapshot(id)).toEqual(before)

    // SQL: a move whose from_at is not in the future → in_progress, rollback.
    const pastRow = before.rows.find(r => wibDate(r.scheduled_at) === today)!
    const { error } = await adminSession.rpc(FN, {
      p_event_id: id,
      p_old: { start_date: today, start_time: `${oldTime}:00`, recurrence_rule: `FREQ=WEEKLY;BYDAY=${weekday}`, event_type: 'other_recurring' },
      p_new: { start_date: today, start_time: `${newTime}:00`, recurrence_rule: `FREQ=WEEKLY;BYDAY=${weekday}`, event_type: 'other_recurring' },
      p_moves: [{ id: pastRow.id, from_at: pastRow.scheduled_at, to_at: iso(toJakartaInstant(today, newTime)) }],
      p_expected_slots: [],
    })
    expect(error?.message).toBe('schedule_change:in_progress')
    expect(await snapshot(id)).toEqual(before)
  })
})

// ── Inactive recurring ───────────────────────────────────────────────────────

describe('inactive recurring event', () => {
  it('SC-I01 moves applied while inactive; reactivation → materializer inserts 0', async () => {
    const before = await instances(inactiveEventId)
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: inactiveEventId,
      input: { start_time: '16:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toMatchObject({ status: 'ok', schedule_change: { moved: future(before).length, cancelled_moved: 0 } })
    const { error } = await svc.from('events').update({ active: true }).eq('id', inactiveEventId)
    expect(error).toBeNull()
    await materializeTwiceZero(inactiveEventId)
    expect(future(await instances(inactiveEventId)).every(r => wib(r.scheduled_at).slice(11) === '16:00')).toBe(true)
  })
})

// ── A: adhoc ─────────────────────────────────────────────────────────────────

describe('A — adhoc date/time change', () => {
  it('SC-A01 date + time move of its single future row (id unchanged), materializer 0, audit', async () => {
    const before = await instances(adhocEventId)
    expect(before).toHaveLength(1)
    const newDate = formatJakarta(addDays(new Date(), 12), 'yyyy-MM-dd')
    const preview = await impl_previewScheduleChange({
      supabase: adminSession, eventId: adhocEventId, input: { start_date: newDate, start_time: '17:30' },
    })
    expect(preview).toEqual({ status: 'ok', shape: 'A', moved: 1, cancelled_moved: 0, to_date: newDate, to_time: '17:30' })
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: adhocEventId,
      input: { start_date: newDate, start_time: '17:30' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'ok', event_id: adhocEventId, schedule_change: { moved: 1, cancelled_moved: 0 } })
    const after = await instances(adhocEventId)
    expect(after).toEqual([{ ...before[0], scheduled_at: iso(toJakartaInstant(newDate, '17:30')) }])
    expect(await eventById(adhocEventId)).toMatchObject({ start_date: newDate, start_time: '17:30:00' })
    await materializeTwiceZero(adhocEventId)
    const audits = await auditRows(adhocEventId)
    expect(audits).toHaveLength(1)
    expect(audits[0].details_json.moves).toEqual([
      { id: before[0].id, from: expect.any(String), to: expect.any(String), status: 'scheduled' },
    ])
    expect(audits[0].details_json.expected_count).toBe(1)
  })

  it('SC-A02 adhoc beyond the horizon → beyond_horizon, nothing changed', async () => {
    const before = await snapshot(adhocEventId)
    const far = formatJakarta(addMonths(new Date(), HORIZON + 1), 'yyyy-MM-dd')
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: adhocEventId,
      input: { start_date: far }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_change_refused', reason: 'beyond_horizon' })
    expect(await snapshot(adhocEventId)).toEqual(before)
  })

  it('SC-A03 adhoc with only a past row → plain update (no lock), unchanged behaviour', async () => {
    const before = await instances(adhocPastEventId)
    const newDate = formatJakarta(subDays(new Date(), 9), 'yyyy-MM-dd')
    const preview = await impl_previewScheduleChange({
      supabase: adminSession, eventId: adhocPastEventId, input: { start_date: newDate, start_time: '16:00' },
    })
    expect(preview).toEqual({ status: 'no_future_rows' })
    const result = await impl_updateEvent({
      supabase: adminSession, adminSupabase: svc, eventId: adhocPastEventId,
      input: { start_date: newDate, start_time: '16:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'ok', event_id: adhocPastEventId })
    expect(await eventById(adhocPastEventId)).toMatchObject({ start_date: newDate, start_time: '16:00:00' })
    expect(await instances(adhocPastEventId)).toEqual(before)
    expect(await auditRows(adhocPastEventId)).toHaveLength(0)
    expect(await auditRows(adhocPastEventId, 'event.update')).toHaveLength(1)
  })
})

// ── Guards: stale, roles, shapes, flag ───────────────────────────────────────

describe('guards', () => {
  async function guardPlan(time = '16:00') {
    const e = await eventById(guardEventId)
    const rows = future(await instances(guardEventId))
    return {
      e,
      args: {
        p_event_id: guardEventId,
        p_old: { start_date: e.start_date, start_time: e.start_time, recurrence_rule: e.recurrence_rule, event_type: e.event_type },
        p_new: { start_date: e.start_date, start_time: `${time}:00`, recurrence_rule: e.recurrence_rule, event_type: e.event_type },
        p_moves: rows.map(r => ({ id: r.id, from_at: r.scheduled_at, to_at: iso(toJakartaInstant(wibDate(r.scheduled_at), time)) })),
        p_expected_slots: expectedSlots(e, time),
      },
    }
  }

  it('SC-G01 stale p_old → schedule_change:stale, nothing changed', async () => {
    const { args } = await guardPlan()
    const before = await snapshot(guardEventId)
    const { error } = await adminSession.rpc(FN, { ...args, p_old: { ...args.p_old, start_time: '14:00:00' } })
    expect(error?.message).toBe('schedule_change:stale')
    expect(await snapshot(guardEventId)).toEqual(before)
  })

  it('SC-G02 organizer: action keeps the Phase 1 lock; preview refused not_admin; direct RPC → not_admin', async () => {
    const before = await snapshot(guardEventId)
    const result = await impl_updateEvent({
      supabase: organizerSession, adminSupabase: svc, eventId: guardEventId,
      input: { start_time: '16:00' }, options: { confirmScheduleChange: true },
    })
    expect(result).toEqual({ status: 'schedule_locked' })
    const preview = await impl_previewScheduleChange({
      supabase: organizerSession, eventId: guardEventId, input: { start_date: before.event.start_date, start_time: '16:00' },
    })
    expect(preview).toEqual({ status: 'refused', reason: 'not_admin' })
    const { args } = await guardPlan()
    const { error } = await organizerSession.rpc(FN, args)
    expect(error?.message).toBe('schedule_change:not_admin')
    expect(await snapshot(guardEventId)).toEqual(before)
  })

  it('SC-G03 anon: no EXECUTE (42501); ACL is authenticated only', async () => {
    const { args } = await guardPlan()
    const { error } = await anonClient.rpc(FN, args)
    expect(error?.code).toBe('42501')
    expect(psql(
      `SELECT array_to_string(array_agg(r ORDER BY r), ',') FROM unnest(ARRAY['anon','authenticated','service_role']) r ` +
      `WHERE has_function_privilege(r, 'public.apply_event_schedule_change(uuid,jsonb,jsonb,jsonb,timestamptz[])', 'EXECUTE')`,
    )).toBe('authenticated')
    expect(psql(
      `SELECT prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc ` +
      `WHERE oid = 'public.apply_event_schedule_change(uuid,jsonb,jsonb,jsonb,timestamptz[])'::regprocedure`,
    )).toBe('false:search_path=public, pg_temp')
  })

  it('SC-G04 non-R/A shapes are refused inside the function (rule change, type change, recurring date change)', async () => {
    const { args } = await guardPlan()
    const before = await snapshot(guardEventId)
    const variants = [
      { ...args.p_new, recurrence_rule: 'FREQ=MONTHLY;BYDAY=3SA' },
      { ...args.p_new, event_type: 'other_recurring' },
      { ...args.p_new, start_date: formatJakarta(addDays(new Date(`${args.p_new.start_date}T00:00:00Z`), 1), 'yyyy-MM-dd') },
      { ...args.p_new, start_time: args.p_old.start_time }, // no change at all
    ]
    for (const p_new of variants) {
      const { error } = await adminSession.rpc(FN, { ...args, p_new })
      expect(error?.message, JSON.stringify(p_new)).toBe('schedule_change:unsupported_change')
    }
    const { error: emptyErr } = await adminSession.rpc(FN, { ...args, p_moves: [] })
    expect(emptyErr?.message).toBe('schedule_change:nothing_to_move')
    expect(await snapshot(guardEventId)).toEqual(before)
  })

  it('SC-G05 flag outside the function: plain value, another txid, or a valid flag with a non-R/A change → still locked', () => {
    const id = guardEventId
    // Naive values.
    for (const v of ['on', id, `${id}:0`]) {
      expect(() => psql(
        `BEGIN; SELECT set_config('app.event_schedule_change', '${v}', true); ` +
        `UPDATE public.events SET start_time = '16:00' WHERE id = '${id}'; COMMIT;`,
      )).toThrow(/event:schedule_locked/)
    }
    // A flag minted in an earlier transaction (session-level) is worthless in the next one.
    expect(() => psql(
      `SELECT set_config('app.event_schedule_change', '${id}:' || txid_current(), false)`,
      `UPDATE public.events SET start_time = '16:00' WHERE id = '${id}'`,
    )).toThrow(/event:schedule_locked/)
    // Even a correctly bound flag only passes the R/A shape with no other column changed.
    const bound = `SELECT set_config('app.event_schedule_change', '${id}:' || txid_current(), true);`
    for (const change of [
      `recurrence_rule = 'FREQ=MONTHLY;BYDAY=3SA'`,
      `event_type = 'other_recurring'`,
      `start_date = start_date + 1`,
      `start_time = '16:00', name = name || ' x'`,
      `start_time = '16:00', active = false`,
    ]) {
      expect(() => psql(`BEGIN; ${bound} UPDATE public.events SET ${change} WHERE id = '${id}'; COMMIT;`), change)
        .toThrow(/event:schedule_locked/)
    }
    // API roles cannot reach set_config (pg_catalog is not exposed).
  })

  it('SC-G06 authenticated cannot call set_config over the API', async () => {
    const { error } = await adminSession.rpc('set_config', { setting_name: 'app.event_schedule_change', new_value: 'x', is_local: true })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('PGRST202')
  })

  it('SC-G07 trigger still blocks every Phase 1 path for all roles (service role start_time change)', async () => {
    const before = await snapshot(guardEventId)
    const { error } = await svc.from('events').update({ start_time: '16:00' }).eq('id', guardEventId)
    expect(error?.message).toBe('event:schedule_locked')
    expect(await snapshot(guardEventId)).toEqual(before)
  })
})

// ── Concurrency ──────────────────────────────────────────────────────────────

describe('concurrency — materializer vs schedule change', () => {
  const sqlLit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`

  /** Full apply args for raceEvent → `time`, as impl_updateEvent would build them. */
  async function racePlan(time: string) {
    const e = await eventById(raceEventId)
    const rows = future(await instances(raceEventId))
    return {
      e,
      p_old: { start_date: e.start_date, start_time: e.start_time, recurrence_rule: e.recurrence_rule, event_type: e.event_type },
      p_new: { start_date: e.start_date, start_time: `${time}:00`, recurrence_rule: e.recurrence_rule, event_type: e.event_type },
      p_moves: rows.map(r => ({ id: r.id, from_at: r.scheduled_at, to_at: iso(toJakartaInstant(wibDate(r.scheduled_at), time)) })),
      p_expected_slots: expectedSlots(e, time),
    }
  }

  async function waitFor(cond: () => boolean, label: string, ms = 10_000) {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timeout waiting for ${label}`)
      await new Promise(r => setTimeout(r, 50))
    }
  }

  it('SC-C01 deterministic: function holds FOR UPDATE in session A while the materializer runs in session B → schedule_changed, 0 inserts, 0 deletes, no duplicates', async () => {
    const from = (await eventById(raceEventId)).start_time.slice(0, 5)
    const to = from === '15:00' ? '16:00' : '15:00'
    const plan = await racePlan(to)
    const beforeRows = await instances(raceEventId)

    // Session A (psql, as the admin): apply the change, then hold the
    // transaction open (event row locked FOR UPDATE) for 3 s before COMMIT.
    const appName = `sc_c01_${ts}`
    const script = [
      'BEGIN;',
      'SET LOCAL ROLE authenticated;',
      `SELECT set_config('request.jwt.claims', ${sqlLit({ sub: adminId, role: 'authenticated' })}, true);`,
      `SELECT public.apply_event_schedule_change('${raceEventId}', ${sqlLit(plan.p_old)}::jsonb, ${sqlLit(plan.p_new)}::jsonb, ` +
        `${sqlLit(plan.p_moves)}::jsonb, ARRAY[${plan.p_expected_slots.map(x => `'${x}'`).join(',')}]::timestamptz[]);`,
      'SELECT pg_sleep(3);',
      'COMMIT;',
    ].join('\n')
    const sessionA = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${appName}`, DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'])
    let aOut = ''
    let aErr = ''
    let aExit: number | null = null
    sessionA.stdout.on('data', d => { aOut += String(d) })
    sessionA.stderr.on('data', d => { aErr += String(d) })
    const aDone = new Promise<void>(resolve => sessionA.on('close', code => { aExit = code; resolve() }))
    sessionA.stdin.end(script)

    // Wait until session A sits in pg_sleep, i.e. the change is applied but uncommitted.
    await waitFor(
      () => psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${appName}' AND query LIKE 'SELECT pg_sleep%' AND state = 'active'`) === '1',
      'session A in pg_sleep',
    )

    // Session B: the materializer reads the OLD (committed) schedule, expands
    // it, and its materialize_event_slots call blocks on FOR SHARE until A
    // commits — then sees the new schedule and inserts nothing.
    const t0 = Date.now()
    const result = await materializeEvents({ supabase: svc, now: new Date() })
    const waitedMs = Date.now() - t0
    await aDone
    expect(aExit, aErr).toBe(0)
    expect(aOut).toContain('"moved"')
    console.log(`[SC-C01] materializer waited ${waitedMs} ms; skipped=${JSON.stringify(result.events_skipped)}`)

    expect(waitedMs).toBeGreaterThan(1000) // it really blocked on the lock
    expect(result.events_with_errors).toEqual([])
    expect(result.events_skipped).toEqual([
      { event_id: raceEventId, event_name: expect.stringContaining('Race'), reason: 'schedule_changed' },
    ])
    expect(result.instances_inserted).toBe(0)

    const after = await instances(raceEventId)
    // 0 deletes, 0 inserts: same id set; every rule row at the new time; one row per WIB date.
    expect(after.map(r => r.id).sort()).toEqual(beforeRows.map(r => r.id).sort())
    const fut = future(after)
    expect(fut.every(r => wib(r.scheduled_at).slice(11) === to)).toBe(true)
    const dates = fut.map(r => wibDate(r.scheduled_at))
    expect(new Set(dates).size).toBe(dates.length)
    expect((await eventById(raceEventId)).start_time).toBe(`${to}:00`)

    await materializeTwiceZero(raceEventId)
  }, 60_000)

  it('SC-C02 random interleaving (best effort): function + materializer in parallel ×4 → no duplicate per WIB date', async () => {
    for (let i = 0; i < 4; i++) {
      const from = (await eventById(raceEventId)).start_time.slice(0, 5)
      const next = from === '15:00' ? '16:00' : '15:00'
      const [res, mat] = await Promise.all([
        impl_updateEvent({
          supabase: adminSession, adminSupabase: svc, eventId: raceEventId,
          input: { start_time: next }, options: { confirmScheduleChange: true },
        }),
        materializeEvents({ supabase: svc, now: new Date() }),
      ])
      expect(res.status, `${from}→${next}`).toBe('ok')
      expect(mat.events_with_errors).toEqual([])
      const rows = future(await instances(raceEventId))
      const dates = rows.map(r => wibDate(r.scheduled_at))
      expect(new Set(dates).size, `duplicates after ${next}`).toBe(dates.length)
      expect(rows.every(r => wib(r.scheduled_at).slice(11) === next)).toBe(true)
    }
    await materializeTwiceZero(raceEventId)
  }, 60_000)

  it('SC-C03 materialize_event_slots: service_role only; schedule/active mismatch → -1 and nothing inserted; match → ON CONFLICT DO NOTHING count', async () => {
    const sig = 'public.materialize_event_slots(uuid,jsonb,timestamptz[])'
    expect(psql(
      `SELECT array_to_string(array_agg(r ORDER BY r), ',') FROM unnest(ARRAY['anon','authenticated','service_role']) r ` +
      `WHERE has_function_privilege(r, '${sig}', 'EXECUTE')`,
    )).toBe('service_role')
    expect(psql(`SELECT prosecdef::text || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${sig}'::regprocedure`))
      .toBe('false:search_path=public, pg_temp')
    const { error: authErr } = await adminSession.rpc('materialize_event_slots', { p_event_id: raceEventId, p_schedule: {}, p_slots: [] })
    expect(authErr?.code).toBe('42501')

    const e = await eventById(raceEventId)
    const schedule = { start_date: e.start_date, start_time: e.start_time, recurrence_rule: e.recurrence_rule, event_type: e.event_type, active: true }
    const before = JSON.stringify(await instances(raceEventId))
    const newSlot = iso(toJakartaInstant(formatJakarta(addDays(new Date(), 3), 'yyyy-MM-dd'), '09:13'))
    for (const p_schedule of [
      { ...schedule, start_time: '09:13:00' },
      { ...schedule, active: false },
      { ...schedule, recurrence_rule: 'FREQ=MONTHLY;BYDAY=3SA' },
      { ...schedule, event_type: 'other_recurring' },
      { ...schedule, start_date: formatJakarta(addDays(new Date(`${e.start_date}T00:00:00Z`), 1), 'yyyy-MM-dd') },
    ]) {
      const { data, error } = await svc.rpc('materialize_event_slots', { p_event_id: raceEventId, p_schedule, p_slots: [newSlot] })
      expect(error, JSON.stringify(p_schedule)).toBeNull()
      expect(data, JSON.stringify(p_schedule)).toBe(-1)
    }
    const { data: unknownEvent } = await svc.rpc('materialize_event_slots', { p_event_id: '00000000-0000-4000-8000-000000000000', p_schedule: schedule, p_slots: [newSlot] })
    expect(unknownEvent).toBe(-1)
    expect(JSON.stringify(await instances(raceEventId))).toBe(before)

    // Match: existing slots conflict (0); a duplicate + one new slot → 1.
    const existing = future(await instances(raceEventId)).map(r => r.scheduled_at)
    const { data: zero } = await svc.rpc('materialize_event_slots', { p_event_id: raceEventId, p_schedule: schedule, p_slots: existing })
    expect(zero).toBe(0)
    const { data: one } = await svc.rpc('materialize_event_slots', { p_event_id: raceEventId, p_schedule: schedule, p_slots: [newSlot, newSlot] })
    expect(one).toBe(1)
    const { data: inserted } = await svc.from('event_instances').select('id, event_name_snapshot, status').eq('event_id', raceEventId).eq('scheduled_at', newSlot).single()
    expect(inserted).toMatchObject({ event_name_snapshot: expect.stringContaining('Race'), status: 'scheduled' })
    await svc.from('event_instances').delete().eq('id', (inserted as { id: string }).id) // test fixture cleanup only
  })
})
