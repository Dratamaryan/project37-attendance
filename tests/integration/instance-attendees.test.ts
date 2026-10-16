// Integration tests for S8-T5 C2 — impl_getInstanceAttendees (organizer attendee
// list data layer). Runs against local Docker Supabase with REAL signed-in
// sessions, so RLS is what's being exercised (the impl never uses service role).
//
// Fixture (phone space +62999009109xx — S8-T5, unused by every other test file):
//   instances: I0 cancelled (Apr), I1 (May), I2 (Jun, the instance under test),
//              IO (another instance, Jun 2)
//   adults:    A  — first-ever attendance at I2            → first-timer at I2
//              B  — attended I1 then I2                    → not first-timer at I2, first-timer at I1
//              C  — attended cancelled I0, then I2         → first-timer at I2 (view ignores cancelled)
//              D  — soft-deleted, attended I2              → excluded for every role (D2)
//              X  — attended IO only                       → never in I2's list
//   children:  K1 (parent P, active)   at I2
//              K2 (soft-deleted child) at I2               → excluded
//              K3 (parent PD soft-deleted) at I2           → present, parent nulled
//              KO (parent P) at IO                         → never in I2's list

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import { requireActiveRole } from '../../lib/auth/require-admin'

vi.mock('server-only', () => ({}))

import { impl_getInstanceAttendees } from '../../lib/actions/instance-attendees.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[instance-attendees.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and people ` +
      `rows — must run against local Docker only.`,
  )
}

const PHONES = {
  A: '+62999009109001',
  B: '+62999009109002',
  C: '+62999009109003',
  D: '+62999009109004',
  X: '+62999009109005',
  P: '+62999009109010',
  PD: '+62999009109011',
} as const

const EVENT_NAME = 'IATT Test Event'

let svc: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let deactivatedSession: SupabaseClient
let adminId: string
let adminEmail: string

const authUserIds: string[] = []
const peopleIds: string[] = []
const childIds: string[] = []
let eventId: string
const inst = { I0: '', I1: '', I2: '', IO: '' }
const person: Record<keyof typeof PHONES, string> = { A: '', B: '', C: '', D: '', X: '', P: '', PD: '' }

async function createAppUserSession(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ session: SupabaseClient; id: string; email: string }> {
  const email = `iatt-${label}-${randomUUID()}@test.invalid`
  const pass = `Iatt-${label}-${Date.now()}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email, password: pass, email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.push(authData.user.id)

  // Insert active first so the sign-in works, then flip if needed.
  const { error: appErr } = await svc
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `IATT Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { session, id: authData.user.id, email }
}

async function insertPerson(key: keyof typeof PHONES, attrs: Record<string, unknown> = {}): Promise<void> {
  const { data, error } = await svc
    .from('people')
    .insert({ phone_e164: PHONES[key], full_name: `IATT Person ${key}`, nickname: `Nick${key}`, ...attrs })
    .select('id')
    .single()
  if (error) throw new Error(`insert person ${key}: ${error.message}`)
  person[key] = data.id
  peopleIds.push(data.id)
}

async function insertInstance(scheduledAt: string, status: string): Promise<string> {
  const { data, error } = await svc
    .from('event_instances')
    .insert({ event_id: eventId, scheduled_at: scheduledAt, event_name_snapshot: EVENT_NAME, event_name_snapshot_id: EVENT_NAME, status })
    .select('id')
    .single()
  if (error) throw new Error(`insert instance ${scheduledAt}: ${error.message}`)
  return data.id
}

async function insertChild(name: string, parentId: string, attrs: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await svc
    .from('children')
    .insert({ parent_person_id: parentId, full_name: name, ...attrs })
    .select('id')
    .single()
  if (error) throw new Error(`insert child ${name}: ${error.message}`)
  childIds.push(data.id)
  return data.id
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserSession('admin', 'admin')
  adminSession = admin.session
  adminId = admin.id
  adminEmail = admin.email
  organizerSession = (await createAppUserSession('organizer', 'organizer')).session
  deactivatedSession = (await createAppUserSession('deactivated', 'organizer', false)).session

  const { data: event, error: eErr } = await svc.from('events').insert({
    name: EVENT_NAME,
    name_id: EVENT_NAME,
    event_type: 'adhoc',
    start_date: '2026-04-01',
    start_time: '18:00',
    recurrence_rule: null,
    created_by: adminId,
  }).select('id').single()
  if (eErr) throw new Error(`insert event: ${eErr.message}`)
  eventId = event.id

  inst.I0 = await insertInstance('2026-04-01T11:00:00Z', 'cancelled')
  inst.I1 = await insertInstance('2026-05-01T11:00:00Z', 'completed')
  inst.I2 = await insertInstance('2026-06-01T11:00:00Z', 'completed')
  inst.IO = await insertInstance('2026-06-02T11:00:00Z', 'completed')

  await insertPerson('A')
  await insertPerson('B')
  await insertPerson('C')
  await insertPerson('D', { deleted_at: '2026-06-10T00:00:00Z' })
  await insertPerson('X')
  await insertPerson('P')
  await insertPerson('PD', { deleted_at: '2026-06-10T00:00:00Z' })

  const att = (p: string, i: string, at: string) =>
    ({ person_id: p, event_instance_id: i, checked_in_at: at, checked_in_by: adminId })
  const { error: aErr } = await svc.from('attendance').insert([
    att(person.B, inst.I1, '2026-05-01T11:10:00Z'),
    att(person.C, inst.I0, '2026-04-01T11:10:00Z'),
    att(person.A, inst.I2, '2026-06-01T11:05:00Z'),
    att(person.B, inst.I2, '2026-06-01T11:06:00Z'),
    att(person.C, inst.I2, '2026-06-01T11:07:00Z'),
    att(person.D, inst.I2, '2026-06-01T11:08:00Z'),
    att(person.X, inst.IO, '2026-06-02T11:05:00Z'),
  ])
  if (aErr) throw new Error(`insert attendance: ${aErr.message}`)

  const k1 = await insertChild('IATT Child K1', person.P)
  const k2 = await insertChild('IATT Child K2', person.P, { deleted_at: '2026-06-10T00:00:00Z' })
  const k3 = await insertChild('IATT Child K3', person.PD)
  const ko = await insertChild('IATT Child KO', person.P)

  const catt = (c: string, i: string, at: string) =>
    ({ child_id: c, event_instance_id: i, checked_in_at: at, checked_in_by: adminId })
  const { error: cErr } = await svc.from('child_attendance').insert([
    catt(k1, inst.I2, '2026-06-01T11:20:00Z'),
    catt(k2, inst.I2, '2026-06-01T11:21:00Z'),
    catt(k3, inst.I2, '2026-06-01T11:22:00Z'),
    catt(ko, inst.IO, '2026-06-02T11:20:00Z'),
  ])
  if (cErr) throw new Error(`insert child_attendance: ${cErr.message}`)
}, 60_000)

afterAll(async () => {
  if (!svc) return
  const instIds = Object.values(inst).filter(Boolean)
  if (instIds.length > 0) {
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

async function okResult(session: SupabaseClient, instanceId: string, includeCheckerEmail = false) {
  const result = await impl_getInstanceAttendees({ supabase: session, instanceId, includeCheckerEmail })
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`)
  return result
}

describe('guard + RLS: deactivated user', () => {
  it('requireActiveRole rejects a deactivated organizer', async () => {
    const res = await requireActiveRole(deactivatedSession, ['admin', 'organizer'])
    expect(res.status).toBe('denied')
  })

  it('defence in depth: the impl on a deactivated session sees no instance (RLS requires an active user)', async () => {
    const result = await impl_getInstanceAttendees({ supabase: deactivatedSession, instanceId: inst.I2 })
    expect(result.status).toBe('not_found')
  })

  it('active organizer and admin pass requireActiveRole', async () => {
    expect((await requireActiveRole(organizerSession, ['admin', 'organizer'])).status).toBe('ok')
    expect((await requireActiveRole(adminSession, ['admin', 'organizer'])).status).toBe('ok')
  })
})

describe('impl_getInstanceAttendees — adults', () => {
  it('organizer gets masked phones only; no full number anywhere in the result', async () => {
    const result = await okResult(organizerSession, inst.I2)
    expect(result.adults.length).toBeGreaterThan(0)
    for (const a of result.adults) expect(a.phone_masked).toMatch(/^•••• \d{4}$/)

    const serialized = JSON.stringify(result)
    for (const phone of Object.values(PHONES)) {
      expect(serialized).not.toContain(phone)
      expect(serialized).not.toContain(phone.slice(0, 8))
    }
    expect(result.adults.find(a => a.full_name === 'IATT Person A')!.phone_masked).toBe('•••• 9001')
  })

  it('only this instance, chronological; another instance\'s attendee is absent', async () => {
    const result = await okResult(organizerSession, inst.I2)
    expect(result.adults.map(a => a.full_name)).toEqual(['IATT Person A', 'IATT Person B', 'IATT Person C'])
    expect(result.instance).toMatchObject({ id: inst.I2, event_name_snapshot: EVENT_NAME, status: 'completed' })
  })

  it('first-timer: first-ever = yes, returning = no, cancelled-only history = yes (D6)', async () => {
    const atI2 = await okResult(organizerSession, inst.I2)
    const byName = (n: string) => atI2.adults.find(a => a.full_name === n)!
    expect(byName('IATT Person A').is_first_timer).toBe(true)
    expect(byName('IATT Person B').is_first_timer).toBe(false)
    expect(byName('IATT Person C').is_first_timer).toBe(true)

    const atI1 = await okResult(organizerSession, inst.I1)
    expect(atI1.adults.find(a => a.full_name === 'IATT Person B')!.is_first_timer).toBe(true)
  })

  it('organizer: soft-deleted adult excluded', async () => {
    const result = await okResult(organizerSession, inst.I2)
    expect(result.adults.find(a => a.full_name === 'IATT Person D')).toBeUndefined()
  })

  it('ADMIN session: soft-deleted adult is ALSO excluded (D2)', async () => {
    // Ground truth: the row exists and the admin can see the person via RLS.
    const { count } = await svc
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('event_instance_id', inst.I2)
      .eq('person_id', person.D)
    expect(count).toBe(1)
    const { data: visible } = await adminSession.from('people').select('id').eq('id', person.D)
    expect(visible).toHaveLength(1)

    const result = await okResult(adminSession, inst.I2)
    expect(result.adults.map(a => a.full_name)).toEqual(['IATT Person A', 'IATT Person B', 'IATT Person C'])
  })

  it('checker_email is null unless requested; admin + includeCheckerEmail resolves it', async () => {
    const plain = await okResult(adminSession, inst.I2)
    for (const a of plain.adults) expect(a.checker_email).toBeNull()

    const withEmail = await okResult(adminSession, inst.I2, true)
    for (const a of withEmail.adults) expect(a.checker_email).toBe(adminEmail)
  })
})

describe('impl_getInstanceAttendees — children section', () => {
  it('child with parent name + masked parent phone; soft-deleted child excluded; other instance excluded', async () => {
    const result = await okResult(organizerSession, inst.I2)
    expect(result.children.map(c => c.child_name)).toEqual(['IATT Child K1', 'IATT Child K3'])

    const k1 = result.children.find(c => c.child_name === 'IATT Child K1')!
    expect(k1.parent_name).toBe('IATT Person P')
    expect(k1.parent_phone_masked).toBe('•••• 9010')
  })

  it('child of a soft-deleted parent is listed with the parent nulled — same for organizer and admin', async () => {
    for (const session of [organizerSession, adminSession]) {
      const result = await okResult(session, inst.I2)
      const k3 = result.children.find(c => c.child_name === 'IATT Child K3')
      expect(k3).toBeDefined()
      expect(k3!.parent_name).toBeNull()
      expect(k3!.parent_phone_masked).toBeNull()
    }
  })

  it('admin sees exactly the same children as the organizer (D2)', async () => {
    const org = await okResult(organizerSession, inst.I2)
    const adm = await okResult(adminSession, inst.I2)
    expect(adm.children).toEqual(org.children)
  })
})

describe('impl_getInstanceAttendees — input handling', () => {
  it('malformed id -> invalid_input', async () => {
    expect((await impl_getInstanceAttendees({ supabase: organizerSession, instanceId: 'nope' })).status).toBe('invalid_input')
  })

  it('unknown id -> not_found', async () => {
    expect((await impl_getInstanceAttendees({ supabase: organizerSession, instanceId: randomUUID() })).status).toBe('not_found')
  })
})
