// Integration tests for Sprint 9 R3 — rsvp_checkin_crosstab
// (20261024120000_sprint9_r3_rsvp_crosstab.sql) and the admin RSVP actions in
// lib/rsvp/admin.impl.ts (link lifecycle, panel aggregation, junk-delete).
// Runs against local Docker Supabase only (configured in .env.test.local).
// The impl functions are called directly with REAL session clients, so
// requireActiveAdmin + RLS run for real. Catalog privileges go through psql
// inside the local DB container (docker exec), as in rsvp-rpc.test.ts.
// Run: npm test -- rsvp-admin
//
// Synthetic fixture (phone space +62999009310xx — S9-R3, unused elsewhere):
//   IA  linked instance, one RSVP per bucket case:
//     M1  member, coming, 2 children, checked in             -> coming_came
//     M2  member, coming, 0 children, absent                 -> coming_no_show
//     N1  newcomer (no person at submit), coming, 1 child; the phone was
//         later registered at the door as person N1P, who checked in
//         -> resolved via phone, attended, matched_at_submit false
//                                                            -> coming_came
//     M3  member, maybe, 1 child; RSVP phone is M3's OLD phone, M3's roster
//         phone changed since -> still resolves via person_id -> maybe_came
//     N2  newcomer, maybe, no name, phone not on roster      -> maybe_no_show
//     X   NULL phone + NULL person_id, not_coming            -> not_coming_no_show
//     M4  member, not_coming, checked in anyway              -> not_coming_came
//     M5  member, coming, absent, soft-deleted after RSVP    -> coming_no_show,
//         listed as 'removed_member'
//     W1, W2  checked in, no RSVP                            -> walk_in
//     child_attendance: K1 (M1's child), K2 (N1P's child), KD (M1's child,
//         soft-deleted after check-in — excluded, same as the attendees list)
//   IB  instance WITHOUT a link, with check-ins (M1, W1)     -> zero view rows
//   IS  scheduled, no link        — getOrCreate / deactivate lifecycle
//   IM  scheduled, no link        — misconfigured / disabled never insert
//   IC  cancelled                 — closed
//   ID  scheduled, own link + RSVP — deleteRsvp
//
// Hand-computed for IA:
//   responses 8; coming: M1 M2 N1 M5 -> people 4, children 2+0+1+0 = 3,
//   headcount 4 + 3 = 7; maybe: M3 N2 -> people 2, headcount 2 + 1 = 3;
//   not_coming: X M4 -> 2.
//   buckets: coming_came 2 (M1, N1), coming_no_show 2 (M2, M5), maybe_came 1
//   (M3), maybe_no_show 1 (N2), not_coming_came 1 (M4), not_coming_no_show 1
//   (X), walk_in 2 (W1, W2) -> 10 view rows. children: expected 3, checked in 2.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

import { impl_getInstanceAttendees } from '@/lib/actions/instance-attendees.impl'
import {
  impl_deactivateRsvpLink,
  impl_deleteRsvp,
  impl_getInstanceRsvpPanel,
  impl_getOrCreateRsvpLink,
} from '@/lib/rsvp/admin.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-admin.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `creates/deletes auth users, people and RSVP rows — must run against local Docker only.`,
  )
}

const DB_CONTAINER = 'supabase_db_project37-rewrite'
const APP_URL = 'http://localhost:3000'
const VIEW = 'public.rsvp_checkin_crosstab'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', DB_CONTAINER, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc', sql],
    { encoding: 'utf8' },
  ).trim()
}

const PHONES = {
  M1: '+6299900931001',
  M2: '+6299900931002',
  N1: '+6299900931003',   // newcomer's RSVP phone, later N1P's roster phone
  M3_OLD: '+6299900931004',
  M3_NEW: '+6299900931005',
  N2: '+6299900931006',
  M4: '+6299900931007',
  M5: '+6299900931008',
  W1: '+6299900931009',
  W2: '+6299900931010',
  D1: '+6299900931011',
} as const
const ALL_PHONES = Object.values(PHONES)
const EVENT_NAME = '[SYNTH] R3 Crosstab Event'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string

const authUserIds: string[] = []
const peopleIds: string[] = []
const childIds: string[] = []
let eventId: string
const inst = { IA: '', IB: '', IS: '', IM: '', IC: '', ID: '' }
const person = { M1: '', M2: '', N1P: '', M3: '', M4: '', M5: '', W1: '', W2: '' }
const rsvp = { M1: '', M2: '', N1: '', M3: '', N2: '', X: '', M4: '', M5: '', D1: '' }
const tokens: string[] = []

const ORIGINAL_FLAG = process.env.RSVP_PUBLIC_ENABLED
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
): Promise<{ session: SupabaseClient; id: string }> {
  const email = `r3-${label}-${randomUUID()}@example.com`
  const pass = `R3-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] R3 ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id }
}

async function insertPerson(label: string, phone: string): Promise<string> {
  const { data, error } = await svc.from('people')
    .insert({ phone_e164: phone, full_name: `[SYNTH] R3 ${label}`, nickname: label })
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

async function insertLink(instanceId: string): Promise<string> {
  const { data, error } = await svc.from('event_rsvp_links')
    .insert({ event_instance_id: instanceId, created_by: adminId })
    .select('id, token').single()
  if (error) throw new Error(`insert link: ${error.message}`)
  tokens.push(data.token)
  return data.id
}

type RsvpFixture = {
  phone: string | null
  name?: string | null
  children: number
  status: 'coming' | 'maybe' | 'not_coming'
  personId: string | null
  followup?: boolean
}
async function insertRsvp(instanceId: string, linkId: string, r: RsvpFixture): Promise<string> {
  const { data, error } = await svc.from('event_rsvps').insert({
    event_instance_id: instanceId,
    link_id: linkId,
    phone_e164: r.phone,
    name: r.name ?? null,
    children_count: r.children,
    followup_consent: r.followup ?? false,
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

async function insertChildCheckin(instanceId: string, parentId: string, label: string, deletedAt: string | null = null): Promise<void> {
  const { data, error } = await svc.from('children')
    .insert({ parent_person_id: parentId, full_name: `[SYNTH] R3 Child ${label}`, birth_date: '2019-01-01', deleted_at: deletedAt })
    .select('id').single()
  if (error) throw new Error(`insert child: ${error.message}`)
  childIds.push(data.id)
  const { error: caErr } = await svc.from('child_attendance')
    .insert({ event_instance_id: instanceId, child_id: data.id, checked_in_by: adminId })
  if (caErr) throw new Error(`insert child_attendance: ${caErr.message}`)
}

async function rsvpAudits(action: string): Promise<Array<{ entity_id: string; entity_type: string; details_json: Record<string, unknown> }>> {
  const { data, error } = await svc
    .from('audit_log')
    .select('entity_id, entity_type, details_json')
    .eq('action', action)
    .in('actor_user_id', authUserIds)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`audit read: ${error.message}`)
  return (data ?? []) as Array<{ entity_id: string; entity_type: string; details_json: Record<string, unknown> }>
}

async function activeLinkCount(instanceId: string): Promise<number> {
  const { count, error } = await svc.from('event_rsvp_links')
    .select('id', { count: 'exact', head: true })
    .eq('event_instance_id', instanceId)
    .eq('is_active', true)
  if (error) throw new Error(`count links: ${error.message}`)
  return count ?? 0
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session; adminId = admin.id
  organizerSession = (await createAppUserSession('organizer', 'organizer')).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME, event_type: 'adhoc',
    start_date: '2026-09-01', start_time: '18:00', recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  inst.IA = await insertInstance('2026-09-05T11:00:00Z', 'completed')
  inst.IB = await insertInstance('2026-09-12T11:00:00Z', 'completed')
  inst.IS = await insertInstance('2099-01-03T11:00:00Z', 'scheduled')
  inst.IM = await insertInstance('2099-01-10T11:00:00Z', 'scheduled')
  inst.IC = await insertInstance('2099-01-17T11:00:00Z', 'cancelled')
  inst.ID = await insertInstance('2099-01-24T11:00:00Z', 'scheduled')

  person.M1 = await insertPerson('M1', PHONES.M1)
  person.M2 = await insertPerson('M2', PHONES.M2)
  person.M3 = await insertPerson('M3', PHONES.M3_OLD)
  person.M4 = await insertPerson('M4', PHONES.M4)
  person.M5 = await insertPerson('M5', PHONES.M5)
  person.W1 = await insertPerson('W1', PHONES.W1)
  person.W2 = await insertPerson('W2', PHONES.W2)

  const linkA = await insertLink(inst.IA)
  rsvp.M1 = await insertRsvp(inst.IA, linkA, { phone: PHONES.M1, children: 2, status: 'coming', personId: person.M1, followup: true })
  rsvp.M2 = await insertRsvp(inst.IA, linkA, { phone: PHONES.M2, children: 0, status: 'coming', personId: person.M2 })
  rsvp.N1 = await insertRsvp(inst.IA, linkA, { phone: PHONES.N1, name: '[SYNTH] R3 Newcomer N1', children: 1, status: 'coming', personId: null, followup: true })
  rsvp.M3 = await insertRsvp(inst.IA, linkA, { phone: PHONES.M3_OLD, children: 1, status: 'maybe', personId: person.M3 })
  rsvp.N2 = await insertRsvp(inst.IA, linkA, { phone: PHONES.N2, name: null, children: 0, status: 'maybe', personId: null })
  rsvp.X  = await insertRsvp(inst.IA, linkA, { phone: null, name: '[SYNTH] R3 No Phone', children: 0, status: 'not_coming', personId: null })
  rsvp.M4 = await insertRsvp(inst.IA, linkA, { phone: PHONES.M4, children: 0, status: 'not_coming', personId: person.M4 })
  rsvp.M5 = await insertRsvp(inst.IA, linkA, { phone: PHONES.M5, children: 0, status: 'coming', personId: person.M5 })

  // After the RSVPs: N1's phone is registered at the door; M3's phone changes;
  // M5 is soft-deleted.
  person.N1P = await insertPerson('N1P', PHONES.N1)
  {
    const { error } = await svc.from('people').update({ phone_e164: PHONES.M3_NEW }).eq('id', person.M3)
    if (error) throw new Error(`change M3 phone: ${error.message}`)
  }
  {
    const { error } = await svc.from('people').update({ deleted_at: '2026-09-20T00:00:00Z' }).eq('id', person.M5)
    if (error) throw new Error(`soft-delete M5: ${error.message}`)
  }

  for (const p of [person.M1, person.N1P, person.M3, person.M4, person.W1, person.W2]) await checkIn(inst.IA, p)
  await insertChildCheckin(inst.IA, person.M1, 'K1')
  await insertChildCheckin(inst.IA, person.N1P, 'K2')
  await insertChildCheckin(inst.IA, person.M1, 'KD', '2026-09-21T00:00:00Z')

  // IB — no link, but check-ins.
  await checkIn(inst.IB, person.M1)
  await checkIn(inst.IB, person.W1)

  // ID — own link + one matched RSVP for deleteRsvp.
  const linkD = await insertLink(inst.ID)
  rsvp.D1 = await insertRsvp(inst.ID, linkD, { phone: PHONES.D1, name: '[SYNTH] R3 Junk', children: 3, status: 'maybe', personId: null })
}, 60_000)

afterAll(async () => {
  setEnv('RSVP_PUBLIC_ENABLED', ORIGINAL_FLAG)
  setEnv('NEXT_PUBLIC_APP_URL', ORIGINAL_APP_URL)
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('event_rsvps').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvp_links').delete().in('event_instance_id', instIds)
    await svc.from('child_attendance').delete().in('event_instance_id', instIds)
    await svc.from('attendance').delete().in('event_instance_id', instIds)
  }
  if (childIds.length > 0) await svc.from('children').delete().in('id', childIds)
  if (instIds.length > 0) await svc.from('event_instances').delete().in('id', instIds)
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (peopleIds.length > 0) await svc.from('people').delete().in('id', peopleIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

beforeEach(() => {
  setEnv('RSVP_PUBLIC_ENABLED', 'true')
  setEnv('NEXT_PUBLIC_APP_URL', APP_URL)
})

// ── view ─────────────────────────────────────────────────────────────────────

type ViewRow = {
  event_instance_id: string
  rsvp_id: string | null
  attendance_id: string | null
  resolved_person_id: string | null
  matched_at_submit: boolean
  rsvp_status: string | null
  children_count: number | null
  attended: boolean
  bucket: string
}

describe('rsvp_checkin_crosstab — buckets', () => {
  let rows: ViewRow[]

  beforeAll(async () => {
    const { data, error } = await adminSession.from('rsvp_checkin_crosstab').select('*').eq('event_instance_id', inst.IA)
    if (error) throw new Error(`view read: ${error.message}`)
    rows = data as ViewRow[]
  })

  it('exactly 10 rows: 8 RSVPs + 2 walk-ins', () => {
    expect(rows).toHaveLength(10)
    expect(rows.filter(r => r.rsvp_id !== null)).toHaveLength(8)
  })

  it('bucket of every RSVP, hand-computed', () => {
    const byRsvp = new Map(rows.filter(r => r.rsvp_id).map(r => [r.rsvp_id!, r.bucket]))
    expect(Object.fromEntries(Object.entries(rsvp).filter(([k]) => k !== 'D1').map(([k, id]) => [k, byRsvp.get(id)]))).toEqual({
      M1: 'coming_came',
      M2: 'coming_no_show',
      N1: 'coming_came',
      M3: 'maybe_came',
      N2: 'maybe_no_show',
      X:  'not_coming_no_show',
      M4: 'not_coming_came',
      M5: 'coming_no_show',
    })
  })

  it('walk-ins: W1 and W2 only, no RSVP columns', () => {
    const walkIns = rows.filter(r => r.bucket === 'walk_in')
    expect(walkIns.map(r => r.resolved_person_id).sort()).toEqual([person.W1, person.W2].sort())
    for (const w of walkIns) {
      expect(w).toMatchObject({ rsvp_id: null, rsvp_status: null, children_count: null, matched_at_submit: false, attended: true })
      expect(w.attendance_id).not.toBeNull()
    }
  })

  it('(i) newcomer later registered at the door: resolved via phone, attended, matched_at_submit false', () => {
    const n1 = rows.find(r => r.rsvp_id === rsvp.N1)!
    expect(n1).toMatchObject({ resolved_person_id: person.N1P, attended: true, matched_at_submit: false })
    // and N1P is therefore NOT also a walk-in
    expect(rows.filter(r => r.resolved_person_id === person.N1P)).toHaveLength(1)
  })

  it('(ii) member whose phone changed after RSVP still resolves via person_id', () => {
    expect(rows.find(r => r.rsvp_id === rsvp.M3)).toMatchObject({ resolved_person_id: person.M3, matched_at_submit: true, attended: true })
  })

  it('(iii) NULL phone + NULL person_id RSVP is a row, unresolved', () => {
    expect(rows.find(r => r.rsvp_id === rsvp.X)).toMatchObject({ resolved_person_id: null, attended: false, rsvp_status: 'not_coming' })
  })

  it('instance without a link but with check-ins -> zero view rows', async () => {
    const { data, error } = await adminSession.from('rsvp_checkin_crosstab').select('*').eq('event_instance_id', inst.IB)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})

describe('rsvp_checkin_crosstab — access', () => {
  it('admin session -> rows', async () => {
    const { data, error } = await adminSession.from('rsvp_checkin_crosstab').select('rsvp_id').eq('event_instance_id', inst.IA)
    expect(error).toBeNull()
    expect(data).toHaveLength(10)
  })

  it('organizer session -> 0 rows, no error (even though organizers can read attendance)', async () => {
    const { data, error } = await organizerSession.from('rsvp_checkin_crosstab').select('rsvp_id').eq('event_instance_id', inst.IA)
    expect(error).toBeNull()
    expect(data).toEqual([])
    const att = await organizerSession.from('attendance').select('id').eq('event_instance_id', inst.IA)
    expect(att.data?.length).toBe(6)
  })

  it('anon -> permission error', async () => {
    const { data, error } = await anonSession.from('rsvp_checkin_crosstab').select('rsvp_id').limit(1)
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

// ── panel ────────────────────────────────────────────────────────────────────

describe('impl_getInstanceRsvpPanel', () => {
  it('totals, buckets and children check — hand-computed, exact', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
    const { panel } = result
    expect(panel.totals).toEqual({
      responses: 8,
      coming_people: 4,
      coming_headcount: 7,
      coming_children: 3,
      maybe_people: 2,
      maybe_headcount: 3,
      not_coming_people: 2,
    })
    expect(panel.buckets).toEqual({
      coming_came: 2,
      coming_no_show: 2,
      maybe_came: 1,
      maybe_no_show: 1,
      not_coming_came: 1,
      not_coming_no_show: 1,
      walk_in: 2,
    })
    // 3 child_attendance rows at IA; KD (soft-deleted child) is excluded.
    expect(panel.children).toEqual({ expected: 3, checked_in: 2 })
    expect(panel.publicEnabled).toBe(true)
    expect(panel.link.active).toBe(true)
    expect(panel.link.url).toMatch(new RegExp(`^${APP_URL}/rsvp/[A-Za-z0-9_-]{32}$`))
  })

  it('rows follow the display rules; phones masked; no full phone anywhere', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
    const byId = new Map(result.panel.rows.map(r => [r.rsvp_id, r]))
    expect(result.panel.rows).toHaveLength(8)

    expect(byId.get(rsvp.M1)).toMatchObject({
      display_kind: 'member', display_name: '[SYNTH] R3 M1', status: 'coming',
      children_count: 2, followup_consent: true, phone_masked: '•••• 1001', attended: true,
    })
    // (i) resolved by phone to a live roster person -> member with roster name
    expect(byId.get(rsvp.N1)).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R3 N1P', attended: true })
    // (ii)
    expect(byId.get(rsvp.M3)).toMatchObject({ display_kind: 'member', display_name: '[SYNTH] R3 M3', phone_masked: '•••• 1004' })
    // newcomer, no submitted name
    expect(byId.get(rsvp.N2)).toMatchObject({ display_kind: 'newcomer', display_name: null, attended: false })
    // (iii)
    expect(byId.get(rsvp.X)).toMatchObject({ display_kind: 'newcomer', display_name: '[SYNTH] R3 No Phone', phone_masked: null })
    // (iv)
    expect(byId.get(rsvp.M5)).toMatchObject({ display_kind: 'removed_member', display_name: null, attended: false })

    const serialized = JSON.stringify(result.panel)
    for (const phone of ALL_PHONES) expect(serialized).not.toContain(phone)
  })

  it('children.checked_in equals the attendees list Children count (same filters)', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
    const attendees = await impl_getInstanceAttendees({ supabase: adminSession, instanceId: inst.IA })
    if (attendees.status !== 'ok') throw new Error(`attendees: ${attendees.status}`)
    expect(result.panel.children.checked_in).toBe(attendees.children.length)
    const { count } = await svc.from('child_attendance').select('id', { count: 'exact', head: true }).eq('event_instance_id', inst.IA)
    expect(count).toBe(3)
  })

  it('flag off -> publicEnabled false, link active but url null', async () => {
    setEnv('RSVP_PUBLIC_ENABLED', 'FALSE')
    const result = await impl_getInstanceRsvpPanel(inst.IA, adminSession)
    if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
    expect(result.panel.publicEnabled).toBe(false)
    expect(result.panel.link).toEqual({ active: true, url: null })
  })

  it('instance with no link and no RSVPs -> zeroed panel', async () => {
    const result = await impl_getInstanceRsvpPanel(inst.IB, adminSession)
    if (result.status !== 'ok') throw new Error(`panel: ${result.status}`)
    expect(result.panel.link).toEqual({ active: false, url: null })
    expect(result.panel.totals.responses).toBe(0)
    expect(Object.values(result.panel.buckets).every(n => n === 0)).toBe(true)
    expect(result.panel.rows).toEqual([])
  })
})

// ── link lifecycle ───────────────────────────────────────────────────────────

describe('impl_getOrCreateRsvpLink / impl_deactivateRsvpLink', () => {
  it('idempotent: same url twice, one link, one rsvp.link_create audit', async () => {
    const first = await impl_getOrCreateRsvpLink(inst.IS, adminSession)
    const second = await impl_getOrCreateRsvpLink(inst.IS, adminSession)
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error(`${first.status}/${second.status}`)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.url).toBe(first.url)
    expect(second.linkId).toBe(first.linkId)
    expect(first.url).toMatch(new RegExp(`^${APP_URL}/rsvp/[A-Za-z0-9_-]{32}$`))
    tokens.push(first.url.split('/').pop()!)
    expect(await activeLinkCount(inst.IS)).toBe(1)

    const audits = (await rsvpAudits('rsvp.link_create')).filter(a => a.details_json.instance_id === inst.IS)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ entity_type: 'event_rsvp_link', entity_id: first.linkId })
    expect(audits[0]!.details_json).toEqual({ instance_id: inst.IS, link_id: first.linkId })
  })

  it('deactivate then getOrCreate -> a new token', async () => {
    const before = await impl_getOrCreateRsvpLink(inst.IS, adminSession)
    if (before.status !== 'ok') throw new Error(before.status)

    const off = await impl_deactivateRsvpLink(inst.IS, adminSession)
    expect(off).toEqual({ status: 'ok', linkId: before.linkId })
    expect(await activeLinkCount(inst.IS)).toBe(0)

    const deactAudits = (await rsvpAudits('rsvp.link_deactivate')).filter(a => a.details_json.instance_id === inst.IS)
    expect(deactAudits.at(-1)!.details_json).toEqual({ instance_id: inst.IS, link_id: before.linkId })

    const after = await impl_getOrCreateRsvpLink(inst.IS, adminSession)
    if (after.status !== 'ok') throw new Error(after.status)
    expect(after.created).toBe(true)
    expect(after.linkId).not.toBe(before.linkId)
    expect(after.url).not.toBe(before.url)
    tokens.push(after.url.split('/').pop()!)
  })

  it('deactivate with no active link -> no_link, no audit', async () => {
    const n = (await rsvpAudits('rsvp.link_deactivate')).length
    expect(await impl_deactivateRsvpLink(inst.IM, adminSession)).toEqual({ status: 'no_link' })
    expect((await rsvpAudits('rsvp.link_deactivate')).length).toBe(n)
  })

  it.each([['false'], ['FALSE'], [''], [undefined]])('flag %j -> disabled, nothing inserted', async flag => {
    setEnv('RSVP_PUBLIC_ENABLED', flag)
    expect(await impl_getOrCreateRsvpLink(inst.IM, adminSession)).toEqual({ status: 'disabled' })
    expect(await activeLinkCount(inst.IM)).toBe(0)
  })

  it.each([['not a url'], ['ftp://app.example.com'], [''], [undefined]])('NEXT_PUBLIC_APP_URL %j -> misconfigured, nothing inserted', async appUrl => {
    setEnv('NEXT_PUBLIC_APP_URL', appUrl)
    expect(await impl_getOrCreateRsvpLink(inst.IM, adminSession)).toEqual({ status: 'misconfigured' })
    expect(await activeLinkCount(inst.IM)).toBe(0)
  })

  it('cancelled instance -> closed; completed instance -> closed; nothing inserted', async () => {
    expect(await impl_getOrCreateRsvpLink(inst.IC, adminSession)).toEqual({ status: 'closed' })
    expect(await activeLinkCount(inst.IC)).toBe(0)
    expect(await impl_getOrCreateRsvpLink(inst.IB, adminSession)).toEqual({ status: 'closed' })
  })

  it('unknown instance -> not_found; malformed id -> invalid_input', async () => {
    expect(await impl_getOrCreateRsvpLink(randomUUID(), adminSession)).toEqual({ status: 'not_found' })
    expect(await impl_getOrCreateRsvpLink('nope', adminSession)).toEqual({ status: 'invalid_input' })
  })
})

// ── deleteRsvp ───────────────────────────────────────────────────────────────

describe('impl_deleteRsvp', () => {
  it('removes the row and writes rsvp.delete {instance_id, status, was_matched}', async () => {
    expect(await impl_deleteRsvp(rsvp.D1, adminSession)).toEqual({ status: 'ok' })
    const { data } = await svc.from('event_rsvps').select('id').eq('id', rsvp.D1)
    expect(data).toEqual([])

    const audits = (await rsvpAudits('rsvp.delete')).filter(a => a.entity_id === rsvp.D1)
    expect(audits).toHaveLength(1)
    expect(audits[0]!.entity_type).toBe('event_rsvp')
    expect(audits[0]!.details_json).toEqual({ instance_id: inst.ID, status: 'maybe', was_matched: false })
  })

  it('already deleted / unknown -> not_found; malformed -> invalid_input', async () => {
    expect(await impl_deleteRsvp(rsvp.D1, adminSession)).toEqual({ status: 'not_found' })
    expect(await impl_deleteRsvp(randomUUID(), adminSession)).toEqual({ status: 'not_found' })
    expect(await impl_deleteRsvp('nope', adminSession)).toEqual({ status: 'invalid_input' })
  })
})

// ── authorization + audit hygiene ────────────────────────────────────────────

describe('authorization', () => {
  it.each([
    ['organizer', () => organizerSession],
    ['anon', () => anonSession],
  ])('%s -> not_authorized on all four actions, nothing changed', async (_label, session) => {
    const s = session()
    const linksBefore = await activeLinkCount(inst.IA)
    expect(await impl_getOrCreateRsvpLink(inst.IM, s)).toEqual({ status: 'not_authorized' })
    expect(await impl_deactivateRsvpLink(inst.IA, s)).toEqual({ status: 'not_authorized' })
    expect(await impl_getInstanceRsvpPanel(inst.IA, s)).toEqual({ status: 'not_authorized' })
    expect(await impl_deleteRsvp(rsvp.M1, s)).toEqual({ status: 'not_authorized' })

    expect(await activeLinkCount(inst.IM)).toBe(0)
    expect(await activeLinkCount(inst.IA)).toBe(linksBefore)
    const { data } = await svc.from('event_rsvps').select('id').eq('id', rsvp.M1)
    expect(data).toHaveLength(1)
  })
})

describe('audit hygiene', () => {
  it('no rsvp.* audit row carries a token, phone or name', async () => {
    const all = [
      ...(await rsvpAudits('rsvp.link_create')),
      ...(await rsvpAudits('rsvp.link_deactivate')),
      ...(await rsvpAudits('rsvp.delete')),
    ]
    expect(all.length).toBeGreaterThanOrEqual(4)
    const serialized = JSON.stringify(all)
    for (const tok of tokens) expect(serialized).not.toContain(tok)
    for (const phone of ALL_PHONES) expect(serialized).not.toContain(phone)
    expect(serialized).not.toContain('[SYNTH]')
  })
})
