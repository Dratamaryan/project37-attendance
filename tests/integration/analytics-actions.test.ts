// Integration tests for Sprint 3 Task 4 — analytics data layer.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint3_analytics_views migration applied (supabase db reset).
// Run: npm test -- analytics-actions
//
// Isolation strategy:
//   The DB may have demo-seed and T2-fixture data. Tests that need absolute counts
//   use PARISH_A / PARISH_B (uniquely named 'AAT Test Parish …') so no other data
//   can collide. new_vs_returning_monthly has no parish filter, so only property-
//   based / directional assertions are used there.
//
// Fixture: phones in +62999009100xx (T4 space; T2 uses +62999009300xx).
//   P1–P5 same roles as T2. P6 null origin_parish (tests '(Unknown)' filter).
//   E1 friday_monthly: 3 instances (Jan/Feb=completed, Mar=cancelled)
//   E2 sunday_monthly: 2 instances (Jan=completed, Feb=zero-attendance)

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  impl_getKpiSummary,
  impl_getEventAttendanceTrend,
  impl_getParishBreakdown,
  impl_getTopAttendees,
  impl_getNewVsReturningMonthly,
} from '../../lib/actions/analytics.impl'
import { parseAnalyticsFilters } from '../../lib/actions/analytics.types'

const url        = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey    = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

// 091 is distinct from all existing FAKE_ADMIN_IDs:
// 093=analytics-views(T2), 094=attendance-list-recent, 096=attendance-actions,
// 097=events-actions, 098=events-materialize, 099=sprint2-rls
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000091'

const PHONES = {
  P1: '+62999009100011',
  P2: '+62999009100012',
  P3: '+62999009100013',
  P4: '+62999009100014', // soft-deleted
  P5: '+62999009100015', // zero-attendance active
  P6: '+62999009100016', // null origin_parish — tests '(Unknown)' filter
} as const

// Unique parish names — no other fixture/seed data uses these names
const PARISH_A = 'AAT Test Parish Alpha'
const PARISH_B = 'AAT Test Parish Beta'
// P6 has origin_parish = null → shown as '(Unknown)' in parish_breakdown

const E1_I1_SCHED = '2026-01-09T11:00:00Z'  // Jan  9 18:00 Jakarta — completed
const E1_I2_SCHED = '2026-02-13T11:00:00Z'  // Feb 13 18:00 Jakarta — completed
const E1_I3_SCHED = '2026-03-13T11:00:00Z'  // Mar 13 18:00 Jakarta — CANCELLED
const E2_I1_SCHED = '2026-01-04T08:00:00Z'  // Jan  4 15:00 Jakarta — completed
const E2_I2_SCHED = '2026-02-01T08:00:00Z'  // Feb  1 15:00 Jakarta — completed, ZERO attendance

// Check-in timestamps (UTC)
const P1_E1I1_AT = '2026-01-09T12:00:00Z'
const P1_E2I1_AT = '2026-01-04T09:00:00Z'
const P1_E1I2_AT = '2026-02-13T12:00:00Z'
const P2_E1I1_AT = '2026-01-09T12:10:00Z'
// TZ-edge: 2026-01-31T22:00Z = 2026-02-01T05:00+07 Jakarta → Feb Jakarta bucket
// checked_in_at is Jan 31 UTC, so it falls within a Jan UTC date filter (< 2026-02-01)
const P2_E1I2_AT = '2026-01-31T22:00:00Z'
const P2_E1I3_AT = '2026-03-13T12:00:00Z'   // cancelled instance
const P3_E2I1_AT = '2026-01-04T09:10:00Z'
const P4_E1I1_AT = '2026-01-09T12:20:00Z'   // soft-deleted person
const P6_E1I1_AT = '2026-01-09T12:30:00Z'   // null-parish person

let svc: SupabaseClient
let p1Id: string, p2Id: string, p3Id: string, p4Id: string, p5Id: string, p6Id: string
let e1Id: string, e2Id: string
let e1i1Id: string, e1i2Id: string, e1i3Id: string
let e2i1Id: string, e2i2Id: string
let orgAuthUserId: string
let orgClient: SupabaseClient

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function upsertPerson(phone: string, attrs: Record<string, unknown>): Promise<string> {
  const { data: ex } = await svc.from('people').select('id').eq('phone_e164', phone).maybeSingle()
  if (ex) return ex.id
  const { data, error } = await svc.from('people').insert({ phone_e164: phone, ...attrs }).select('id').single()
  if (error) throw new Error(`upsertPerson ${phone}: ${error.message}`)
  return data.id
}

async function upsertEvent(name: string, attrs: Record<string, unknown>): Promise<string> {
  const { data: ex } = await svc.from('events').select('id').eq('name', name).maybeSingle()
  if (ex) return ex.id
  const { data, error } = await svc.from('events').insert({ name, created_by: FAKE_ADMIN_ID, ...attrs }).select('id').single()
  if (error) throw new Error(`upsertEvent ${name}: ${error.message}`)
  return data.id
}

async function upsertInstance(eventId: string, scheduledAt: string, attrs: Record<string, unknown>): Promise<string> {
  const { data: ex } = await svc.from('event_instances').select('id').eq('event_id', eventId).eq('scheduled_at', scheduledAt).maybeSingle()
  if (ex) return ex.id
  const { data, error } = await svc.from('event_instances').insert({ event_id: eventId, scheduled_at: scheduledAt, ...attrs }).select('id').single()
  if (error) throw new Error(`upsertInstance ${scheduledAt}: ${error.message}`)
  return data.id
}

// ── Ground-truth helpers ──────────────────────────────────────────────────────
// These query base tables independently, applying the same filter semantics as
// the impl functions. Used to assert filter correctness, not view correctness.

/**
 * Counts non-cancelled, non-soft-deleted attendance (KPI semantics) from base tables.
 * Queries ALL attendance (not scoped to fixture IDs), so it's consistent with
 * impl_getKpiSummary when both are given the same filters.
 */
async function gtKpiCheckins(opts: {
  from?: string
  to?: string
  eventType?: string
  parish?: string
} = {}): Promise<number> {
  // Step 1: active people matching the parish filter
  let peopleQ = svc.from('people').select('id').is('deleted_at', null)
  if (opts.parish !== undefined) {
    if (opts.parish === '(Unknown)') {
      peopleQ = peopleQ.is('origin_parish', null)
    } else {
      peopleQ = peopleQ.eq('origin_parish', opts.parish)
    }
  }
  const { data: people } = await peopleQ
  const personIds = (people ?? []).map((p: { id: string }) => p.id)
  if (personIds.length === 0) return 0

  // Step 2: non-cancelled instances matching eventType filter
  let instQ = svc.from('event_instances').select('id').neq('status', 'cancelled')
  if (opts.eventType) {
    const { data: events } = await svc.from('events').select('id').eq('event_type', opts.eventType)
    const eventIds = (events ?? []).map((e: { id: string }) => e.id)
    if (eventIds.length === 0) return 0
    instQ = instQ.in('event_id', eventIds)
  }
  const { data: instances } = await instQ
  const instanceIds = (instances ?? []).map((i: { id: string }) => i.id)
  if (instanceIds.length === 0) return 0

  // Step 3: attendance matching both sets + date range
  let attQ = svc
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .in('person_id', personIds)
    .in('event_instance_id', instanceIds)
  if (opts.from !== undefined) attQ = attQ.gte('checked_in_at', opts.from)
  if (opts.to !== undefined) {
    const d = new Date(opts.to)
    d.setUTCDate(d.getUTCDate() + 1)
    attQ = attQ.lt('checked_in_at', d.toISOString().slice(0, 10))
  }
  const { count } = await attQ
  return count ?? 0
}

/** Count non-cancelled attendance rows for a specific instance (all persons). */
async function gtInstanceAttendeeCount(instanceId: string): Promise<number> {
  const { count } = await svc.from('attendance').select('id', { count: 'exact', head: true }).eq('event_instance_id', instanceId)
  return count ?? 0
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: existing } = await svc.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existing) {
    const { error } = await svc.from('app_users').insert({
      id: FAKE_ADMIN_ID,
      email: 'aat-test-admin-091@test.invalid',
      full_name: 'AAT Analytics Test Admin',
      role: 'admin',
      active: true,
    })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }

  p1Id = await upsertPerson(PHONES.P1, { full_name: 'AAT P1 Alpha',   nickname: 'P1', origin_parish: PARISH_A })
  p2Id = await upsertPerson(PHONES.P2, { full_name: 'AAT P2 Alpha',   nickname: 'P2', origin_parish: PARISH_A })
  p3Id = await upsertPerson(PHONES.P3, { full_name: 'AAT P3 Beta',    nickname: 'P3', origin_parish: PARISH_B })
  p4Id = await upsertPerson(PHONES.P4, { full_name: 'AAT P4 Deleted', nickname: 'P4', origin_parish: PARISH_A })
  p5Id = await upsertPerson(PHONES.P5, { full_name: 'AAT P5 Zero',    nickname: 'P5', origin_parish: PARISH_A })
  p6Id = await upsertPerson(PHONES.P6, { full_name: 'AAT P6 Unknown', nickname: 'P6', origin_parish: null })

  await svc.from('people').update({ deleted_at: '2026-04-01T00:00:00Z' }).eq('id', p4Id).is('deleted_at', null)

  e1Id = await upsertEvent('AAT Test Event Friday', {
    name_id:         'AAT Test Jumat',
    event_type:      'friday_monthly',
    start_date:      '2026-01-09',
    start_time:      '18:00',
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR',
  })
  e2Id = await upsertEvent('AAT Test Event Sunday', {
    name_id:         'AAT Test Minggu',
    event_type:      'sunday_monthly',
    start_date:      '2026-01-04',
    start_time:      '15:00',
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=1SU',
  })

  e1i1Id = await upsertInstance(e1Id, E1_I1_SCHED, { event_name_snapshot: 'AAT Test Event Friday', event_name_snapshot_id: 'AAT Test Jumat',  status: 'completed' })
  e1i2Id = await upsertInstance(e1Id, E1_I2_SCHED, { event_name_snapshot: 'AAT Test Event Friday', event_name_snapshot_id: 'AAT Test Jumat',  status: 'completed' })
  e1i3Id = await upsertInstance(e1Id, E1_I3_SCHED, { event_name_snapshot: 'AAT Test Event Friday', event_name_snapshot_id: 'AAT Test Jumat',  status: 'cancelled' })
  e2i1Id = await upsertInstance(e2Id, E2_I1_SCHED, { event_name_snapshot: 'AAT Test Event Sunday', event_name_snapshot_id: 'AAT Test Minggu', status: 'completed' })
  e2i2Id = await upsertInstance(e2Id, E2_I2_SCHED, { event_name_snapshot: 'AAT Test Event Sunday', event_name_snapshot_id: 'AAT Test Minggu', status: 'completed' })

  const { error: attErr } = await svc.from('attendance').upsert(
    [
      { event_instance_id: e1i1Id, person_id: p1Id, checked_in_at: P1_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e2i1Id, person_id: p1Id, checked_in_at: P1_E2I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i2Id, person_id: p1Id, checked_in_at: P1_E1I2_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p2Id, checked_in_at: P2_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i2Id, person_id: p2Id, checked_in_at: P2_E1I2_AT, checked_in_by: FAKE_ADMIN_ID }, // TZ-edge → Feb Jakarta bucket
      { event_instance_id: e1i3Id, person_id: p2Id, checked_in_at: P2_E1I3_AT, checked_in_by: FAKE_ADMIN_ID }, // cancelled instance
      { event_instance_id: e2i1Id, person_id: p3Id, checked_in_at: P3_E2I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p4Id, checked_in_at: P4_E1I1_AT, checked_in_by: FAKE_ADMIN_ID }, // soft-deleted person
      { event_instance_id: e1i1Id, person_id: p6Id, checked_in_at: P6_E1I1_AT, checked_in_by: FAKE_ADMIN_ID }, // null-parish person
    ],
    { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true },
  )
  if (attErr) throw new Error(`attendance upsert: ${attErr.message}`)

  // Organizer auth user for impl functions (security_invoker requires a session)
  const ts       = Date.now()
  const orgEmail = `aat-org-${ts}@test.invalid`
  const orgPass  = `AatOrg-${ts}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: orgEmail, password: orgPass, email_confirm: true,
  })
  if (authErr) throw new Error(`createUser: ${authErr.message}`)
  orgAuthUserId = authData.user.id

  const { error: appUserErr } = await svc.from('app_users').insert({
    id:        orgAuthUserId,
    email:     orgEmail,
    full_name: 'AAT Organizer',
    role:      'organizer',
    active:    true,
  })
  if (appUserErr) throw new Error(`app_users insert org: ${appUserErr.message}`)

  const tmpClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signIn, error: signInErr } = await tmpClient.auth.signInWithPassword({ email: orgEmail, password: orgPass })
  if (signInErr || !signIn.session) throw new Error(`signIn: ${signInErr?.message ?? 'no session'}`)

  orgClient = createClient(url, anonKey, {
    auth:   { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  })
})

afterAll(async () => {
  if (!svc) return
  const allInstIds   = [e1i1Id, e1i2Id, e1i3Id, e2i1Id, e2i2Id].filter(Boolean)
  const allEventIds  = [e1Id, e2Id].filter(Boolean)
  const allPersonIds = [p1Id, p2Id, p3Id, p4Id, p5Id, p6Id].filter(Boolean)

  if (allInstIds.length > 0) {
    await svc.from('attendance').delete().in('event_instance_id', allInstIds)
    await svc.from('event_instances').delete().in('id', allInstIds)
  }
  if (allEventIds.length > 0) await svc.from('events').delete().in('id', allEventIds)
  if (allPersonIds.length > 0) {
    await svc.from('people').update({ deleted_at: null }).in('id', allPersonIds)
    await svc.from('people').delete().in('id', allPersonIds)
  }
  if (orgAuthUserId) {
    await svc.from('app_users').delete().eq('id', orgAuthUserId)
    await svc.auth.admin.deleteUser(orgAuthUserId)
  }
  await svc.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
})

// ── parseAnalyticsFilters ─────────────────────────────────────────────────────

describe('parseAnalyticsFilters', () => {
  it('parses valid inputs correctly', () => {
    const result = parseAnalyticsFilters({
      from: '2026-01-01',
      to: '2026-03-31',
      eventType: 'friday_monthly',
      parish: 'Some Parish',
    })
    expect(result).toEqual({ from: '2026-01-01', to: '2026-03-31', eventType: 'friday_monthly', parish: 'Some Parish' })
  })

  it('strips array-valued params (hostile input)', () => {
    const result = parseAnalyticsFilters({
      from:      ['2026-01-01', '2026-02-01'],
      eventType: ['friday_monthly', 'adhoc'],
      parish:    ['A', 'B'],
    })
    expect(result.from).toBeUndefined()
    expect(result.eventType).toBeUndefined()
    expect(result.parish).toBeUndefined()
  })

  it('silently drops unknown eventType (bogus value)', () => {
    const result = parseAnalyticsFilters({ eventType: 'not_a_valid_type' })
    expect(result.eventType).toBeUndefined()
  })

  it('ignores unknown keys', () => {
    const result = parseAnalyticsFilters({
      from:       '2026-01-01',
      unknownKey: 'value',
    })
    expect(result).toEqual({ from: '2026-01-01' })
    expect(Object.keys(result)).not.toContain('unknownKey')
  })

  it('preserves parish string as-is (including empty string)', () => {
    const result = parseAnalyticsFilters({ parish: '' })
    expect(result.parish).toBe('')
  })
})

// ── getKpiSummary ─────────────────────────────────────────────────────────────
// Absolute-count tests use parish=PARISH_A to isolate from demo/T2 fixture data.
// PARISH_A = 'AAT Test Parish Alpha' is unique to this fixture.
//
// PARISH_A fixture facts:
//   Active: P1, P2, P5 (P4 deleted)
//   Non-cancelled non-deleted check-ins: P1(3) + P2(2) = 5
//   distinct_people with check-ins: 2 (P1, P2; P5 zero)
//   distinct_events: E1 + E2 = 2
//   distinct_instances: E1-I1, E1-I2, E2-I1 = 3

describe('getKpiSummary', () => {
  it('PARISH_A baseline: ground-truth total_checkins matches impl result', async () => {
    const filters = { parish: PARISH_A }
    const gt     = await gtKpiCheckins(filters)
    const result = await impl_getKpiSummary({ supabase: orgClient, filters })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.total_checkins).toBe(gt)
    expect(result.data.total_checkins).toBe(5) // P1(3) + P2(2)
  })

  it('P4 (soft-deleted) excluded from distinct_people (PARISH_A)', async () => {
    const result = await impl_getKpiSummary({ supabase: orgClient, filters: { parish: PARISH_A } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // PARISH_A people with check-ins: P1, P2 only (P4 deleted; P5 zero check-ins)
    expect(result.data.distinct_people).toBe(2)
  })

  it('distinct_events < distinct_instances (PARISH_A)', async () => {
    const result = await impl_getKpiSummary({ supabase: orgClient, filters: { parish: PARISH_A } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    // 2 event templates (E1, E2); 3 instances with PARISH_A attendance (E1-I1, E1-I2, E2-I1)
    expect(result.data.distinct_events).toBe(2)
    expect(result.data.distinct_instances).toBe(3)
    expect(result.data.distinct_events).toBeLessThan(result.data.distinct_instances)
  })

  it('PARISH_A + Jan date range: ground truth matches impl result', async () => {
    // Jan UTC: P1(E1-I1 Jan9 + E2-I1 Jan4) = 2; P2(E1-I1 Jan9 + E1-I2 TZ-edge Jan31T22Z) = 2 → 4
    const filters = { from: '2026-01-01', to: '2026-01-31', parish: PARISH_A }
    const gt     = await gtKpiCheckins(filters)
    const result = await impl_getKpiSummary({ supabase: orgClient, filters })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.total_checkins).toBe(gt)
    expect(result.data.total_checkins).toBe(4)
  })

  it('PARISH_A + friday_monthly: ground truth matches impl result', async () => {
    // E1 non-cancelled: E1-I1, E1-I2. PARISH_A people: P1(2) + P2(2) = 4
    const filters = { eventType: 'friday_monthly' as const, parish: PARISH_A }
    const gt     = await gtKpiCheckins(filters)
    const result = await impl_getKpiSummary({ supabase: orgClient, filters })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.total_checkins).toBe(gt)
    expect(result.data.total_checkins).toBe(4)
    expect(result.data.distinct_events).toBe(1)
  })

  it('parish=(Unknown): counts null-origin_parish people', async () => {
    const filters = { parish: '(Unknown)' }
    const gt     = await gtKpiCheckins(filters)
    const result = await impl_getKpiSummary({ supabase: orgClient, filters })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.total_checkins).toBe(gt)
    // P6 has null parish: 1 non-cancelled non-deleted check-in (from our fixture)
    expect(result.data.total_checkins).toBeGreaterThanOrEqual(1)
  })

  it('empty range (far future): ok:true, all-zero counts', async () => {
    const result = await impl_getKpiSummary({
      supabase: orgClient,
      filters:  { from: '2099-01-01', to: '2099-12-31', parish: PARISH_A },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.total_checkins).toBe(0)
    expect(result.data.distinct_people).toBe(0)
    expect(result.data.distinct_events).toBe(0)
    expect(result.data.distinct_instances).toBe(0)
  })

  it('invalid from date: returns invalid_filter', async () => {
    const result = await impl_getKpiSummary({ supabase: orgClient, filters: { from: 'not-a-date' } })
    expect(result.status).toBe('invalid_filter')
  })

  it('invalid eventType: returns invalid_filter', async () => {
    const result = await impl_getKpiSummary({
      supabase: orgClient,
      filters:  { eventType: 'bad_type' as 'friday_monthly' },
    })
    expect(result.status).toBe('invalid_filter')
  })
})

// ── getEventAttendanceTrend ───────────────────────────────────────────────────

describe('getEventAttendanceTrend', () => {
  it('baseline: fixture non-cancelled instances present with correct attendee_count', async () => {
    const result = await impl_getEventAttendanceTrend({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // Ground-truth per instance (includes soft-deleted P4 historically — view semantics)
    const nonCancelledIds = [e1i1Id, e1i2Id, e2i1Id, e2i2Id]
    for (const instId of nonCancelledIds) {
      const row = result.data.find(r => r.event_instance_id === instId)
      expect(row, `instance ${instId} should be in trend data`).toBeDefined()
      const gt = await gtInstanceAttendeeCount(instId)
      expect(row!.attendee_count, `attendee_count for ${instId}`).toBe(gt)
    }
  })

  it('E2-I2 (zero-attendance, non-cancelled) present with attendee_count=0', async () => {
    const result = await impl_getEventAttendanceTrend({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.event_instance_id === e2i2Id)
    expect(row).toBeDefined()
    expect(row!.attendee_count).toBe(0)
  })

  it('E1-I3 (cancelled) absent from results', async () => {
    const result = await impl_getEventAttendanceTrend({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => r.event_instance_id === e1i3Id)).toBeUndefined()
  })

  it('date range filter on scheduled_at (Jan only): Jan instances present, Feb absent', async () => {
    const result = await impl_getEventAttendanceTrend({
      supabase: orgClient,
      filters:  { from: '2026-01-01', to: '2026-01-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => r.event_instance_id === e1i1Id)).toBeDefined() // Jan 9
    expect(result.data.find(r => r.event_instance_id === e2i1Id)).toBeDefined() // Jan 4
    expect(result.data.find(r => r.event_instance_id === e1i2Id)).toBeUndefined() // Feb 13 — out of range
    expect(result.data.find(r => r.event_instance_id === e2i2Id)).toBeUndefined() // Feb 1  — out of range
  })

  it('eventType filter (friday_monthly): only E1 instances in fixture', async () => {
    const result = await impl_getEventAttendanceTrend({
      supabase: orgClient,
      filters:  { eventType: 'friday_monthly' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const fixRows = result.data.filter(r => [e1i1Id, e1i2Id, e2i1Id, e2i2Id].includes(r.event_instance_id))
    for (const row of fixRows) expect(row.event_type).toBe('friday_monthly')
    expect(result.data.find(r => r.event_instance_id === e2i1Id)).toBeUndefined()
    expect(result.data.find(r => r.event_instance_id === e2i2Id)).toBeUndefined()
  })

  it('parish filter ignored: result same fixture row count with and without parish', async () => {
    const withParish    = await impl_getEventAttendanceTrend({ supabase: orgClient, filters: { parish: PARISH_A } })
    const withoutParish = await impl_getEventAttendanceTrend({ supabase: orgClient, filters: {} })
    expect(withParish.status).toBe('ok')
    expect(withoutParish.status).toBe('ok')
    if (withParish.status !== 'ok' || withoutParish.status !== 'ok') return
    const fixtureIds = new Set([e1i1Id, e1i2Id, e2i1Id, e2i2Id])
    expect(withParish.data.filter(r => fixtureIds.has(r.event_instance_id)).length)
      .toBe(withoutParish.data.filter(r => fixtureIds.has(r.event_instance_id)).length)
  })

  it('empty range: ok:true, empty array', async () => {
    const result = await impl_getEventAttendanceTrend({
      supabase: orgClient,
      filters:  { from: '2099-01-01', to: '2099-12-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data).toHaveLength(0)
  })
})

// ── getParishBreakdown ────────────────────────────────────────────────────────

describe('getParishBreakdown', () => {
  it('PARISH_A people_count: ground truth matches view', async () => {
    const { count: gt } = await svc.from('people').select('id', { count: 'exact', head: true }).eq('origin_parish', PARISH_A).is('deleted_at', null)
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.parish === PARISH_A)
    expect(row).toBeDefined()
    expect(row!.people_count).toBe(gt) // P1, P2, P5 = 3
    expect(row!.people_count).toBe(3)
  })

  it('PARISH_A attendance_count=5 (P1:3 + P2:2, non-cancelled)', async () => {
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.parish === PARISH_A)
    expect(row).toBeDefined()
    expect(row!.attendance_count).toBe(5)
  })

  it('PARISH_B: people_count=1 (P3)', async () => {
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: {} })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.parish === PARISH_B)
    expect(row).toBeDefined()
    expect(row!.people_count).toBe(1)
  })

  it('parish filter: only target parish returned from fixture', async () => {
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: { parish: PARISH_B } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => r.parish === PARISH_A)).toBeUndefined()
    const rowB = result.data.find(r => r.parish === PARISH_B)
    expect(rowB).toBeDefined()
    expect(rowB!.people_count).toBe(1)
  })

  it('parish=(Unknown): row present and people_count ≥ 1 (P6 has null parish)', async () => {
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: { parish: '(Unknown)' } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.parish === '(Unknown)')
    expect(row).toBeDefined()
    expect(row!.people_count).toBeGreaterThanOrEqual(1)
  })

  it('date range filter ignored: PARISH_A people_count same with and without date', async () => {
    const withDate    = await impl_getParishBreakdown({ supabase: orgClient, filters: { from: '2026-01-01', to: '2026-01-31' } })
    const withoutDate = await impl_getParishBreakdown({ supabase: orgClient, filters: {} })
    expect(withDate.status).toBe('ok')
    expect(withoutDate.status).toBe('ok')
    if (withDate.status !== 'ok' || withoutDate.status !== 'ok') return
    expect(withDate.data.find(r => r.parish === PARISH_A)?.people_count)
      .toBe(withoutDate.data.find(r => r.parish === PARISH_A)?.people_count)
  })

  it('eventType filter ignored: PARISH_A people_count same with and without eventType', async () => {
    const withType    = await impl_getParishBreakdown({ supabase: orgClient, filters: { eventType: 'friday_monthly' } })
    const withoutType = await impl_getParishBreakdown({ supabase: orgClient, filters: {} })
    expect(withType.status).toBe('ok')
    expect(withoutType.status).toBe('ok')
    if (withType.status !== 'ok' || withoutType.status !== 'ok') return
    expect(withType.data.find(r => r.parish === PARISH_A)?.people_count)
      .toBe(withoutType.data.find(r => r.parish === PARISH_A)?.people_count)
  })

  it('no match: fixture parish absent from results', async () => {
    const result = await impl_getParishBreakdown({ supabase: orgClient, filters: { parish: 'AAT_NO_SUCH_PARISH_XYZ' } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => r.parish === 'AAT_NO_SUCH_PARISH_XYZ')).toBeUndefined()
  })
})

// ── getTopAttendees ───────────────────────────────────────────────────────────
// Use parish=PARISH_A to isolate from global DB ranking.
// PARISH_A active people: P1(3 check-ins), P2(2), P5(0)

describe('getTopAttendees', () => {
  it('PARISH_A: P1 at top with total_attendance=3, distinct_events=2', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: PARISH_A }, limit: 10 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const p1 = result.data.find(r => r.person_id === p1Id)
    expect(p1).toBeDefined()
    expect(p1!.total_attendance).toBe(3)
    expect(p1!.distinct_events).toBe(2) // E1 and E2
    expect(result.data.find(r => r.person_id === p4Id)).toBeUndefined() // P4 deleted
  })

  it('PARISH_A: sorted descending by total_attendance', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: PARISH_A }, limit: 10 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    for (let i = 0; i < result.data.length - 1; i++) {
      expect(result.data[i]!.total_attendance).toBeGreaterThanOrEqual(result.data[i + 1]!.total_attendance)
    }
  })

  it('PARISH_A: only PARISH_A people (no PARISH_B or null-parish people)', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: PARISH_A }, limit: 20 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => r.person_id === p3Id)).toBeUndefined() // PARISH_B
    expect(result.data.find(r => r.person_id === p6Id)).toBeUndefined() // null parish
    const fixRows = result.data.filter(r => [p1Id, p2Id, p5Id].includes(r.person_id))
    for (const row of fixRows) expect(row.origin_parish).toBe(PARISH_A)
  })

  it('parish=(Unknown): returns P6 (null origin_parish), not PARISH_A people', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: '(Unknown)' }, limit: 20 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const p6 = result.data.find(r => r.person_id === p6Id)
    expect(p6).toBeDefined()
    expect(p6!.origin_parish).toBeNull()
    expect(result.data.find(r => r.person_id === p1Id)).toBeUndefined()
  })

  it('limit=1: returns exactly 1 row', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: PARISH_A }, limit: 1 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.length).toBe(1)
    expect(result.data[0]!.person_id).toBe(p1Id) // P1 is top
  })

  it('unmatched parish: fixture people absent from results', async () => {
    const result = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: 'AAT_NO_SUCH_XYZ' }, limit: 20 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const fixPeople = [p1Id, p2Id, p3Id, p5Id, p6Id]
    expect(result.data.find(r => fixPeople.includes(r.person_id))).toBeUndefined()
  })

  it('date/eventType filters ignored: P1 total_attendance same with and without', async () => {
    const withFilters    = await impl_getTopAttendees({ supabase: orgClient, filters: { from: '2026-01-01', to: '2026-01-31', eventType: 'friday_monthly', parish: PARISH_A }, limit: 10 })
    const withoutFilters = await impl_getTopAttendees({ supabase: orgClient, filters: { parish: PARISH_A }, limit: 10 })
    expect(withFilters.status).toBe('ok')
    expect(withoutFilters.status).toBe('ok')
    if (withFilters.status !== 'ok' || withoutFilters.status !== 'ok') return
    expect(withFilters.data.find(r => r.person_id === p1Id)?.total_attendance)
      .toBe(withoutFilters.data.find(r => r.person_id === p1Id)?.total_attendance)
  })
})

// ── getNewVsReturningMonthly ──────────────────────────────────────────────────
// This view has no parish or eventType column — absolute counts cannot be isolated
// from other DB data. Tests focus on filter behavior (date range, ignore-by-design)
// and directional assertions that hold regardless of other data in the DB.
// Numerical correctness of the view's new/returning logic is covered by T2 (analytics-views.test.ts).

describe('getNewVsReturningMonthly', () => {
  it('date range filter: from=2026-02-01 → Jan row absent, Feb row present', async () => {
    const result = await impl_getNewVsReturningMonthly({
      supabase: orgClient,
      filters:  { from: '2026-02-01', to: '2026-02-28' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => String(r.month).startsWith('2026-01'))).toBeUndefined()
    expect(result.data.find(r => String(r.month).startsWith('2026-02'))).toBeDefined()
  })

  it('date range filter: to=2026-01-31 → Jan row present, Feb row absent', async () => {
    const result = await impl_getNewVsReturningMonthly({
      supabase: orgClient,
      filters:  { from: '2026-01-01', to: '2026-01-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.find(r => String(r.month).startsWith('2026-01'))).toBeDefined()
    expect(result.data.find(r => String(r.month).startsWith('2026-02'))).toBeUndefined()
  })

  it('empty range (far future): ok:true, empty array (not a throw)', async () => {
    const result = await impl_getNewVsReturningMonthly({
      supabase: orgClient,
      filters:  { from: '2099-01-01', to: '2099-12-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data).toHaveLength(0)
  })

  it('parish filter ignored: Jan row count same with and without parish', async () => {
    const withParish    = await impl_getNewVsReturningMonthly({ supabase: orgClient, filters: { parish: PARISH_A, from: '2026-01-01', to: '2026-01-31' } })
    const withoutParish = await impl_getNewVsReturningMonthly({ supabase: orgClient, filters: { from: '2026-01-01', to: '2026-01-31' } })
    expect(withParish.status).toBe('ok')
    expect(withoutParish.status).toBe('ok')
    if (withParish.status !== 'ok' || withoutParish.status !== 'ok') return
    const janWith    = withParish.data.find(r    => String(r.month).startsWith('2026-01'))
    const janWithout = withoutParish.data.find(r => String(r.month).startsWith('2026-01'))
    expect(janWith?.new_count).toBe(janWithout?.new_count)
  })

  it('eventType filter ignored: Jan row count same with and without eventType', async () => {
    const withType    = await impl_getNewVsReturningMonthly({ supabase: orgClient, filters: { eventType: 'friday_monthly', from: '2026-01-01', to: '2026-01-31' } })
    const withoutType = await impl_getNewVsReturningMonthly({ supabase: orgClient, filters: { from: '2026-01-01', to: '2026-01-31' } })
    expect(withType.status).toBe('ok')
    expect(withoutType.status).toBe('ok')
    if (withType.status !== 'ok' || withoutType.status !== 'ok') return
    const janWith    = withType.data.find(r    => String(r.month).startsWith('2026-01'))
    const janWithout = withoutType.data.find(r => String(r.month).startsWith('2026-01'))
    expect(janWith?.new_count).toBe(janWithout?.new_count)
  })

  it('Jan new_count > 0 (our fixture added new people in Jan)', async () => {
    const result = await impl_getNewVsReturningMonthly({
      supabase: orgClient,
      filters:  { from: '2026-01-01', to: '2026-01-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const janRow = result.data.find(r => String(r.month).startsWith('2026-01'))
    expect(janRow).toBeDefined()
    expect(janRow!.new_count).toBeGreaterThan(0)
    expect(janRow!.returning_count).toBe(0) // view invariant: no one can return before their first appearance
  })

  it('Feb returning_count > 0 (P1 and P2 return in Feb)', async () => {
    const result = await impl_getNewVsReturningMonthly({
      supabase: orgClient,
      filters:  { from: '2026-02-01', to: '2026-02-28' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const febRow = result.data.find(r => String(r.month).startsWith('2026-02'))
    expect(febRow).toBeDefined()
    expect(febRow!.returning_count).toBeGreaterThanOrEqual(2) // at least P1 and P2
  })
})
