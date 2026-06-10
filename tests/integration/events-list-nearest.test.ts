// Integration tests for Sprint 2 Task 7 — listNearestInstances.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint2 migration applied (supabase db reset).
// Run: npm test -- events-list-nearest

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { addDays, subDays, addHours, subHours } from 'date-fns'
import { impl_listNearestInstances } from '@/lib/actions/events.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000096'

let serviceAdmin: SupabaseClient
let organizerSession: SupabaseClient

let organizerUserId: string
let activeEventId: string
let inactiveEventId: string

const ACTIVE_EVENT_NAME = 'NI Test Active Event'
const INACTIVE_EVENT_NAME = 'NI Test Inactive Event'

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  await serviceAdmin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin-ni@test.invalid',
      full_name: 'NI Test Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  )

  const ts = Date.now()

  // Create organizer user
  const orgEmail = `ni-org-${ts}@test.invalid`
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
    full_name: 'NI Test Organizer',
    role: 'organizer',
    active: true,
  })
  organizerSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: orgSignInErr } = await organizerSession.auth.signInWithPassword({
    email: orgEmail,
    password: orgPass,
  })
  if (orgSignInErr) throw new Error(`organizer sign-in: ${orgSignInErr.message}`)

  // Create active and inactive seed events
  const { data: e1, error: e1Err } = await serviceAdmin
    .from('events')
    .insert({
      name: ACTIVE_EVENT_NAME,
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '18:00:00',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (e1Err || !e1) throw new Error(`insert active event: ${e1Err?.message}`)
  activeEventId = (e1 as { id: string }).id

  const { data: e2, error: e2Err } = await serviceAdmin
    .from('events')
    .insert({
      name: INACTIVE_EVENT_NAME,
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '18:00:00',
      active: false,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (e2Err || !e2) throw new Error(`insert inactive event: ${e2Err?.message}`)
  inactiveEventId = (e2 as { id: string }).id
}, 30_000)

afterAll(async () => {
  if (activeEventId || inactiveEventId) {
    await serviceAdmin
      .from('event_instances')
      .delete()
      .in('event_id', [activeEventId, inactiveEventId].filter(Boolean))
    await serviceAdmin
      .from('events')
      .delete()
      .in('id', [activeEventId, inactiveEventId].filter(Boolean))
  }
  await serviceAdmin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
  if (organizerUserId) {
    await serviceAdmin.from('app_users').delete().eq('id', organizerUserId)
    await serviceAdmin.auth.admin.deleteUser(organizerUserId)
  }
}, 30_000)

beforeEach(async () => {
  await serviceAdmin
    .from('event_instances')
    .delete()
    .in('event_id', [activeEventId, inactiveEventId])
}, 10_000)

describe('listNearestInstances', () => {
  it('NEAR-01: 2 future instances within 30 days + 1 past within 1 day → returns 3 ordered nearest-first', async () => {
    const now = new Date()

    // future A: 2h from now (nearest)
    // future B: 10 days from now
    // past C: 6h ago (within 1-day window)
    await serviceAdmin.from('event_instances').insert([
      {
        event_id: activeEventId,
        scheduled_at: addHours(now, 2).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: activeEventId,
        scheduled_at: addDays(now, 10).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: activeEventId,
        scheduled_at: subHours(now, 6).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])

    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.instances.length).toBe(3)

    // Verify nearest-first ordering by abs time diff
    const nowMs = now.getTime()
    const diffs = result.instances.map((i) =>
      Math.abs(new Date(i.scheduled_at).getTime() - nowMs),
    )
    for (let i = 1; i < diffs.length; i++) {
      expect(diffs[i]).toBeGreaterThanOrEqual(diffs[i - 1])
    }

    // The nearest should be the 2h-future instance
    expect(Math.abs(new Date(result.instances[0].scheduled_at).getTime() - nowMs)).toBeLessThan(
      3 * 3_600_000,
    )
  })

  it('NEAR-02: Cancelled instance excluded', async () => {
    const now = new Date()

    await serviceAdmin.from('event_instances').insert([
      {
        event_id: activeEventId,
        scheduled_at: addDays(now, 1).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      {
        event_id: activeEventId,
        scheduled_at: addHours(now, 3).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'cancelled',
      },
    ])

    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.instances.length).toBe(1)
    expect(result.instances[0].status).toBe('scheduled')
  })

  it('NEAR-03: Inactive event instances excluded', async () => {
    const now = new Date()

    // Insert a scheduled instance for the INACTIVE event — must not appear
    await serviceAdmin.from('event_instances').insert([
      {
        event_id: inactiveEventId,
        scheduled_at: addHours(now, 1).toISOString(),
        event_name_snapshot: INACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])
    // Insert a scheduled instance for the ACTIVE event — must appear
    await serviceAdmin.from('event_instances').insert([
      {
        event_id: activeEventId,
        scheduled_at: addDays(now, 2).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])

    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    const ids = result.instances.map((i) => i.event_id)
    expect(ids).not.toContain(inactiveEventId)
    expect(ids).toContain(activeEventId)
  })

  it('NEAR-04: Past instance beyond 1-day window excluded', async () => {
    const now = new Date()

    // 2 days in the past → beyond the 1-day back window
    await serviceAdmin.from('event_instances').insert([
      {
        event_id: activeEventId,
        scheduled_at: subDays(now, 2).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      // Control: 12h ago (within 1-day window) — should appear
      {
        event_id: activeEventId,
        scheduled_at: subHours(now, 12).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])

    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // Only the 12h-ago instance should appear
    expect(result.instances.length).toBe(1)
    const diffMs = now.getTime() - new Date(result.instances[0].scheduled_at).getTime()
    // Should be roughly 12h (within 1-day window)
    expect(diffMs).toBeLessThan(24 * 3_600_000)
    expect(diffMs).toBeGreaterThan(0)
  })

  it('NEAR-05: Future instance beyond 30-day window excluded', async () => {
    const now = new Date()

    // 35 days in the future → beyond the 30-day forward window
    await serviceAdmin.from('event_instances').insert([
      {
        event_id: activeEventId,
        scheduled_at: addDays(now, 35).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
      // Control: 5 days from now (within 30-day window) — should appear
      {
        event_id: activeEventId,
        scheduled_at: addDays(now, 5).toISOString(),
        event_name_snapshot: ACTIVE_EVENT_NAME,
        event_name_snapshot_id: null,
        status: 'scheduled',
      },
    ])

    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.instances.length).toBe(1)
    const diffMs = new Date(result.instances[0].scheduled_at).getTime() - now.getTime()
    expect(diffMs).toBeLessThan(30 * 24 * 3_600_000)
    expect(diffMs).toBeGreaterThan(0)
  })

  it('NEAR-06: Empty result when no instances in window', async () => {
    // beforeEach already deleted all instances; no new ones inserted
    const result = await impl_listNearestInstances({ supabase: organizerSession })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    expect(result.instances).toEqual([])
  })
})
