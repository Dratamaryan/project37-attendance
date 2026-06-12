// Integration tests for Sprint 2 Task 8 — attendance server action.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration applied (supabase db reset).
// Run: npm test -- attendance-actions
//
// ATT-04 is the T2-10 acceptance criterion: Promise.all of two concurrent
// impl_createAttendance calls via two distinct organizer sessions must yield
// exactly one 'ok' and one 'already_checked_in' pointing at the same row.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { addDays } from 'date-fns'
import { impl_createAttendance } from '@/lib/actions/attendance.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

// Distinct from existing tests (099 = sprint2-rls, 098 = materialize, 097 = events-actions)
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000096'

const RANDOM_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let serviceAdmin: SupabaseClient
let org1Session: SupabaseClient      // organizer #1 — primary actor
let org2Session: SupabaseClient      // organizer #2 — the racer
let inactiveSession: SupabaseClient  // auth user with app_users.active = false

let org1Id: string
let org2Id: string
let inactiveUserId: string

let eventActiveId: string
let eventInactiveId: string
let instanceScheduledId: string  // active event, scheduled
let instanceCancelledId: string  // active event, cancelled
let instanceInactiveId: string   // inactive event, scheduled

let personActiveId: string
let personDeletedId: string

const EVENT_ACTIVE_NAME = 'ATT Test Active Event'
const EVENT_INACTIVE_NAME = 'ATT Test Inactive Event'

async function createOrganizer(
  label: string,
  ts: number,
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `att-${label}-${ts}@test.invalid`
  const pass = `AttPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `ATT Test ${label}`,
    role: 'organizer',
    active,
  })
  if (appUserErr) throw new Error(`insert app_user (${label}): ${appUserErr.message}`)
  const session = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Fake admin in app_users (created_by FK target; no auth.users row needed)
  await serviceAdmin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin@att-test.invalid',
      full_name: 'ATT Test Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  )

  const ts = Date.now()

  const org1 = await createOrganizer('org1', ts)
  org1Id = org1.id
  org1Session = org1.session

  const org2 = await createOrganizer('org2', ts)
  org2Id = org2.id
  org2Session = org2.session

  const inactive = await createOrganizer('inactive', ts, false)
  inactiveUserId = inactive.id
  inactiveSession = inactive.session

  // Active event + scheduled and cancelled instances
  const { data: ev1, error: ev1Err } = await serviceAdmin
    .from('events')
    .insert({
      name: EVENT_ACTIVE_NAME,
      event_type: 'adhoc',
      start_date: '2026-08-01',
      start_time: '18:00:00',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (ev1Err || !ev1) throw new Error(`insert active event: ${ev1Err?.message}`)
  eventActiveId = (ev1 as { id: string }).id

  const now = new Date()
  const { data: insts, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert([
      {
        event_id: eventActiveId,
        scheduled_at: addDays(now, 1).toISOString(),
        event_name_snapshot: EVENT_ACTIVE_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: eventActiveId,
        scheduled_at: addDays(now, 8).toISOString(),
        event_name_snapshot: EVENT_ACTIVE_NAME,
        event_name_snapshot_id: null,
        status: 'cancelled',
      },
    ])
    .select('id, status')
  if (instErr || !insts || insts.length !== 2) throw new Error(`insert instances: ${instErr?.message}`)
  const typedInsts = insts as { id: string; status: string }[]
  instanceScheduledId = typedInsts.find((i) => i.status === 'scheduled')!.id
  instanceCancelledId = typedInsts.find((i) => i.status === 'cancelled')!.id

  // Inactive event + scheduled instance
  const { data: ev2, error: ev2Err } = await serviceAdmin
    .from('events')
    .insert({
      name: EVENT_INACTIVE_NAME,
      event_type: 'adhoc',
      start_date: '2026-08-02',
      start_time: '18:00:00',
      active: false,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (ev2Err || !ev2) throw new Error(`insert inactive event: ${ev2Err?.message}`)
  eventInactiveId = (ev2 as { id: string }).id

  const { data: inst3, error: inst3Err } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: eventInactiveId,
      scheduled_at: addDays(now, 2).toISOString(),
      event_name_snapshot: EVENT_INACTIVE_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (inst3Err || !inst3) throw new Error(`insert inactive-event instance: ${inst3Err?.message}`)
  instanceInactiveId = (inst3 as { id: string }).id

  // One active person, one soft-deleted person
  const { data: p1, error: p1Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62899${ts.toString().slice(-7)}`,
      full_name: 'ATT Test Person Active',
      nickname: 'AttActive',
    })
    .select('id')
    .single()
  if (p1Err || !p1) throw new Error(`insert active person: ${p1Err?.message}`)
  personActiveId = (p1 as { id: string }).id

  const { data: p2, error: p2Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62898${ts.toString().slice(-7)}`,
      full_name: 'ATT Test Person Deleted',
      nickname: 'AttDeleted',
      deleted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (p2Err || !p2) throw new Error(`insert deleted person: ${p2Err?.message}`)
  personDeletedId = (p2 as { id: string }).id
}, 30_000)

afterAll(async () => {
  const instanceIds = [instanceScheduledId, instanceCancelledId, instanceInactiveId].filter(Boolean)
  if (instanceIds.length) {
    await serviceAdmin.from('attendance').delete().in('event_instance_id', instanceIds)
  }
  const eventIds = [eventActiveId, eventInactiveId].filter(Boolean)
  if (eventIds.length) {
    await serviceAdmin.from('event_instances').delete().in('event_id', eventIds)
    await serviceAdmin.from('events').delete().in('id', eventIds)
  }
  const personIds = [personActiveId, personDeletedId].filter(Boolean)
  if (personIds.length) {
    await serviceAdmin.from('people').delete().in('id', personIds)
  }
  for (const userId of [org1Id, org2Id, inactiveUserId].filter(Boolean)) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
  await serviceAdmin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
}, 30_000)

beforeEach(async () => {
  // Fresh attendance state per test. audit_log is append-only — assertions query
  // by entity_id instead of truncating shared log state.
  await serviceAdmin
    .from('attendance')
    .delete()
    .in('event_instance_id', [instanceScheduledId, instanceCancelledId, instanceInactiveId])
})

async function auditRowsFor(attendanceId: string) {
  const { data } = await serviceAdmin
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json')
    .eq('action', 'attendance.create')
    .eq('entity_id', attendanceId)
  return data ?? []
}

describe('attendance server action', () => {
  it('ATT-01: organizer happy path → ok; row + audit row written; checked_in_by = organizer uid', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.attendance.event_instance_id).toBe(instanceScheduledId)
    expect(result.attendance.person_id).toBe(personActiveId)
    expect(result.attendance.checked_in_by).toBe(org1Id)
    expect(result.attendance.source).toBe('volunteer_checkin')

    const { data: row } = await serviceAdmin
      .from('attendance')
      .select('id, checked_in_by, source')
      .eq('id', result.attendance.id)
      .single()
    expect(row).not.toBeNull()
    expect((row as { checked_in_by: string }).checked_in_by).toBe(org1Id)

    const audit = await auditRowsFor(result.attendance.id)
    expect(audit.length).toBe(1)
    expect(audit[0].actor_user_id).toBe(org1Id)
    expect(audit[0].entity_type).toBe('attendance')
    expect(audit[0].details_json).toMatchObject({
      person_id: personActiveId,
      event_instance_id: instanceScheduledId,
      source: 'volunteer_checkin',
    })
  })

  it('ATT-02: inactive app_user → forbidden; no attendance row (impl never accepts checked_in_by)', async () => {
    const result = await impl_createAttendance({
      supabase: inactiveSession,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('forbidden')

    const { data: rows } = await serviceAdmin
      .from('attendance')
      .select('id')
      .eq('event_instance_id', instanceScheduledId)
    expect(rows).toEqual([])
  })

  it('ATT-03: duplicate sequential → first ok, second already_checked_in with same id; single audit row', async () => {
    const first = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return

    const second = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(second.status).toBe('already_checked_in')
    if (second.status !== 'already_checked_in') return
    expect(second.existing.id).toBe(first.attendance.id)

    const audit = await auditRowsFor(first.attendance.id)
    expect(audit.length).toBe(1)
  })

  it('ATT-04 (T2-10 RACE): Promise.all of two concurrent calls → exactly one ok, one already_checked_in, same row — 3 runs', async () => {
    for (let run = 0; run < 3; run++) {
      await serviceAdmin
        .from('attendance')
        .delete()
        .eq('event_instance_id', instanceScheduledId)

      const input = { personId: personActiveId, eventInstanceId: instanceScheduledId }
      const [r1, r2] = await Promise.all([
        impl_createAttendance({ supabase: org1Session, adminSupabase: serviceAdmin, input }),
        impl_createAttendance({ supabase: org2Session, adminSupabase: serviceAdmin, input }),
      ])

      const statuses = [r1.status, r2.status].sort()
      expect(statuses, `run ${run}: got [${r1.status}, ${r2.status}]`).toEqual([
        'already_checked_in',
        'ok',
      ])

      const okResult = (r1.status === 'ok' ? r1 : r2) as Extract<typeof r1, { status: 'ok' }>
      const dupResult = (r1.status === 'already_checked_in' ? r1 : r2) as Extract<
        typeof r1,
        { status: 'already_checked_in' }
      >
      expect(dupResult.existing.id, `run ${run}`).toBe(okResult.attendance.id)

      // Exactly one row in the DB — no constraint leak
      const { data: rows } = await serviceAdmin
        .from('attendance')
        .select('id')
        .eq('event_instance_id', instanceScheduledId)
        .eq('person_id', personActiveId)
      expect(rows!.length, `run ${run}`).toBe(1)
    }
  }, 30_000)

  it('ATT-05: cancelled instance → event_cancelled; no attendance row, no audit', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceCancelledId },
    })
    expect(result.status).toBe('event_cancelled')

    const { data: rows } = await serviceAdmin
      .from('attendance')
      .select('id')
      .eq('event_instance_id', instanceCancelledId)
    expect(rows).toEqual([])
  })

  it('ATT-06: inactive event instance → event_inactive', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceInactiveId },
    })
    expect(result.status).toBe('event_inactive')
  })

  it('ATT-07: non-existent instance UUID → instance_not_found', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: RANDOM_UUID },
    })
    expect(result.status).toBe('instance_not_found')
  })

  it('ATT-08: non-existent person UUID → person_not_found', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: RANDOM_UUID, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('person_not_found')
  })

  it('ATT-09: soft-deleted person → person_soft_deleted (organizer session, RLS hides the row)', async () => {
    const result = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personDeletedId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('person_soft_deleted')
  })

  it('ATT-10: audit written on ok; NOT written again on already_checked_in', async () => {
    const first = await impl_createAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return

    const afterOk = await auditRowsFor(first.attendance.id)
    expect(afterOk.length).toBe(1)

    const second = await impl_createAttendance({
      supabase: org2Session,
      adminSupabase: serviceAdmin,
      input: { personId: personActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(second.status).toBe('already_checked_in')

    const afterDup = await auditRowsFor(first.attendance.id)
    expect(afterDup.length).toBe(1)
  })
})
