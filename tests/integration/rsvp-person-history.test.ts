// Integration tests for S9-R3b — impl_listPersonRsvpHistory (lib/rsvp/admin.impl.ts):
// a person's RSVPs read from rsvp_checkin_crosstab on the ADMIN session (the
// view is is_admin()-filtered — a service-role client would read zero rows).
// Runs against local Docker Supabase only.
//
// Synthetic fixture (phone space +62999009330xx — S9-R3b, unused elsewhere):
//   Event "[SYNTH] RH Event" / name_id "[SYNTH] RH Acara"; past instances carry
//   snapshot "[SYNTH] RH Snapshot EN" / "[SYNTH] RH Snapshot ID".
//   IA 2026-03-01 completed  — P RSVP via person_id, coming, 2 children; P checked in
//                              Q RSVP via person_id (must never appear for P)
//   IC 2026-04-01 cancelled  — P RSVP via person_id, maybe
//   IB 2026-05-01 completed  — newcomer RSVP with phone X (no person at submit);
//                              P's roster phone is changed to X afterwards ->
//                              resolves to P via phone
//                              + another newcomer (phone W, unregistered)
//   IF 2099-01-01 scheduled  — P RSVP via person_id, not_coming, 1 child (live name)
//   Expected for P, newest first: IF, IB, IC, IA.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'

vi.mock('server-only', () => ({}))

import { impl_listPersonRsvpHistory } from '@/lib/rsvp/admin.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const { hostname } = new URL(url)
if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
  throw new Error(
    `[rsvp-person-history.test.ts] NEXT_PUBLIC_SUPABASE_URL (${hostname}) is not local Docker. This suite ` +
      `creates/deletes auth users, people and RSVP rows — must run against local Docker only.`,
  )
}

const PHONES = {
  P_OLD: '+6299900933001',
  X:     '+6299900933002',   // newcomer's RSVP phone at IB, later P's roster phone
  Q:     '+6299900933003',
  W:     '+6299900933004',   // unregistered newcomer at IB
} as const
const EVENT_NAME = '[SYNTH] RH Event'
const EVENT_NAME_ID = '[SYNTH] RH Acara'
const SNAP_EN = '[SYNTH] RH Snapshot EN'
const SNAP_ID = '[SYNTH] RH Snapshot ID'

let svc: SupabaseClient
let anonSession: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string

const authUserIds: string[] = []
const peopleIds: string[] = []
let eventId: string
const inst = { IA: '', IB: '', IC: '', IF: '' }
const person = { P: '', Q: '' }
const rsvp = { PA: '', PB: '', PC: '', PF: '', QA: '', WB: '' }

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
): Promise<{ session: SupabaseClient; id: string }> {
  const email = `rh-${label}-${randomUUID()}@example.com`
  const pass = `Rh-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `[SYNTH] RH ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id }
}

async function insertPerson(label: string, phone: string): Promise<string> {
  const { data, error } = await svc.from('people')
    .insert({ phone_e164: phone, full_name: `[SYNTH] RH ${label}`, nickname: label })
    .select('id').single()
  if (error) throw new Error(`insert person ${label}: ${error.message}`)
  peopleIds.push(data.id)
  return data.id
}

async function insertInstanceWithLink(
  scheduledAt: string,
  status: 'scheduled' | 'completed' | 'cancelled',
): Promise<{ instanceId: string; linkId: string }> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: SNAP_EN, event_name_snapshot_id: SNAP_ID, status })
    .select('id')
    .single()
  if (error) throw new Error(`insert instance: ${error.message}`)
  const { data: link, error: lErr } = await svc.from('event_rsvp_links')
    .insert({ event_instance_id: data.id, created_by: adminId }).select('id').single()
  if (lErr) throw new Error(`insert link: ${lErr.message}`)
  return { instanceId: data.id, linkId: link.id }
}

async function insertRsvp(
  instanceId: string,
  linkId: string,
  r: { phone: string | null; personId: string | null; status: 'coming' | 'maybe' | 'not_coming'; children: number },
): Promise<string> {
  const { data, error } = await svc.from('event_rsvps').insert({
    event_instance_id: instanceId,
    link_id: linkId,
    phone_e164: r.phone,
    children_count: r.children,
    status: r.status,
    person_id: r.personId,
  }).select('id').single()
  if (error) throw new Error(`insert rsvp: ${error.message}`)
  return data.id
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anonSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session; adminId = admin.id
  organizerSession = (await createAppUserSession('organizer', 'organizer')).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME, name_id: EVENT_NAME_ID, event_type: 'adhoc',
    start_date: '2026-03-01', start_time: '18:00', recurrence_rule: null, created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  person.P = await insertPerson('P', PHONES.P_OLD)
  person.Q = await insertPerson('Q', PHONES.Q)

  const a = await insertInstanceWithLink('2026-03-01T11:00:00Z', 'completed')
  const c = await insertInstanceWithLink('2026-04-01T11:00:00Z', 'cancelled')
  const b = await insertInstanceWithLink('2026-05-01T11:00:00Z', 'completed')
  const f = await insertInstanceWithLink('2099-01-01T11:00:00Z', 'scheduled')
  inst.IA = a.instanceId; inst.IC = c.instanceId; inst.IB = b.instanceId; inst.IF = f.instanceId

  rsvp.PA = await insertRsvp(inst.IA, a.linkId, { phone: PHONES.P_OLD, personId: person.P, status: 'coming', children: 2 })
  rsvp.QA = await insertRsvp(inst.IA, a.linkId, { phone: PHONES.Q, personId: person.Q, status: 'maybe', children: 0 })
  rsvp.PC = await insertRsvp(inst.IC, c.linkId, { phone: PHONES.P_OLD, personId: person.P, status: 'maybe', children: 0 })
  rsvp.PB = await insertRsvp(inst.IB, b.linkId, { phone: PHONES.X, personId: null, status: 'coming', children: 0 })
  rsvp.WB = await insertRsvp(inst.IB, b.linkId, { phone: PHONES.W, personId: null, status: 'coming', children: 1 })
  rsvp.PF = await insertRsvp(inst.IF, f.linkId, { phone: PHONES.P_OLD, personId: person.P, status: 'not_coming', children: 1 })

  // After the IB RSVP: P's roster phone changes to X -> the IB newcomer RSVP now resolves to P.
  const { error: upErr } = await svc.from('people').update({ phone_e164: PHONES.X }).eq('id', person.P)
  if (upErr) throw new Error(`change P phone: ${upErr.message}`)

  const { error: aErr } = await svc.from('attendance')
    .insert({ person_id: person.P, event_instance_id: inst.IA, checked_in_by: adminId })
  if (aErr) throw new Error(`insert attendance: ${aErr.message}`)
}, 60_000)

afterAll(async () => {
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
    await svc.from('event_rsvps').delete().in('event_instance_id', instIds)
    await svc.from('event_rsvp_links').delete().in('event_instance_id', instIds)
    await svc.from('attendance').delete().in('event_instance_id', instIds)
    await svc.from('event_instances').delete().in('id', instIds)
  }
  if (eventId) await svc.from('events').delete().eq('id', eventId)
  if (peopleIds.length > 0) await svc.from('people').delete().in('id', peopleIds)
  if (authUserIds.length > 0) {
    await svc.from('audit_log').delete().in('actor_user_id', authUserIds)
    await svc.from('app_users').delete().in('id', authUserIds)
    for (const id of authUserIds) await svc.auth.admin.deleteUser(id)
  }
}, 60_000)

describe('impl_listPersonRsvpHistory', () => {
  it('P: RSVPs via person_id AND via later phone match, newest first, exact rows', async () => {
    const result = await impl_listPersonRsvpHistory(person.P, adminSession, 'en')
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.rows).toEqual([
      {
        rsvp_id: rsvp.PF, instance_id: inst.IF, event_id: eventId, scheduled_at: expect.any(String),
        instance_status: 'scheduled', display_name: EVENT_NAME, rsvp_status: 'not_coming', children_count: 1, attended: false,
      },
      {
        rsvp_id: rsvp.PB, instance_id: inst.IB, event_id: eventId, scheduled_at: expect.any(String),
        instance_status: 'completed', display_name: SNAP_EN, rsvp_status: 'coming', children_count: 0, attended: false,
      },
      {
        rsvp_id: rsvp.PC, instance_id: inst.IC, event_id: eventId, scheduled_at: expect.any(String),
        instance_status: 'cancelled', display_name: SNAP_EN, rsvp_status: 'maybe', children_count: 0, attended: false,
      },
      {
        rsvp_id: rsvp.PA, instance_id: inst.IA, event_id: eventId, scheduled_at: expect.any(String),
        instance_status: 'completed', display_name: SNAP_EN, rsvp_status: 'coming', children_count: 2, attended: true,
      },
    ])
    const times = result.rows.map(r => new Date(r.scheduled_at).getTime())
    expect([...times].sort((x, y) => y - x)).toEqual(times)
  })

  it('id locale -> Indonesian names (snapshot_id for past, live name_id for future)', async () => {
    const result = await impl_listPersonRsvpHistory(person.P, adminSession, 'id')
    if (result.status !== 'ok') throw new Error(result.status)
    expect(result.rows.map(r => r.display_name)).toEqual([EVENT_NAME_ID, SNAP_ID, SNAP_ID, SNAP_ID])
  })

  it("another person's RSVPs never appear; Q sees only Q's", async () => {
    const p = await impl_listPersonRsvpHistory(person.P, adminSession, 'en')
    if (p.status !== 'ok') throw new Error(p.status)
    const pIds = p.rows.map(r => r.rsvp_id)
    expect(pIds).not.toContain(rsvp.QA)
    expect(pIds).not.toContain(rsvp.WB)

    const q = await impl_listPersonRsvpHistory(person.Q, adminSession, 'en')
    if (q.status !== 'ok') throw new Error(q.status)
    expect(q.rows.map(r => r.rsvp_id)).toEqual([rsvp.QA])
  })

  it('no phone anywhere in the result', async () => {
    const result = await impl_listPersonRsvpHistory(person.P, adminSession, 'en')
    const serialized = JSON.stringify(result)
    for (const phone of Object.values(PHONES)) expect(serialized).not.toContain(phone)
  })

  it('person with no RSVPs -> ok, empty', async () => {
    expect(await impl_listPersonRsvpHistory(randomUUID(), adminSession, 'en')).toEqual({ status: 'ok', rows: [] })
  })

  it('malformed id -> invalid_input', async () => {
    expect(await impl_listPersonRsvpHistory('nope', adminSession, 'en')).toEqual({ status: 'invalid_input' })
  })

  it.each([
    ['organizer', () => organizerSession],
    ['anon', () => anonSession],
  ])('%s -> not_authorized', async (_label, session) => {
    expect(await impl_listPersonRsvpHistory(person.P, session(), 'en')).toEqual({ status: 'not_authorized' })
  })

  it('service-role client reads ZERO view rows (why every reader must use an admin session)', async () => {
    const { data, error } = await svc.from('rsvp_checkin_crosstab').select('rsvp_id').eq('resolved_person_id', person.P)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
