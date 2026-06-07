// Integration tests for Sprint 2 Task 2 RLS policies.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration must be applied (supabase db reset).
// Run: npm test -- sprint2-rls

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY'
  )
}

// Fake admin UUID — inserted into app_users only (no auth.users entry needed
// since admin client bypasses RLS and app_users.id has no FK to auth.users).
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000099'

let admin: SupabaseClient
let organizer: SupabaseClient
let anon: SupabaseClient

let organizerId: string
let personId: string
let testEvent1Id: string
let testEvent2Id: string
let instanceId: string
let organizerCreatedEventId: string | null = null  // created in T2-04, cleaned in afterAll

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Insert fake admin into app_users (created_by FK target for test events)
  await admin.from('app_users').upsert(
    { id: FAKE_ADMIN_ID, email: 'fake-admin@sprint2.test', full_name: 'Sprint2 Fake Admin', role: 'admin', active: true },
    { onConflict: 'id' }
  )

  // Create real auth user for organizer (email+password; email_confirm bypasses email flow)
  const ts = Date.now()
  const TEST_EMAIL = `sprint2-rls-${ts}@test.invalid`
  const TEST_PASS  = `Sprint2RLS-${ts}!`
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASS,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  organizerId = authData.user.id

  // Insert organizer into app_users
  const { error: appUserErr } = await admin.from('app_users').insert({
    id: organizerId,
    email: TEST_EMAIL,
    full_name: 'Sprint2 RLS Test Organizer',
    role: 'organizer',
    active: true,
  })
  if (appUserErr) throw new Error(`insert app_user: ${appUserErr.message}`)

  // Insert test person
  const { data: person, error: personErr } = await admin
    .from('people')
    .insert({ phone_e164: `+62811${ts.toString().slice(-7)}`, full_name: 'Sprint2 Test Person', nickname: 'TestP' })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person: ${personErr?.message}`)
  personId = person.id

  // Insert 2 test events (admin actor = FAKE_ADMIN_ID)
  const { data: ev1, error: ev1Err } = await admin
    .from('events')
    .insert({ name: 'Sprint2 Test Event Alpha', event_type: 'adhoc', start_date: '2026-08-01', start_time: '18:00:00', created_by: FAKE_ADMIN_ID })
    .select('id').single()
  if (ev1Err || !ev1) throw new Error(`insert event1: ${ev1Err?.message}`)
  testEvent1Id = ev1.id

  const { data: ev2, error: ev2Err } = await admin
    .from('events')
    .insert({ name: 'Sprint2 Test Event Beta', event_type: 'adhoc', start_date: '2026-08-08', start_time: '18:00:00', created_by: FAKE_ADMIN_ID })
    .select('id').single()
  if (ev2Err || !ev2) throw new Error(`insert event2: ${ev2Err?.message}`)
  testEvent2Id = ev2.id

  // Insert test event_instance (admin actor; both snapshot columns required)
  const { data: inst, error: instErr } = await admin
    .from('event_instances')
    .insert({
      event_id: testEvent1Id,
      scheduled_at: '2026-08-01T11:00:00Z',
      event_name_snapshot: 'Sprint2 Test Event Alpha',
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id').single()
  if (instErr || !inst) throw new Error(`insert event_instance: ${instErr?.message}`)
  instanceId = inst.id

  // Sign in as organizer to get an authenticated session
  organizer = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await organizer.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASS })
  if (signInErr) throw new Error(`organizer sign-in: ${signInErr.message}`)

  // Anon client — no session
  anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}, 30_000)

afterAll(async () => {
  if (organizerCreatedEventId) {
    await admin.from('events').delete().eq('id', organizerCreatedEventId)
  }
  await admin.from('attendance').delete().eq('event_instance_id', instanceId)
  await admin.from('event_instances').delete().eq('id', instanceId)
  await admin.from('events').delete().in('id', [testEvent1Id, testEvent2Id])
  await admin.from('people').delete().eq('id', personId)
  await admin.from('app_users').delete().eq('id', organizerId)
  await admin.auth.admin.deleteUser(organizerId)
  await admin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
}, 30_000)

// ── events ────────────────────────────────────────────────────

describe('events RLS', () => {
  it('T2-Seed-RLS-01: admin SELECT events returns ≥ 2 rows', async () => {
    const { data, error } = await admin.from('events').select('id')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(2)
  })

  it('T2-Seed-RLS-02: anon SELECT events returns 0 rows', async () => {
    const { data, error } = await anon.from('events').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('T2-Seed-RLS-03: organizer SELECT events returns ≥ 2 rows', async () => {
    const { data, error } = await organizer.from('events').select('id')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(2)
  })

  it('T2-Seed-RLS-04: organizer INSERT event with created_by = self.uid succeeds', async () => {
    const { data, error } = await organizer
      .from('events')
      .insert({ name: 'Organizer Own Event', event_type: 'adhoc', start_date: '2026-09-01', start_time: '18:00:00', created_by: organizerId })
      .select('id').single()
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    organizerCreatedEventId = data!.id
  })

  it('T2-Seed-RLS-05: organizer INSERT event with created_by = admin.uid fails (WITH CHECK)', async () => {
    const { data, error } = await organizer
      .from('events')
      .insert({ name: 'Spoofed Event', event_type: 'adhoc', start_date: '2026-09-02', start_time: '18:00:00', created_by: FAKE_ADMIN_ID })
      .select('id').single()
    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('T2-Seed-RLS-06: organizer DELETE event is silently blocked; row still exists', async () => {
    await organizer.from('events').delete().eq('id', testEvent1Id)
    const { data } = await admin.from('events').select('id').eq('id', testEvent1Id).single()
    expect(data).not.toBeNull()
  })
})

// ── event_instances ────────────────────────────────────────────

describe('event_instances RLS', () => {
  it('T2-Seed-RLS-07: organizer SELECT event_instances returns ≥ 1 row', async () => {
    const { data, error } = await organizer.from('event_instances').select('id')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('T2-Seed-RLS-08: organizer UPDATE event_instances is silently blocked; notes unchanged', async () => {
    await organizer.from('event_instances').update({ notes: 'hacked' }).eq('id', instanceId)
    const { data } = await admin.from('event_instances').select('notes').eq('id', instanceId).single()
    expect(data!.notes).toBeNull()
  })
})

// ── attendance ─────────────────────────────────────────────────

describe('attendance RLS', () => {
  it('T2-Seed-RLS-09: anon SELECT attendance returns 0 rows', async () => {
    const { data, error } = await anon.from('attendance').select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('T2-Seed-RLS-10: organizer INSERT attendance with checked_in_by = self.uid succeeds', async () => {
    const { data, error } = await organizer
      .from('attendance')
      .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: organizerId })
      .select('id').single()
    expect(error).toBeNull()
    expect(data).not.toBeNull()
  })

  it('T2-Seed-RLS-11: organizer INSERT attendance with checked_in_by = admin.uid fails (WITH CHECK)', async () => {
    // T2-10 record already exists; RLS WITH CHECK fires before unique constraint
    const { data, error } = await organizer
      .from('attendance')
      .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: FAKE_ADMIN_ID })
      .select('id').single()
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error!.code).not.toBe('23505')  // must be RLS rejection, not unique constraint
  })

  it('T2-Seed-RLS-12: admin INSERT duplicate attendance (same event_instance+person) fails with 23505', async () => {
    // T2-10 record exists: (instanceId, personId). Admin tries exact duplicate.
    const { error } = await admin
      .from('attendance')
      .insert({ event_instance_id: instanceId, person_id: personId, checked_in_by: FAKE_ADMIN_ID })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23505')
  })
})
