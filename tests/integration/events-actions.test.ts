// Integration tests for Sprint 2 Task 5 — event server actions.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration applied (supabase db reset).
// Run: npm test -- events-actions

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { addDays } from 'date-fns'
import {
  impl_createEvent,
  impl_updateEvent,
  impl_cancelInstance,
  impl_listEvents,
  impl_listInstancesForEvent,
} from '@/lib/actions/events.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

// Distinct from existing tests (099 = sprint2-rls, 098 = materialize)
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000097'

let serviceAdmin: SupabaseClient
let adminSession: SupabaseClient   // real auth admin user signed in via anonKey
let organizerSession: SupabaseClient  // real auth organizer user signed in via anonKey

let adminUserId: string
let organizerUserId: string
let seedEvent1Id: string   // biweekly friday — created_by FAKE_ADMIN_ID
let seedEvent2Id: string   // monthly sunday  — created_by FAKE_ADMIN_ID
let seedInstanceId: string // first scheduled instance; reset in beforeEach

const SEED_EVENT1_NAME = 'ACT Test Project Day'
const SEED_EVENT2_NAME = 'ACT Test Tribe Connect'

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Seed fake admin into app_users (no auth.users entry needed — app_users.id has no FK there)
  await serviceAdmin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin@act-test.invalid',
      full_name: 'ACT Test Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  )

  const ts = Date.now()

  // Create real auth admin user
  const adminEmail = `act-admin-${ts}@test.invalid`
  const adminPass = `AdminPass-${ts}!`
  const { data: adminAuthData, error: adminAuthErr } = await serviceAdmin.auth.admin.createUser({
    email: adminEmail,
    password: adminPass,
    email_confirm: true,
  })
  if (adminAuthErr || !adminAuthData.user) throw new Error(`createUser (admin): ${adminAuthErr?.message}`)
  adminUserId = adminAuthData.user.id
  await serviceAdmin.from('app_users').insert({
    id: adminUserId,
    email: adminEmail,
    full_name: 'ACT Test Admin',
    role: 'admin',
    active: true,
  })
  adminSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: adminSignInErr } = await adminSession.auth.signInWithPassword({
    email: adminEmail,
    password: adminPass,
  })
  if (adminSignInErr) throw new Error(`admin sign-in: ${adminSignInErr.message}`)

  // Create real auth organizer user
  const orgEmail = `act-org-${ts}@test.invalid`
  const orgPass = `OrgPass-${ts}!`
  const { data: orgAuthData, error: orgAuthErr } = await serviceAdmin.auth.admin.createUser({
    email: orgEmail,
    password: orgPass,
    email_confirm: true,
  })
  if (orgAuthErr || !orgAuthData.user) throw new Error(`createUser (organizer): ${orgAuthErr?.message}`)
  organizerUserId = orgAuthData.user.id
  await serviceAdmin.from('app_users').insert({
    id: organizerUserId,
    email: orgEmail,
    full_name: 'ACT Test Organizer',
    role: 'organizer',
    active: true,
  })
  organizerSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: orgSignInErr } = await organizerSession.auth.signInWithPassword({
    email: orgEmail,
    password: orgPass,
  })
  if (orgSignInErr) throw new Error(`organizer sign-in: ${orgSignInErr.message}`)

  // Find or create seed events (idempotent — safe on re-run)
  const { data: ex1 } = await serviceAdmin
    .from('events')
    .select('id')
    .eq('name', SEED_EVENT1_NAME)
    .limit(1)
    .maybeSingle()
  if (ex1) {
    seedEvent1Id = (ex1 as { id: string }).id
  } else {
    const { data: e1, error: e1Err } = await serviceAdmin
      .from('events')
      .insert({
        name: SEED_EVENT1_NAME,
        event_type: 'friday_monthly',
        start_date: '2026-07-10',
        start_time: '18:00:00',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single()
    if (e1Err || !e1) throw new Error(`insert seed event1: ${e1Err?.message}`)
    seedEvent1Id = (e1 as { id: string }).id
  }

  const { data: ex2 } = await serviceAdmin
    .from('events')
    .select('id')
    .eq('name', SEED_EVENT2_NAME)
    .limit(1)
    .maybeSingle()
  if (ex2) {
    seedEvent2Id = (ex2 as { id: string }).id
  } else {
    const { data: e2, error: e2Err } = await serviceAdmin
      .from('events')
      .insert({
        name: SEED_EVENT2_NAME,
        event_type: 'sunday_monthly',
        start_date: '2026-07-05',
        start_time: '15:00:00',
        recurrence_rule: 'FREQ=MONTHLY;BYDAY=1SU',
        active: true,
        created_by: FAKE_ADMIN_ID,
      })
      .select('id')
      .single()
    if (e2Err || !e2) throw new Error(`insert seed event2: ${e2Err?.message}`)
    seedEvent2Id = (e2 as { id: string }).id
  }
}, 30_000)

afterAll(async () => {
  if (seedEvent1Id || seedEvent2Id) {
    await serviceAdmin
      .from('event_instances')
      .delete()
      .in('event_id', [seedEvent1Id, seedEvent2Id].filter(Boolean))
    await serviceAdmin
      .from('events')
      .delete()
      .in('id', [seedEvent1Id, seedEvent2Id].filter(Boolean))
  }
  if (adminUserId || organizerUserId) {
    // Delete events created by test users during ACT-01 / ACT-02
    await serviceAdmin
      .from('events')
      .delete()
      .in('created_by', [adminUserId, organizerUserId].filter(Boolean))
  }
  await serviceAdmin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
  if (adminUserId) {
    await serviceAdmin.from('app_users').delete().eq('id', adminUserId)
    await serviceAdmin.auth.admin.deleteUser(adminUserId)
  }
  if (organizerUserId) {
    await serviceAdmin.from('app_users').delete().eq('id', organizerUserId)
    await serviceAdmin.auth.admin.deleteUser(organizerUserId)
  }
}, 30_000)

beforeEach(async () => {
  // Delete all instances for seed events — fresh state per test
  await serviceAdmin
    .from('event_instances')
    .delete()
    .in('event_id', [seedEvent1Id, seedEvent2Id])

  // Delete events created by test users in any previous test
  if (adminUserId || organizerUserId) {
    await serviceAdmin
      .from('events')
      .delete()
      .in('created_by', [adminUserId, organizerUserId].filter(Boolean))
  }

  // Restore seed event state (name or active may have been mutated in ACT-05 / ACT-11)
  await serviceAdmin
    .from('events')
    .update({ name: SEED_EVENT1_NAME, active: true })
    .eq('id', seedEvent1Id)
  await serviceAdmin
    .from('events')
    .update({ name: SEED_EVENT2_NAME, active: true })
    .eq('id', seedEvent2Id)

  // Seed 3 scheduled instances for event1 (for cancelInstance and listInstances tests)
  const now = new Date()
  const { data: inserted, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert([
      {
        event_id: seedEvent1Id,
        scheduled_at: addDays(now, 7).toISOString(),
        event_name_snapshot: SEED_EVENT1_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: seedEvent1Id,
        scheduled_at: addDays(now, 21).toISOString(),
        event_name_snapshot: SEED_EVENT1_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: seedEvent1Id,
        scheduled_at: addDays(now, 35).toISOString(),
        event_name_snapshot: SEED_EVENT1_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])
    .select('id')
  if (instErr || !inserted) throw new Error(`beforeEach: insert seed instances: ${instErr?.message}`)
  seedInstanceId = (inserted as { id: string }[])[0].id

  // Seed 2 future instances for event2 (for listInstancesForEvent test)
  await serviceAdmin.from('event_instances').insert([
    {
      event_id: seedEvent2Id,
      scheduled_at: addDays(now, 14).toISOString(),
      event_name_snapshot: SEED_EVENT2_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    },
    {
      event_id: seedEvent2Id,
      scheduled_at: addDays(now, 45).toISOString(),
      event_name_snapshot: SEED_EVENT2_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    },
  ])
}, 20_000)

describe('event server actions', () => {
  // ── createEvent ──────────────────────────────────────────────────────────

  it('ACT-01: createEvent as admin — valid biweekly → ok, instances_created > 0, audit row written', async () => {
    const result = await impl_createEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: {
        name: 'ACT-01 Biweekly Event',
        event_type: 'friday_monthly',
        start_date: '2026-07-10',
        start_time: '18:00:00',
        recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.event_id).toBeTruthy()
    expect(result.instances_created).toBeGreaterThan(0)

    // Verify event row persisted
    const { data: eventRow } = await serviceAdmin
      .from('events')
      .select('id, name')
      .eq('id', result.event_id)
      .single()
    expect(eventRow).not.toBeNull()

    // Verify audit log
    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, entity_type, entity_id')
      .eq('entity_type', 'event')
      .eq('entity_id', result.event_id)
      .eq('action', 'event.create')
    expect((auditRows ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('ACT-02: createEvent as organizer → ok, created_by = organizer uid', async () => {
    const result = await impl_createEvent({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: {
        name: 'ACT-02 Organizer Adhoc Event',
        event_type: 'adhoc',
        start_date: '2026-09-01',
        start_time: '18:00:00',
      },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    const { data: eventRow } = await serviceAdmin
      .from('events')
      .select('id, created_by')
      .eq('id', result.event_id)
      .single()
    expect((eventRow as { id: string; created_by: string } | null)?.created_by).toBe(organizerUserId)
  })

  it('ACT-03: createEvent with invalid recurrence_rule → invalid_input, field = recurrence_rule, no event inserted', async () => {
    const targetName = 'ACT-03 Bad RRULE Event'

    const result = await impl_createEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: {
        name: targetName,
        event_type: 'friday_monthly',
        start_date: '2026-07-10',
        start_time: '18:00:00',
        recurrence_rule: 'GARBAGE',
      },
    })

    expect(result.status).toBe('invalid_input')
    if (result.status !== 'invalid_input') return
    expect(result.field).toBe('recurrence_rule')

    // Confirm no event was inserted
    const { count } = await serviceAdmin
      .from('events')
      .select('*', { count: 'exact', head: true })
      .eq('name', targetName)
    expect(count ?? 0).toBe(0)
  })

  it('ACT-04: createEvent with invalid start_date → invalid_input, field = start_date', async () => {
    const result = await impl_createEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: {
        name: 'ACT-04 Bad Date Event',
        event_type: 'adhoc',
        start_date: 'not-a-date',
        start_time: '18:00:00',
      },
    })

    expect(result.status).toBe('invalid_input')
    if (result.status !== 'invalid_input') return
    expect(result.field).toBe('start_date')
  })

  // ── updateEvent ──────────────────────────────────────────────────────────

  it('ACT-05: updateEvent as admin renames event → ok; snapshot UNCHANGED; audit row written', async () => {
    // Verify pre-update snapshot
    const { data: instsBefore } = await serviceAdmin
      .from('event_instances')
      .select('event_name_snapshot')
      .eq('event_id', seedEvent1Id)
    const snapshotBefore = (instsBefore as { event_name_snapshot: string }[] | null)?.[0]?.event_name_snapshot
    expect(snapshotBefore).toBe(SEED_EVENT1_NAME)

    const result = await impl_updateEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      eventId: seedEvent1Id,
      input: { name: 'ACT-05 Renamed Event' },
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // events.name updated
    const { data: eventRow } = await serviceAdmin
      .from('events')
      .select('name')
      .eq('id', seedEvent1Id)
      .single()
    expect((eventRow as { name: string } | null)?.name).toBe('ACT-05 Renamed Event')

    // event_name_snapshot on existing instances UNCHANGED (D3: no re-materialize)
    const { data: instsAfter } = await serviceAdmin
      .from('event_instances')
      .select('event_name_snapshot')
      .eq('event_id', seedEvent1Id)
    const snapshotsAfter = (instsAfter as { event_name_snapshot: string }[] | null)
      ?.map(r => r.event_name_snapshot)
    expect(snapshotsAfter?.every(s => s === SEED_EVENT1_NAME)).toBe(true)

    // Audit row
    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action')
      .eq('entity_type', 'event')
      .eq('entity_id', seedEvent1Id)
      .eq('action', 'event.update')
    expect((auditRows ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('ACT-06: updateEvent as organizer on any event → ok (RLS allows organizer to update any event)', async () => {
    const result = await impl_updateEvent({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      eventId: seedEvent1Id,
      input: { location: 'ACT-06 New Location' },
    })

    expect(result.status).toBe('ok')
  })

  it('ACT-07: updateEvent with non-existent id → not_found; no audit row written', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000000'

    const { count: auditBefore } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event')
      .eq('entity_id', nonExistentId)

    const result = await impl_updateEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      eventId: nonExistentId,
      input: { name: 'Ghost Event' },
    })

    expect(result.status).toBe('not_found')

    const { count: auditAfter } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event')
      .eq('entity_id', nonExistentId)
    expect(auditAfter ?? 0).toBe(auditBefore ?? 0)
  })

  it('ACT-13: updateEvent with invalid recurrence_rule → invalid_input, field = recurrence_rule', async () => {
    const result = await impl_updateEvent({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      eventId: seedEvent1Id,
      input: { recurrence_rule: 'GARBAGE' },
    })

    expect(result.status).toBe('invalid_input')
    if (result.status !== 'invalid_input') return
    expect(result.field).toBe('recurrence_rule')
  })

  // ── cancelInstance ────────────────────────────────────────────────────────

  it('ACT-08: cancelInstance as admin → ok; status = cancelled; notes set; audit row written', async () => {
    const reason = 'ACT-08 venue unavailable'

    const result = await impl_cancelInstance({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      instanceId: seedInstanceId,
      reason,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.instance_id).toBe(seedInstanceId)

    // Verify DB state
    const { data: inst } = await serviceAdmin
      .from('event_instances')
      .select('status, notes')
      .eq('id', seedInstanceId)
      .single()
    expect((inst as { status: string; notes: string } | null)?.status).toBe('cancelled')
    expect((inst as { status: string; notes: string } | null)?.notes).toBe(reason)

    // Audit row
    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action')
      .eq('entity_type', 'event_instance')
      .eq('entity_id', seedInstanceId)
      .eq('action', 'event_instance.cancel')
    expect((auditRows ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('ACT-09: cancelInstance as organizer → forbidden (silent-block disambiguated correctly)', async () => {
    // seedInstanceId is scheduled; organizer has no UPDATE policy on event_instances
    const result = await impl_cancelInstance({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      instanceId: seedInstanceId,
    })

    expect(result.status).toBe('forbidden')
  })

  it('ACT-10: cancelInstance on already-cancelled instance → already_cancelled; no new audit row', async () => {
    // Pre-cancel via service admin (bypasses RLS)
    await serviceAdmin
      .from('event_instances')
      .update({ status: 'cancelled' })
      .eq('id', seedInstanceId)

    const { count: auditBefore } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event_instance')
      .eq('entity_id', seedInstanceId)
      .eq('action', 'event_instance.cancel')

    const result = await impl_cancelInstance({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      instanceId: seedInstanceId,
    })

    expect(result.status).toBe('already_cancelled')

    const { count: auditAfter } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event_instance')
      .eq('entity_id', seedInstanceId)
      .eq('action', 'event_instance.cancel')
    expect(auditAfter ?? 0).toBe(auditBefore ?? 0)
  })

  it('ACT-14: cancelInstance on a completed instance as ADMIN → not_cancellable (state denial, not RLS denial); row unchanged by row-count proof, no audit row', async () => {
    // Admin has full RLS grant (event_instances_admin_all is FOR ALL) — this proves
    // the app-level status guard itself, not RLS, is what blocks a completed instance.
    await serviceAdmin.from('event_instances').update({ status: 'completed' }).eq('id', seedInstanceId)

    const { count: auditBefore } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event_instance')
      .eq('entity_id', seedInstanceId)
      .eq('action', 'event_instance.cancel')

    const result = await impl_cancelInstance({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      instanceId: seedInstanceId,
    })

    expect(result).toEqual({ status: 'not_cancellable', current_status: 'completed' })

    // Row-count proof, not absence-of-error: re-fetch via admin client and confirm
    // the UPDATE touched zero rows — status is still 'completed', not 'cancelled'.
    const { data: inst } = await serviceAdmin
      .from('event_instances')
      .select('status')
      .eq('id', seedInstanceId)
      .single()
    expect((inst as { status: string } | null)?.status).toBe('completed')

    const { count: auditAfter } = await serviceAdmin
      .from('audit_log')
      .select('*', { count: 'exact', head: true })
      .eq('entity_type', 'event_instance')
      .eq('entity_id', seedInstanceId)
      .eq('action', 'event_instance.cancel')
    expect(auditAfter ?? 0).toBe(auditBefore ?? 0)
  })

  // ── listEvents ────────────────────────────────────────────────────────────

  it('ACT-11: listEvents as organizer → ≥ 2 active events; active=false filter excludes active seed events', async () => {
    // Both seed events are active (restored in beforeEach)
    const allResult = await impl_listEvents({ supabase: organizerSession })

    expect(allResult.status).toBe('ok')
    if (allResult.status !== 'ok') return

    expect(allResult.events.length).toBeGreaterThanOrEqual(2)
    const allIds = allResult.events.map(e => e.id)
    expect(allIds).toContain(seedEvent1Id)
    expect(allIds).toContain(seedEvent2Id)

    // active=false filter: seed events (which are active) must NOT appear
    const inactiveResult = await impl_listEvents({
      supabase: organizerSession,
      filters: { active: false },
    })
    expect(inactiveResult.status).toBe('ok')
    if (inactiveResult.status !== 'ok') return

    const inactiveIds = inactiveResult.events.map(e => e.id)
    expect(inactiveIds).not.toContain(seedEvent1Id)
    expect(inactiveIds).not.toContain(seedEvent2Id)
  })

  // ── listInstancesForEvent ─────────────────────────────────────────────────

  it('ACT-12: listInstancesForEvent default range → ok, instances ordered ascending by scheduled_at', async () => {
    // seedEvent2 has 2 instances seeded in beforeEach (14d and 45d from now — within default range)
    const result = await impl_listInstancesForEvent({
      supabase: organizerSession,
      eventId: seedEvent2Id,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.instances.length).toBeGreaterThan(0)

    // Assert ascending order by scheduled_at
    const timestamps = result.instances.map(i => new Date(i.scheduled_at).getTime())
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1])
    }

    // All returned instances belong to the requested event
    expect(result.instances.every(i => i.event_id === seedEvent2Id)).toBe(true)
  })
})
