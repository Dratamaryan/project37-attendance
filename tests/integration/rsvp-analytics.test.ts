// Integration tests for Sprint 9 R7 — rsvp_instance_metrics
// (20261026180000_sprint9_r7_rsvp_instance_metrics.sql).
// Runs against local Docker Supabase only (configured in .env.test.local).
// Reads go through an ADMIN session: the view (and the cross-tab under it) is
// is_admin()-filtered, so the organizer clients of analytics-actions.test.ts
// would read zero rows and assert nothing. Catalog privileges go through psql
// inside the local DB container, as in rsvp-admin.test.ts.
// Run: npm test -- rsvp-analytics
//
// Instance dates are built from the DB's own WIB "today" (D).
// Synthetic fixture (phone space +6299900937xxx — S9-R7, unused elsewhere),
// the S9-R7 recon I1–I4 shapes:
//   I1  completed, D-20, one deactivated + one active link
//     M1  member, coming + 2 children (RSVP on the old link), came; 1 child in
//     M2  member, maybe + 1 child, no-show; M2's child checked in anyway
//     M3  member, not_coming, came
//     N1  newcomer coming + 1 child; phone registered later as NB, NB came
//     GH  newcomer coming, phone never on the roster, no-show
//     W1  walk-in member; W1's child checked in
//     D1  soft-deleted walk-in
//     invitations: M1 M2 M4 W1 'sent', M3 'failed'
//   I2  completed, D-15, deactivated link only; W1 walk-in      -> included
//   I3  cancelled, D-10, active link; M1 coming, W1 walk-in      -> excluded
//   I4  completed, D-5, no link; W1 checked in                   -> excluded
//   IF  scheduled, D+5, active link; M1 coming                   -> excluded (future)
//   IR  completed, D-200 (past retention): newcomer RSVP on R's phone, R
//       registered later and came — frozen into retained_person_id by
//       run_rsvp_retention_pass

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { impl_getRsvpAnalytics } from '../../lib/actions/rsvp-analytics.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-analytics.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `runs the global RSVP retention pass — must run against local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
const VIEW = 'public.rsvp_instance_metrics'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

const PHONES = {
  M1: '+6299900937001',
  M2: '+6299900937002',
  M3: '+6299900937003',
  M4: '+6299900937004',
  W1: '+6299900937005',
  D1: '+6299900937006',
  NB: '+6299900937007',
  GH: '+6299900937008',
  R: '+6299900937009',
} as const
const EVENT_NAME = '[SYNTH] R7 RSVP Analytics Event'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string

const authUserIds: string[] = []
const peopleIds: string[] = []
const childIds: string[] = []
let eventId: string
const inst = { I1: '', I2: '', I3: '', I4: '', IF: '', IR: '' }
const person = { M1: '', M2: '', M3: '', M4: '', W1: '', D1: '', NB: '', R: '' }
let rsvpR = ''
let today = ''

/** 'YYYY-MM-DD' + n days (calendar arithmetic, no timezone involved). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Instant of HH:00 WIB (UTC+7, no DST) on a WIB calendar date. */
function wibAt(date: string, hour: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCHours(hour - 7)
  return d.toISOString()
}

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
): Promise<{ session: SupabaseClient; id: string }> {
  const email = `r7-${label}-${randomUUID()}@example.com`
  const pass = `R7-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] R7 ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id }
}

async function insertPerson(label: string, phone: string): Promise<string> {
  const { data, error } = await svc.from('people')
    .insert({ phone_e164: phone, full_name: `[SYNTH] R7 ${label}`, nickname: label })
    .select('id').single()
  if (error) throw new Error(`insert person ${label}: ${error.message}`)
  peopleIds.push(data.id)
  return data.id
}

async function insertInstance(scheduledAt: string, status: 'scheduled' | 'completed' | 'cancelled'): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: EVENT_NAME, event_name_snapshot_id: EVENT_NAME, status })
    .select('id')
    .single()
  if (error) throw new Error(`insert instance: ${error.message}`)
  return data.id
}

async function insertLink(instanceId: string, isActive = true): Promise<string> {
  const { data, error } = await svc.from('event_rsvp_links')
    .insert({ event_instance_id: instanceId, created_by: adminId, is_active: isActive })
    .select('id').single()
  if (error) throw new Error(`insert link: ${error.message}`)
  return data.id
}

async function insertRsvp(
  instanceId: string,
  linkId: string,
  r: { phone: string; name?: string; children?: number; status: 'coming' | 'maybe' | 'not_coming'; personId: string | null },
): Promise<string> {
  const { data, error } = await svc.from('event_rsvps').insert({
    event_instance_id: instanceId,
    link_id: linkId,
    phone_e164: r.phone,
    name: r.name ?? null,
    children_count: r.children ?? 0,
    status: r.status,
    person_id: r.personId,
  }).select('id').single()
  if (error) throw new Error(`insert rsvp: ${error.message}`)
  return data.id
}

async function checkIn(instanceId: string, personId: string): Promise<void> {
  const { error } = await svc.from('attendance')
    .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: adminId })
  if (error) throw new Error(`insert attendance: ${error.message}`)
}

async function checkInChild(instanceId: string, parentId: string, name: string): Promise<void> {
  const { data, error } = await svc.from('children')
    .insert({ parent_person_id: parentId, full_name: `[SYNTH] R7 ${name}` })
    .select('id').single()
  if (error) throw new Error(`insert child: ${error.message}`)
  childIds.push(data.id)
  const { error: caErr } = await svc.from('child_attendance')
    .insert({ event_instance_id: instanceId, child_id: data.id, checked_in_by: adminId })
  if (caErr) throw new Error(`insert child_attendance: ${caErr.message}`)
}

async function invite(instanceId: string, personId: string, status: 'pending' | 'sent' | 'failed'): Promise<void> {
  const { error } = await svc.from('event_invitations')
    .insert({ event_instance_id: instanceId, person_id: personId, status, invited_by: adminId })
  if (error) throw new Error(`insert invitation: ${error.message}`)
}

type MetricsRow = {
  event_instance_id: string
  event_id: string
  event_type: string
  scheduled_at: string
  ended_at: string
  coming_people: number
  coming_headcount: number
  maybe_people: number
  coming_came: number
  coming_no_show: number
  walk_ins: number
  actual_adults: number
  actual_children: number
  newcomer_rsvps: number
  became_members: number
  invited: number
  invited_responded: number
  invited_attended: number
}

async function metrics(session: SupabaseClient): Promise<MetricsRow[]> {
  const { data, error } = await session.from('rsvp_instance_metrics')
    .select('*')
    .in('event_instance_id', Object.values(inst))
  if (error) throw new Error(`view read: ${error.message}`)
  return data as MetricsRow[]
}

const COUNT_COLUMNS = [
  'coming_people', 'coming_headcount', 'maybe_people', 'coming_came', 'coming_no_show',
  'walk_ins', 'actual_adults', 'actual_children', 'newcomer_rsvps', 'became_members',
  'invited', 'invited_responded', 'invited_attended',
] as const

function counts(row: MetricsRow | undefined) {
  if (!row) return undefined
  return Object.fromEntries(COUNT_COLUMNS.map(c => [c, row[c]]))
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session; adminId = admin.id
  organizerSession = (await createAppUserSession('organizer', 'organizer')).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc',
    start_date: '2026-01-01', start_time: '10:00', duration_min: 120, recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  today = psql(`SELECT (now() AT TIME ZONE 'Asia/Jakarta')::date`)

  for (const k of ['M1', 'M2', 'M3', 'M4', 'W1', 'D1'] as const) person[k] = await insertPerson(k, PHONES[k])
  const { error: delErr } = await svc.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', person.D1)
  if (delErr) throw new Error(`soft-delete: ${delErr.message}`)

  // ── I1 ──
  inst.I1 = await insertInstance(wibAt(addDays(today, -20), 10), 'completed')
  const oldLink = await insertLink(inst.I1, false)
  const newLink = await insertLink(inst.I1, true)
  await insertRsvp(inst.I1, oldLink, { phone: PHONES.M1, children: 2, status: 'coming', personId: person.M1 })
  await insertRsvp(inst.I1, newLink, { phone: PHONES.M2, children: 1, status: 'maybe', personId: person.M2 })
  await insertRsvp(inst.I1, newLink, { phone: PHONES.M3, status: 'not_coming', personId: person.M3 })
  await insertRsvp(inst.I1, newLink, { phone: PHONES.NB, name: '[SYNTH] R7 Newb', children: 1, status: 'coming', personId: null })
  await insertRsvp(inst.I1, newLink, { phone: PHONES.GH, name: '[SYNTH] R7 Ghost', status: 'coming', personId: null })
  person.NB = await insertPerson('NB', PHONES.NB)   // registered at the door after the RSVP
  for (const p of [person.M1, person.M3, person.W1, person.D1, person.NB]) await checkIn(inst.I1, p)
  await checkInChild(inst.I1, person.M1, 'M1 kid')
  await checkInChild(inst.I1, person.M2, 'M2 kid')
  await checkInChild(inst.I1, person.W1, 'W1 kid')
  await invite(inst.I1, person.M1, 'sent')
  await invite(inst.I1, person.M2, 'sent')
  await invite(inst.I1, person.M3, 'failed')
  await invite(inst.I1, person.M4, 'sent')
  await invite(inst.I1, person.W1, 'sent')

  // ── I2 — deactivated link only ──
  inst.I2 = await insertInstance(wibAt(addDays(today, -15), 10), 'completed')
  await insertLink(inst.I2, false)
  await checkIn(inst.I2, person.W1)

  // ── I3 — cancelled ──
  inst.I3 = await insertInstance(wibAt(addDays(today, -10), 10), 'cancelled')
  const link3 = await insertLink(inst.I3, true)
  await insertRsvp(inst.I3, link3, { phone: PHONES.M1, status: 'coming', personId: person.M1 })
  await checkIn(inst.I3, person.W1)

  // ── I4 — no link ──
  inst.I4 = await insertInstance(wibAt(addDays(today, -5), 10), 'completed')
  await checkIn(inst.I4, person.W1)

  // ── IF — future ──
  inst.IF = await insertInstance(wibAt(addDays(today, 5), 10), 'scheduled')
  const linkF = await insertLink(inst.IF, true)
  await insertRsvp(inst.IF, linkF, { phone: PHONES.M1, status: 'coming', personId: person.M1 })

  // ── IR — past retention ──
  inst.IR = await insertInstance(wibAt(addDays(today, -200), 10), 'completed')
  const linkR = await insertLink(inst.IR, true)
  rsvpR = await insertRsvp(inst.IR, linkR, { phone: PHONES.R, name: '[SYNTH] R7 Newcomer R', status: 'coming', personId: null })
  person.R = await insertPerson('R', PHONES.R)
  await checkIn(inst.IR, person.R)
})

afterAll(async () => {
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('audit_log').delete().eq('action', 'rsvp.anonymize').in('entity_id', instIds)
    await svc.from('event_invitations').delete().in('event_instance_id', instIds)
    await svc.from('child_attendance').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvps').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvp_links').delete().in('event_instance_id', instIds)
    await svc.from('attendance').delete().in('event_instance_id', instIds)
    await svc.from('event_instances').delete().in('id', instIds)
  }
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (childIds.length > 0) await svc.from('children').delete().in('id', childIds)
  if (peopleIds.length > 0) await svc.from('people').delete().in('id', peopleIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
})

// ── row values ───────────────────────────────────────────────────────────────

describe('rsvp_instance_metrics — instance set and values', () => {
  it('I1 — hand-computed recon row, exact', async () => {
    const rows = await metrics(adminSession)
    const i1 = rows.find(r => r.event_instance_id === inst.I1)
    expect(counts(i1)).toEqual({
      coming_people: 3,
      coming_headcount: 6,
      maybe_people: 1,
      coming_came: 2,
      coming_no_show: 1,
      walk_ins: 2,
      actual_adults: 5,
      actual_children: 3,
      newcomer_rsvps: 2,
      became_members: 1,
      invited: 4,
      invited_responded: 2,
      invited_attended: 2,
    })
    expect(i1?.event_id).toBe(eventId)
    expect(i1?.event_type).toBe('adhoc')
    expect(new Date(i1!.ended_at).getTime() - new Date(i1!.scheduled_at).getTime()).toBe(120 * 60_000)
  })

  it('I2 (deactivated link only) included; I3 cancelled, I4 no link, IF future excluded', async () => {
    const ids = (await metrics(adminSession)).map(r => r.event_instance_id)
    expect(ids).toContain(inst.I2)
    expect(ids).not.toContain(inst.I3)
    expect(ids).not.toContain(inst.I4)
    expect(ids).not.toContain(inst.IF)
    const i2 = (await metrics(adminSession)).find(r => r.event_instance_id === inst.I2)
    expect(counts(i2)).toMatchObject({ coming_people: 0, coming_headcount: 0, walk_ins: 1, actual_adults: 1, invited: 0 })
  })

  it('became_members survives the retention scrub via retained_person_id', async () => {
    const before = (await metrics(adminSession)).find(r => r.event_instance_id === inst.IR)
    expect(counts(before)).toMatchObject({ newcomer_rsvps: 1, became_members: 1, coming_came: 1, walk_ins: 0 })

    const { error } = await svc.rpc('run_rsvp_retention_pass', { p_actor_user_id: null })
    expect(error).toBeNull()

    const { data: scrubbed, error: rErr } = await svc.from('event_rsvps')
      .select('phone_e164, person_id, retained_person_id, anonymized_at').eq('id', rsvpR).single()
    expect(rErr).toBeNull()
    expect(scrubbed).toMatchObject({ phone_e164: null, person_id: null, retained_person_id: person.R })
    expect(scrubbed?.anonymized_at).not.toBeNull()

    const after = (await metrics(adminSession)).find(r => r.event_instance_id === inst.IR)
    expect(counts(after)).toEqual(counts(before))
  })
})

// ── impl_getRsvpAnalytics ────────────────────────────────────────────────────

describe('impl_getRsvpAnalytics', () => {
  it('admin session: I1 + I2 rows in WIB date order, pooled KPIs = hand numbers', async () => {
    // D-21..D-14 (WIB, to inclusive) brackets exactly I1 (D-20) and I2 (D-15).
    const result = await impl_getRsvpAnalytics({
      supabase: adminSession,
      filters: { from: addDays(today, -21), to: addDays(today, -14), eventType: 'adhoc' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.rows.map(r => r.event_instance_id)).toEqual([inst.I1, inst.I2])
    expect(result.data.rows.map(r => r.scheduled_date)).toEqual([addDays(today, -20), addDays(today, -15)])
    expect(result.data.kpis).toEqual({
      instances: 2,
      coming_headcount: 6,
      coming_people: 3,
      maybe_people: 1,
      actual_adults: 6,
      actual_children: 3,
      show_up_rate: 2 / 3,
      no_show_rate: 1 / 3,
      walk_in_share: 3 / 6,
      newcomer_rsvps: 2,
      became_members: 1,
      funnel_response_rate: 2 / 4,
      funnel_attendance_rate: 2 / 4,
    })
  })

  it('to is inclusive on the WIB date: to = I1 date keeps I1, the day before drops it', async () => {
    const onDay = await impl_getRsvpAnalytics({
      supabase: adminSession, filters: { from: addDays(today, -20), to: addDays(today, -20) },
    })
    const dayBefore = await impl_getRsvpAnalytics({
      supabase: adminSession, filters: { from: addDays(today, -21), to: addDays(today, -21) },
    })
    expect(onDay.status === 'ok' && onDay.data.rows.map(r => r.event_instance_id)).toContain(inst.I1)
    expect(dayBefore.status === 'ok' && dayBefore.data.rows.map(r => r.event_instance_id)).not.toContain(inst.I1)
  })

  it('eventType filter excludes the fixture', async () => {
    const result = await impl_getRsvpAnalytics({
      supabase: adminSession,
      filters: { from: addDays(today, -21), to: addDays(today, -14), eventType: 'friday_monthly' },
    })
    expect(result.status === 'ok' && result.data.rows.map(r => r.event_instance_id)).not.toContain(inst.I1)
  })

  it('organizer session -> not_authorized', async () => {
    expect(await impl_getRsvpAnalytics({ supabase: organizerSession, filters: {} })).toEqual({ status: 'not_authorized' })
  })

  it('anon -> not_authorized', async () => {
    expect(await impl_getRsvpAnalytics({ supabase: anonSession, filters: {} })).toEqual({ status: 'not_authorized' })
  })

  it('invalid date -> invalid_filter', async () => {
    const result = await impl_getRsvpAnalytics({ supabase: adminSession, filters: { from: '2026/10/01' } })
    expect(result.status).toBe('invalid_filter')
  })
})

// ── access ───────────────────────────────────────────────────────────────────

describe('rsvp_instance_metrics — access', () => {
  it('organizer session -> 0 rows, no error (even though organizers can read attendance)', async () => {
    const { data, error } = await organizerSession.from('rsvp_instance_metrics').select('event_instance_id')
      .in('event_instance_id', Object.values(inst))
    expect(error).toBeNull()
    expect(data).toEqual([])
    const att = await organizerSession.from('attendance').select('id').eq('event_instance_id', inst.I1)
    expect(att.data?.length).toBe(5)
  })

  it('anon -> permission error', async () => {
    const { data, error } = await anonSession.from('rsvp_instance_metrics').select('event_instance_id').limit(1)
    expect(data).toBeNull()
    expect(error?.code).toBe('42501')
  })

  it('catalog privileges: anon/PUBLIC none; authenticated SELECT only', () => {
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
    const out = psql(
      `SELECT r || ':' || p FROM unnest(array['anon','authenticated','public']) r, ` +
      `unnest(array['${privs.join("','")}']) p WHERE has_table_privilege(r, '${VIEW}', p) ORDER BY 1`,
    )
    expect(out.split('\n').filter(Boolean)).toEqual(['authenticated:SELECT'])
  })

  it('view is security_invoker', () => {
    expect(psql(`SELECT reloptions::text FROM pg_class WHERE oid = '${VIEW}'::regclass`)).toBe('{security_invoker=on}')
  })
})
