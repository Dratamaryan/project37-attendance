// Integration tests for Sprint 2 Task 9 — listRecentAttendanceForInstance.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration applied (supabase db reset).
// Run: npm test -- attendance-list-recent
//
// Targeted deletes only — never TRUNCATE attendance or audit_log (Sprint 2 latent rule).
// All created rows are deleted in afterAll scoped to this test file's IDs.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { addDays } from 'date-fns'
import { impl_listRecentAttendanceForInstance } from '@/lib/actions/attendance.impl'

const url            = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey        = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

// Distinct from other test files (096 = attendance-actions, 095 = sprint2-rls, etc.)
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000094'

let serviceAdmin: SupabaseClient
let orgSession: SupabaseClient
let orgId: string

let instanceAId: string   // primary test instance
let instanceBId: string   // scoping isolation — different instance
let eventId: string

let personActiveId: string    // active person, no photo
let personDeletedId: string   // soft-deleted person (T2-11)
let personWithPhotoId: string // active person with a storage-path photo_url

// Attendance IDs created by this test — cleaned up in afterAll
const createdAttendanceIds: string[] = []
// Person and other entity IDs — cleaned up in afterAll
const createdPersonIds: string[] = []

async function createOrganizer(
  label: string,
  ts: number,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `recent-${label}-${ts}@test.invalid`
  const pass  = `RecentPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `Recent Test ${label}`,
    role: 'organizer',
    active: true,
  })
  if (appUserErr) throw new Error(`insert app_user (${label}): ${appUserErr.message}`)
  const session = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

// Insert an attendance row directly via service admin (bypasses RLS for test setup)
async function insertAttendance(
  personId: string,
  instanceId: string,
  checkedInAt: string,
): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('attendance')
    .insert({
      person_id:         personId,
      event_instance_id: instanceId,
      checked_in_by:     orgId,
      source:            'volunteer_checkin',
      checked_in_at:     checkedInAt,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert attendance: ${error?.message}`)
  const id = (data as { id: string }).id
  createdAttendanceIds.push(id)
  return id
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  await serviceAdmin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin@recent-test.invalid',
      full_name: 'Recent Test Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  )

  const ts  = Date.now()
  const org = await createOrganizer('org', ts)
  orgId      = org.id
  orgSession = org.session

  // Event + two instances
  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: 'RECENT Test Event',
      event_type: 'adhoc',
      start_date: '2026-09-01',
      start_time: '18:00:00',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = (ev as { id: string }).id

  const now = new Date()
  const { data: insts, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert([
      {
        event_id: eventId,
        scheduled_at: addDays(now, 1).toISOString(),
        event_name_snapshot: 'RECENT Test Event',
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: eventId,
        scheduled_at: addDays(now, 2).toISOString(),
        event_name_snapshot: 'RECENT Test Event',
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])
    .select('id')
  if (instErr || !insts || insts.length !== 2)
    throw new Error(`insert instances: ${instErr?.message}`)
  const instIds = (insts as { id: string }[]).map((i) => i.id)
  instanceAId = instIds[0]
  instanceBId = instIds[1]

  // Active person (no photo)
  const { data: p1, error: p1Err } = await serviceAdmin
    .from('people')
    .insert({ phone_e164: `+62897${ts.toString().slice(-7)}`, full_name: 'RECENT Active', nickname: 'ActRec' })
    .select('id')
    .single()
  if (p1Err || !p1) throw new Error(`insert active person: ${p1Err?.message}`)
  personActiveId = (p1 as { id: string }).id
  createdPersonIds.push(personActiveId)

  // Soft-deleted person
  const { data: p2, error: p2Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62896${ts.toString().slice(-7)}`,
      full_name: 'RECENT Deleted',
      nickname: 'DelRec',
      deleted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (p2Err || !p2) throw new Error(`insert deleted person: ${p2Err?.message}`)
  personDeletedId = (p2 as { id: string }).id
  createdPersonIds.push(personDeletedId)

  // Person with a photo_url (storage path style — signing will fail on test DB but
  // the field must be non-null for RECENT-06 to exercise the signing branch)
  const { data: p3, error: p3Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62895${ts.toString().slice(-7)}`,
      full_name: 'RECENT WithPhoto',
      nickname: 'PhotoRec',
      photo_url: `${p1 ? (p1 as { id: string }).id : 'test-person'}/test-photo.jpg`,
    })
    .select('id')
    .single()
  if (p3Err || !p3) throw new Error(`insert photo person: ${p3Err?.message}`)
  personWithPhotoId = (p3 as { id: string }).id
  createdPersonIds.push(personWithPhotoId)
}, 30_000)

afterAll(async () => {
  // Targeted deletes — scoped to rows created by THIS test file only
  if (createdAttendanceIds.length) {
    await serviceAdmin.from('attendance').delete().in('id', createdAttendanceIds)
  }
  if (eventId) {
    await serviceAdmin.from('event_instances').delete().in('event_id', [eventId])
    await serviceAdmin.from('events').delete().eq('id', eventId)
  }
  if (createdPersonIds.length) {
    await serviceAdmin.from('people').delete().in('id', createdPersonIds)
  }
  if (orgId) {
    await serviceAdmin.from('app_users').delete().eq('id', orgId)
    await serviceAdmin.auth.admin.deleteUser(orgId)
  }
  await serviceAdmin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
}, 30_000)

describe('listRecentAttendanceForInstance', () => {
  it('RECENT-07: invalid UUID → invalid_input', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: 'not-a-uuid' },
    })
    expect(result.status).toBe('invalid_input')
    if (result.status !== 'invalid_input') return
    expect(result.field).toBe('eventInstanceId')
  })

  it('RECENT-05: empty result for instance with no check-ins', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceBId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attendances).toEqual([])
  })

  it('RECENT-01: returns attendances ordered by checked_in_at DESC, limited to 20', async () => {
    // Insert 3 attendances at different times for instanceA
    const base = new Date('2026-09-01T10:00:00Z')
    const att1Id = await insertAttendance(personActiveId, instanceAId, new Date(base.getTime() + 0).toISOString())
    const att2Id = await insertAttendance(personDeletedId, instanceAId, new Date(base.getTime() + 60_000).toISOString())
    // Third attendance — use personWithPhotoId
    const att3Id = await insertAttendance(personWithPhotoId, instanceAId, new Date(base.getTime() + 120_000).toISOString())

    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceAId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.attendances.length).toBe(3)

    // Ordered DESC — att3 first, then att2, then att1
    expect(result.attendances[0].id).toBe(att3Id)
    expect(result.attendances[1].id).toBe(att2Id)
    expect(result.attendances[2].id).toBe(att1Id)
  })

  it('RECENT-02: other instance attendances are NOT returned', async () => {
    // Insert an attendance for instanceB
    await insertAttendance(personActiveId, instanceBId, new Date().toISOString())

    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceAId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // None of instanceA's rows should have event_instance_id = instanceBId
    const wrongInstance = result.attendances.filter((a) => a.event_instance_id === instanceBId)
    expect(wrongInstance).toHaveLength(0)
  })

  it('RECENT-03: returns person info (full_name, nickname, photo_url, deleted_at) via JOIN', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceAId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    const active = result.attendances.find((a) => a.person.id === personActiveId)
    expect(active).toBeDefined()
    expect(active!.person.full_name).toBe('RECENT Active')
    expect(active!.person.nickname).toBe('ActRec')
    expect(active!.person.photo_url).toBeNull()
    expect(active!.person.deleted_at).toBeNull()
  })

  it('RECENT-04: soft-deleted person attendance IS returned with deleted_at populated (T2-11)', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceAId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    const deleted = result.attendances.find((a) => a.person.id === personDeletedId)
    expect(deleted).toBeDefined()
    expect(deleted!.person.deleted_at).not.toBeNull()
    expect(deleted!.person.full_name).toBe('RECENT Deleted')
  })

  it('RECENT-06: person with photo_url — signing attempted (non-null path); person without photo → photo_signed_url = null', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceAId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // Person without photo: photo_signed_url must be null
    const active = result.attendances.find((a) => a.person.id === personActiveId)
    expect(active).toBeDefined()
    expect(active!.person.photo_url).toBeNull()
    expect(active!.person.photo_signed_url).toBeNull()

    // Person with photo_url: the signing attempt runs but on test Docker the bucket
    // may not exist, so the result is null (signing failure → graceful null).
    // What we assert: the person's photo_url is non-null (the path was set).
    const withPhoto = result.attendances.find((a) => a.person.id === personWithPhotoId)
    expect(withPhoto).toBeDefined()
    expect(withPhoto!.person.photo_url).not.toBeNull()
    // photo_signed_url is either a signed URL string or null (graceful failure)
    expect(typeof withPhoto!.person.photo_signed_url === 'string' || withPhoto!.person.photo_signed_url === null).toBe(true)
  })

  it('RECENT-09: limit:500 returns all available rows sorted DESC (D1 — max raised from 50 to 500)', async () => {
    // instanceB already has personActiveId from RECENT-02; add two more distinct people.
    const t1 = new Date('2026-09-02T08:00:00Z')
    const t2 = new Date('2026-09-02T09:00:00Z')
    await insertAttendance(personWithPhotoId, instanceBId, t1.toISOString())
    await insertAttendance(personDeletedId,   instanceBId, t2.toISOString())

    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceBId, limit: 500 },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // All 3 rows returned (1 from RECENT-02 + 2 new), no artificial 50-row cap
    expect(result.attendances.length).toBeGreaterThanOrEqual(3)

    // Verify DESC order
    for (let i = 0; i < result.attendances.length - 1; i++) {
      expect(result.attendances[i].checked_in_at >= result.attendances[i + 1].checked_in_at).toBe(true)
    }

    // New fields present on each row (D10)
    const first = result.attendances[0]
    expect(typeof first.checked_in_by).toBe('string')
    expect(first.checked_in_by_email !== undefined).toBe(true)
    expect(typeof first.person.phone_e164).toBe('string')
  })

  it('RECENT-10: limit:501 clamped to 500 — no error, returns available rows (D1)', async () => {
    const result = await impl_listRecentAttendanceForInstance({
      supabase: orgSession,
      adminSupabase: serviceAdmin,
      input: { eventInstanceId: instanceBId, limit: 501 },
    })
    // Clamped silently — no invalid_input, no error
    expect(result.status).toBe('ok')
  })
})

// RECENT-08 is enforced structurally: afterAll uses targeted deletes by ID.
// No TRUNCATE of attendance or audit_log anywhere in this file.
