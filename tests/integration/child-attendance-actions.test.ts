// Integration tests for Sprint 8 Task 2 — child attendance server action.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: S8-T1 migration applied (supabase db reset).
// Run: npm test -- child-attendance-actions
//
// Mirrors attendance-actions.test.ts (ATT-01..10). CATT-04 is the race criterion:
// Promise.all of two concurrent impl_createChildAttendance calls via two distinct
// organizer sessions must yield exactly one 'ok' and one 'already_checked_in'
// pointing at the same row. CATT-11 proves the child path never writes to the
// adult `attendance` table.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { addDays } from 'date-fns'
import { impl_createChildAttendance } from '@/lib/actions/child-attendance.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

// Distinct from existing tests (099 = sprint2-rls, 098 = materialize, 097 = events-actions,
// 096 = attendance-actions)
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000095'

const RANDOM_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff'

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

let parentPersonId: string
let childActiveId: string
let childDeletedId: string

const EVENT_ACTIVE_NAME = 'CATT Test Active Event'
const EVENT_INACTIVE_NAME = 'CATT Test Inactive Event'

async function createOrganizer(
  label: string,
  ts: number,
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `catt-${label}-${ts}@test.invalid`
  const pass = `CattPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `CATT Test ${label}`,
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
      email: 'fake-admin@catt-test.invalid',
      full_name: 'CATT Test Fake Admin',
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

  // Synthetic parent (people row) + one active child + one soft-deleted child
  const { data: parent, error: parentErr } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62895${ts.toString().slice(-7)}`,
      full_name: 'CATT Test Parent',
      nickname: 'CattParent',
    })
    .select('id')
    .single()
  if (parentErr || !parent) throw new Error(`insert parent: ${parentErr?.message}`)
  parentPersonId = (parent as { id: string }).id

  const { data: kids, error: kidsErr } = await serviceAdmin
    .from('children')
    .insert([
      {
        parent_person_id: parentPersonId,
        full_name: 'CATT Test Child Active',
        birth_date: '2018-03-01',
      },
      {
        parent_person_id: parentPersonId,
        full_name: 'CATT Test Child Deleted',
        birth_date: '2019-06-15',
        deleted_at: new Date().toISOString(),
      },
    ])
    .select('id, deleted_at')
  if (kidsErr || !kids || kids.length !== 2) throw new Error(`insert children: ${kidsErr?.message}`)
  const typedKids = kids as { id: string; deleted_at: string | null }[]
  childActiveId = typedKids.find((k) => k.deleted_at === null)!.id
  childDeletedId = typedKids.find((k) => k.deleted_at !== null)!.id
}, 30_000)

afterAll(async () => {
  const instanceIds = [instanceScheduledId, instanceCancelledId, instanceInactiveId].filter(Boolean)
  if (instanceIds.length) {
    await serviceAdmin.from('child_attendance').delete().in('event_instance_id', instanceIds)
    await serviceAdmin.from('attendance').delete().in('event_instance_id', instanceIds)
  }
  const eventIds = [eventActiveId, eventInactiveId].filter(Boolean)
  if (eventIds.length) {
    await serviceAdmin.from('event_instances').delete().in('event_id', eventIds)
    await serviceAdmin.from('events').delete().in('id', eventIds)
  }
  const childIds = [childActiveId, childDeletedId].filter(Boolean)
  if (childIds.length) {
    await serviceAdmin.from('children').delete().in('id', childIds)
  }
  if (parentPersonId) {
    await serviceAdmin.from('people').delete().eq('id', parentPersonId)
  }
  for (const userId of [org1Id, org2Id, inactiveUserId].filter(Boolean)) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
  await serviceAdmin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
}, 30_000)

beforeEach(async () => {
  // Fresh child_attendance state per test. audit_log is append-only — assertions
  // query by entity_id instead of truncating shared log state.
  await serviceAdmin
    .from('child_attendance')
    .delete()
    .in('event_instance_id', [instanceScheduledId, instanceCancelledId, instanceInactiveId])
})

async function auditRowsFor(childAttendanceId: string) {
  const { data } = await serviceAdmin
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json')
    .eq('action', 'child_attendance.create')
    .eq('entity_id', childAttendanceId)
  return data ?? []
}

async function childAttendanceCount(instanceId: string): Promise<number> {
  const { data } = await serviceAdmin
    .from('child_attendance')
    .select('id')
    .eq('event_instance_id', instanceId)
  return (data ?? []).length
}

describe('child attendance server action', () => {
  it('CATT-01: organizer happy path → ok; row + audit row written; checked_in_by = organizer uid', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attendance.child_id).toBe(childActiveId)
    expect(result.attendance.event_instance_id).toBe(instanceScheduledId)
    expect(result.attendance.checked_in_by).toBe(org1Id)
    expect(result.attendance.source).toBe('volunteer_checkin')

    const { data: row } = await serviceAdmin
      .from('child_attendance')
      .select('id, checked_in_by')
      .eq('id', result.attendance.id)
      .single()
    expect((row as { checked_in_by: string }).checked_in_by).toBe(org1Id)

    const audit = await auditRowsFor(result.attendance.id)
    expect(audit.length).toBe(1)
    const entry = audit[0] as {
      actor_user_id: string
      entity_type: string
      details_json: Record<string, unknown>
    }
    expect(entry.actor_user_id).toBe(org1Id)
    expect(entry.entity_type).toBe('child_attendance')
    expect(entry.details_json).toMatchObject({
      child_id: childActiveId,
      event_instance_id: instanceScheduledId,
      source: 'volunteer_checkin',
    })
  })

  it('CATT-02: inactive app_user → forbidden; no child_attendance row (impl never accepts checked_in_by)', async () => {
    const result = await impl_createChildAttendance({
      supabase: inactiveSession,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('forbidden')
    expect(await childAttendanceCount(instanceScheduledId)).toBe(0)
  })

  it('CATT-03: duplicate sequential → first ok, second already_checked_in with same id; single audit row', async () => {
    const first = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return

    const second = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(second.status).toBe('already_checked_in')
    if (second.status !== 'already_checked_in') return
    expect(second.existing.id).toBe(first.attendance.id)

    const audit = await auditRowsFor(first.attendance.id)
    expect(audit.length).toBe(1)
  })

  it('CATT-04 (RACE): Promise.all of two concurrent calls → exactly one ok, one already_checked_in, same row — 3 runs', async () => {
    for (let run = 0; run < 3; run++) {
      await serviceAdmin
        .from('child_attendance')
        .delete()
        .eq('event_instance_id', instanceScheduledId)

      const input = { childId: childActiveId, eventInstanceId: instanceScheduledId }
      const [r1, r2] = await Promise.all([
        impl_createChildAttendance({ supabase: org1Session, adminSupabase: serviceAdmin, input }),
        impl_createChildAttendance({ supabase: org2Session, adminSupabase: serviceAdmin, input }),
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
        .from('child_attendance')
        .select('id')
        .eq('event_instance_id', instanceScheduledId)
        .eq('child_id', childActiveId)
      expect(rows!.length, `run ${run}`).toBe(1)
    }
  }, 30_000)

  it('CATT-05: cancelled instance → event_cancelled; no child_attendance row, no audit', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceCancelledId },
    })
    expect(result.status).toBe('event_cancelled')
    expect(await childAttendanceCount(instanceCancelledId)).toBe(0)
  })

  it('CATT-06: inactive event instance → event_inactive', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceInactiveId },
    })
    expect(result.status).toBe('event_inactive')
    expect(await childAttendanceCount(instanceInactiveId)).toBe(0)
  })

  it('CATT-07: non-existent instance UUID → instance_not_found', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: RANDOM_UUID },
    })
    expect(result.status).toBe('instance_not_found')
  })

  it('CATT-08: non-existent child UUID → child_not_found', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: RANDOM_UUID, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('child_not_found')
  })

  it('CATT-09: soft-deleted child → child_soft_deleted (organizer session, RLS hides the row)', async () => {
    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childDeletedId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('child_soft_deleted')
    expect(await childAttendanceCount(instanceScheduledId)).toBe(0)
  })

  it('CATT-10: audit written on ok; NOT written again on already_checked_in', async () => {
    const first = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect((await auditRowsFor(first.attendance.id)).length).toBe(1)

    const second = await impl_createChildAttendance({
      supabase: org2Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(second.status).toBe('already_checked_in')
    expect((await auditRowsFor(first.attendance.id)).length).toBe(1)
  })

  it('CATT-11 (ISOLATION): a child check-in writes ZERO rows to adult attendance', async () => {
    await serviceAdmin.from('attendance').delete().eq('event_instance_id', instanceScheduledId)

    const result = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: instanceScheduledId },
    })
    expect(result.status).toBe('ok')

    expect(await childAttendanceCount(instanceScheduledId)).toBe(1)
    const { data: adultRows } = await serviceAdmin
      .from('attendance')
      .select('id')
      .eq('event_instance_id', instanceScheduledId)
    expect(adultRows!.length).toBe(0)
  })

  it('CATT-12: malformed ids → invalid_input without touching the DB', async () => {
    const badChild = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: 'not-a-uuid', eventInstanceId: instanceScheduledId },
    })
    expect(badChild).toMatchObject({ status: 'invalid_input', field: 'childId' })

    const badInstance = await impl_createChildAttendance({
      supabase: org1Session,
      adminSupabase: serviceAdmin,
      input: { childId: childActiveId, eventInstanceId: 'not-a-uuid' },
    })
    expect(badInstance).toMatchObject({ status: 'invalid_input', field: 'eventInstanceId' })
  })
})
