// Integration tests for Sprint 4 Task 3 — event_invitations RLS + ON CONFLICT.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint4_task3_event_invitations migration applied (supabase db reset).
// Run: npm test -- event-invitations-rls
//
// Asserts admin/organizer/anon access against the real policies, not a reading
// of the policy text. UPDATE/DELETE denials are asserted via a follow-up
// serviceAdmin SELECT (row-count / unchanged-state check), never via "no
// error" — RLS silently no-ops UPDATE/DELETE on rows outside USING() rather
// than raising. INSERT denial does raise (WITH CHECK failure), asserted the
// same way the Sprint 2 RLS suite asserts it.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { addDays } from 'date-fns'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

let serviceAdmin: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let anon: SupabaseClient

let adminId: string
let organizerId: string

let eventId: string
let instanceId: string
let person1Id: string
let person2Id: string

const EVENT_NAME = 'EINV Test Event'

async function createAppUser(
  label: string,
  ts: number,
  role: 'admin' | 'organizer',
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `einv-${label}-${ts}@test.invalid`
  const pass = `EinvPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `EINV Test ${label}`,
    role,
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

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  anon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const ts = Date.now()

  const admin = await createAppUser('admin', ts, 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUser('organizer', ts, 'organizer')
  organizerId = organizer.id
  organizerSession = organizer.session

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: EVENT_NAME,
      event_type: 'adhoc',
      start_date: '2026-09-01',
      start_time: '18:00:00',
      active: true,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = (ev as { id: string }).id

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: eventId,
      scheduled_at: addDays(new Date(), 5).toISOString(),
      event_name_snapshot: EVENT_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  instanceId = (inst as { id: string }).id

  const { data: p1, error: p1Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62897${ts.toString().slice(-7)}`,
      full_name: 'EINV Test Person One',
      nickname: 'EinvOne',
    })
    .select('id')
    .single()
  if (p1Err || !p1) throw new Error(`insert person1: ${p1Err?.message}`)
  person1Id = (p1 as { id: string }).id

  const { data: p2, error: p2Err } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62896${ts.toString().slice(-7)}`,
      full_name: 'EINV Test Person Two',
      nickname: 'EinvTwo',
    })
    .select('id')
    .single()
  if (p2Err || !p2) throw new Error(`insert person2: ${p2Err?.message}`)
  person2Id = (p2 as { id: string }).id
}, 30_000)

afterAll(async () => {
  // event_instance_id ON DELETE CASCADE cleans up event_invitations for free.
  if (instanceId) {
    await serviceAdmin.from('event_instances').delete().eq('id', instanceId)
  }
  if (eventId) {
    await serviceAdmin.from('events').delete().eq('id', eventId)
  }
  const personIds = [person1Id, person2Id].filter(Boolean)
  if (personIds.length) {
    await serviceAdmin.from('people').delete().in('id', personIds)
  }
  for (const userId of [adminId, organizerId].filter(Boolean)) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
}, 30_000)

beforeEach(async () => {
  // Fresh event_invitations state per test, scoped to this fixture's instance only.
  await serviceAdmin.from('event_invitations').delete().eq('event_instance_id', instanceId)
})

describe('event_invitations RLS', () => {
  it('EINV-01: admin INSERT succeeds; defaults applied (status=pending, rsvp_status/sent_at null)', async () => {
    const { data, error } = await adminSession
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
      .select('id, status, rsvp_status, sent_at')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].status).toBe('pending')
    expect(data![0].rsvp_status).toBeNull()
    expect(data![0].sent_at).toBeNull()
  })

  it('EINV-02: admin SELECT sees the row (served by admin_all, not filtered by organizer-only policy)', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    const { data, error } = await adminSession
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('EINV-03: organizer SELECT sees admin-created row', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    const { data, error } = await organizerSession
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('EINV-04: organizer INSERT fails (WITH CHECK) — errors, writes nothing', async () => {
    const { data, error } = await organizerSession
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: organizerId })
      .select('id')
      .single()
    expect(data).toBeNull()
    expect(error).not.toBeNull()

    const { data: checkData } = await serviceAdmin
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
    expect(checkData).toHaveLength(0)
  })

  it('EINV-05: organizer UPDATE is silently blocked; status unchanged on follow-up admin SELECT', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId, status: 'pending' })
    expect(insErr).toBeNull()

    await organizerSession
      .from('event_invitations')
      .update({ status: 'sent' })
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)

    const { data: checkData } = await serviceAdmin
      .from('event_invitations')
      .select('status')
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
      .single()
    expect(checkData!.status).toBe('pending')
  })

  it('EINV-06: organizer DELETE is silently blocked; row still exists on follow-up admin SELECT', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    await organizerSession
      .from('event_invitations')
      .delete()
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)

    const { data: checkData } = await serviceAdmin
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
    expect(checkData).toHaveLength(1)
  })

  it('EINV-07: anon SELECT returns 0 rows', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    const { data, error } = await anon.from('event_invitations').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('EINV-08: admin UPDATE succeeds, 1 row affected', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    const { data, error } = await adminSession
      .from('event_invitations')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
      .select('status, sent_at')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].status).toBe('sent')
    expect(data![0].sent_at).not.toBeNull()
  })

  it('EINV-09: admin DELETE succeeds, 1 row affected, gone on follow-up SELECT', async () => {
    const { error: insErr } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId })
    expect(insErr).toBeNull()

    const { data, error } = await adminSession
      .from('event_invitations')
      .delete()
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
      .select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)

    const { data: checkData } = await serviceAdmin
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
      .eq('person_id', person1Id)
    expect(checkData).toHaveLength(0)
  })

  it('EINV-10: status CHECK constraint rejects an invalid value', async () => {
    const { data, error } = await serviceAdmin
      .from('event_invitations')
      .insert({ event_instance_id: instanceId, person_id: person1Id, invited_by: adminId, status: 'bogus' })
      .select('id')
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/event_invitations_status_check|violates check constraint/i)
  })

  it('EINV-11: uniq_invite is a real UNIQUE constraint — ON CONFLICT DO NOTHING is a valid, race-safe upsert target', async () => {
    const { data: first, error: firstErr } = await serviceAdmin
      .from('event_invitations')
      .upsert(
        { event_instance_id: instanceId, person_id: person2Id, invited_by: adminId, status: 'sent' },
        { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true },
      )
      .select('id, status')
    expect(firstErr).toBeNull()
    expect(first).toHaveLength(1)
    const rowId = (first as { id: string; status: string }[])[0].id

    const { data: second, error: secondErr } = await serviceAdmin
      .from('event_invitations')
      .upsert(
        { event_instance_id: instanceId, person_id: person2Id, invited_by: adminId, status: 'failed' },
        { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true },
      )
      .select('id, status')
    expect(secondErr).toBeNull()
    expect(second).toHaveLength(0) // DO NOTHING — conflicting insert returns no row

    const { data: finalRow } = await serviceAdmin
      .from('event_invitations')
      .select('id, status')
      .eq('id', rowId)
      .single()
    expect(finalRow!.status).toBe('sent') // untouched by the second, conflicting upsert
  })
})
