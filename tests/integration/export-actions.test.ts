// Integration tests for Sprint 3 Task 6 — Excel export data layer.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint3_analytics_views migration applied (supabase db reset).
// Run: npm test -- export-actions (scoped run for iteration only — verify report
// requires the full `npm test`, per feedback_collab.md).
//
// Isolation strategy: mirrors analytics-actions.test.ts. Two independent fixture
// groups, each behind a uniquely-named parish so absolute-count assertions can't
// collide with demo-seed or other fixture data:
//   PARISH_X    — filter-correctness fixture (parish/date/eventType/cancelled/
//                 soft-delete/reconciliation)
//   PARISH_PAGE — dedicated pagination fixture (5 rows, tie-break on checked_in_at)
//
// Fixture: phones in +62999009102xx (T6 space — distinct from T4's 100xx and
// T2's 300xx). FAKE_ADMIN_ID suffix 100 (091/093/094/096/097/098/099 already used
// by other integration test files).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  impl_getRawAttendanceRows,
  getPersonAttendanceSummary,
  getEventAttendanceSummary,
} from '../../lib/actions/export.impl'
import type { RawAttendanceRow } from '../../lib/actions/export.types'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000100'

const PHONES = {
  P1: '+62999009102001', // active, PARISH_X
  P2: '+62999009102002', // active, PARISH_X
  P3: '+62999009102003', // soft-deleted, PARISH_X
  P4: '+62999009102004', // active, null origin_parish
  PZ1: '+62999009102011',
  PZ2: '+62999009102012',
  PZ3: '+62999009102013',
  PZ4: '+62999009102014',
  PZ5: '+62999009102015',
} as const

const PARISH_X = 'EXP Test Parish X'
const PARISH_PAGE = 'EXP Test Parish Page'

const E1_I1_SCHED = '2026-05-08T11:00:00Z' // Fri — completed
const E1_I2_SCHED = '2026-05-15T11:00:00Z' // Fri — CANCELLED
const E2_I1_SCHED = '2026-05-10T08:00:00Z' // Sun — completed
const E2_I2_SCHED = '2026-05-17T08:00:00Z' // Sun — completed, zero attendance

const P1_E1I1_AT = '2026-05-08T12:00:00Z'
const P1_E1I2_AT = '2026-05-15T12:00:00Z' // cancelled instance
const P1_E2I1_AT = '2026-05-10T09:00:00Z'
const P2_E1I1_AT = '2026-05-08T12:10:00Z'
const P3_E1I1_AT = '2026-05-08T12:20:00Z' // soft-deleted person
const P4_E1I1_AT = '2026-05-08T12:30:00Z' // null-parish person

// PARISH_PAGE fixture: 5 rows on one instance, two ties on checked_in_at to
// exercise the (checked_in_at, attendance_id) tie-break at a real page boundary.
const EZ_I1_SCHED = '2026-06-05T11:00:00Z'
const PZ_TIE_A = '2026-06-05T12:00:00Z' // PZ1, PZ2 share this timestamp
const PZ_TIE_B = '2026-06-05T12:05:00Z' // PZ3, PZ4 share this timestamp
const PZ_SOLO = '2026-06-05T12:10:00Z' // PZ5

let svc: SupabaseClient
let p1Id: string, p2Id: string, p3Id: string, p4Id: string
let pz1Id: string, pz2Id: string, pz3Id: string, pz4Id: string, pz5Id: string
let e1Id: string, e2Id: string, ezId: string
let e1i1Id: string, e1i2Id: string, e2i1Id: string, e2i2Id: string, ezi1Id: string
let sessionAuthUserId: string
let sessionClient: SupabaseClient

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

/**
 * Ground-truth row count from base tables — filter semantics identical to
 * impl_getRawAttendanceRows, EXCEPT: does NOT exclude cancelled instances or
 * soft-deleted people (export fidelity, locked T6 decision).
 */
async function gtRawRows(opts: {
  from?: string
  to?: string
  eventType?: string
  parish?: string
} = {}): Promise<string[]> {
  let peopleQ = svc.from('people').select('id')
  if (opts.parish !== undefined) {
    peopleQ = opts.parish === '(Unknown)' ? peopleQ.is('origin_parish', null) : peopleQ.eq('origin_parish', opts.parish)
  }
  const { data: people } = await peopleQ
  const personIds = (people ?? []).map((p: { id: string }) => p.id)
  if (personIds.length === 0) return []

  let instQ = svc.from('event_instances').select('id')
  if (opts.eventType) {
    const { data: events } = await svc.from('events').select('id').eq('event_type', opts.eventType)
    const eventIds = (events ?? []).map((e: { id: string }) => e.id)
    if (eventIds.length === 0) return []
    instQ = instQ.in('event_id', eventIds)
  }
  const { data: instances } = await instQ
  const instanceIds = (instances ?? []).map((i: { id: string }) => i.id)
  if (instanceIds.length === 0) return []

  let attQ = svc.from('attendance').select('id').in('person_id', personIds).in('event_instance_id', instanceIds)
  if (opts.from !== undefined) attQ = attQ.gte('checked_in_at', opts.from)
  if (opts.to !== undefined) {
    const d = new Date(opts.to)
    d.setUTCDate(d.getUTCDate() + 1)
    attQ = attQ.lt('checked_in_at', d.toISOString().slice(0, 10))
  }
  const { data } = await attQ
  return (data ?? []).map((r: { id: string }) => r.id)
}

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: existing } = await svc.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existing) {
    const { error } = await svc.from('app_users').insert({
      id: FAKE_ADMIN_ID,
      email: 'exp-test-admin-100@test.invalid',
      full_name: 'EXP Export Test Admin',
      role: 'admin',
      active: true,
    })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }

  p1Id = await upsertPerson(PHONES.P1, { full_name: 'EXP P1 Alpha', nickname: 'P1', origin_parish: PARISH_X })
  p2Id = await upsertPerson(PHONES.P2, { full_name: 'EXP P2 Alpha', nickname: 'P2', origin_parish: PARISH_X })
  p3Id = await upsertPerson(PHONES.P3, { full_name: 'EXP P3 Deleted', nickname: 'P3', origin_parish: PARISH_X })
  p4Id = await upsertPerson(PHONES.P4, { full_name: 'EXP P4 Unknown', nickname: 'P4', origin_parish: null })

  await svc.from('people').update({ deleted_at: '2026-06-01T00:00:00Z' }).eq('id', p3Id).is('deleted_at', null)

  pz1Id = await upsertPerson(PHONES.PZ1, { full_name: 'EXP PZ1', nickname: 'PZ1', origin_parish: PARISH_PAGE })
  pz2Id = await upsertPerson(PHONES.PZ2, { full_name: 'EXP PZ2', nickname: 'PZ2', origin_parish: PARISH_PAGE })
  pz3Id = await upsertPerson(PHONES.PZ3, { full_name: 'EXP PZ3', nickname: 'PZ3', origin_parish: PARISH_PAGE })
  pz4Id = await upsertPerson(PHONES.PZ4, { full_name: 'EXP PZ4', nickname: 'PZ4', origin_parish: PARISH_PAGE })
  pz5Id = await upsertPerson(PHONES.PZ5, { full_name: 'EXP PZ5', nickname: 'PZ5', origin_parish: PARISH_PAGE })

  e1Id = await upsertEvent('EXP Test Event Friday', {
    name_id: 'EXP Test Jumat',
    event_type: 'friday_monthly',
    start_date: '2026-05-08',
    start_time: '18:00',
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR',
  })
  e2Id = await upsertEvent('EXP Test Event Sunday', {
    name_id: 'EXP Test Minggu',
    event_type: 'sunday_monthly',
    start_date: '2026-05-10',
    start_time: '15:00',
    recurrence_rule: 'FREQ=MONTHLY;BYDAY=1SU',
  })
  ezId = await upsertEvent('EXP Test Event Page', {
    name_id: 'EXP Test Page',
    event_type: 'adhoc',
    start_date: '2026-06-05',
    start_time: '18:00',
    recurrence_rule: null,
  })

  e1i1Id = await upsertInstance(e1Id, E1_I1_SCHED, { event_name_snapshot: 'EXP Test Event Friday', event_name_snapshot_id: 'EXP Test Jumat', status: 'completed' })
  e1i2Id = await upsertInstance(e1Id, E1_I2_SCHED, { event_name_snapshot: 'EXP Test Event Friday', event_name_snapshot_id: 'EXP Test Jumat', status: 'cancelled' })
  e2i1Id = await upsertInstance(e2Id, E2_I1_SCHED, { event_name_snapshot: 'EXP Test Event Sunday', event_name_snapshot_id: 'EXP Test Minggu', status: 'completed' })
  e2i2Id = await upsertInstance(e2Id, E2_I2_SCHED, { event_name_snapshot: 'EXP Test Event Sunday', event_name_snapshot_id: 'EXP Test Minggu', status: 'completed' })
  ezi1Id = await upsertInstance(ezId, EZ_I1_SCHED, { event_name_snapshot: 'EXP Test Event Page', event_name_snapshot_id: 'EXP Test Page', status: 'completed' })

  const { error: attErr } = await svc.from('attendance').upsert(
    [
      { event_instance_id: e1i1Id, person_id: p1Id, checked_in_at: P1_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i2Id, person_id: p1Id, checked_in_at: P1_E1I2_AT, checked_in_by: FAKE_ADMIN_ID }, // cancelled instance
      { event_instance_id: e2i1Id, person_id: p1Id, checked_in_at: P1_E2I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p2Id, checked_in_at: P2_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p3Id, checked_in_at: P3_E1I1_AT, checked_in_by: FAKE_ADMIN_ID }, // soft-deleted person
      { event_instance_id: e1i1Id, person_id: p4Id, checked_in_at: P4_E1I1_AT, checked_in_by: FAKE_ADMIN_ID }, // null-parish person
      { event_instance_id: ezi1Id, person_id: pz1Id, checked_in_at: PZ_TIE_A, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: ezi1Id, person_id: pz2Id, checked_in_at: PZ_TIE_A, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: ezi1Id, person_id: pz3Id, checked_in_at: PZ_TIE_B, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: ezi1Id, person_id: pz4Id, checked_in_at: PZ_TIE_B, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: ezi1Id, person_id: pz5Id, checked_in_at: PZ_SOLO, checked_in_by: FAKE_ADMIN_ID },
    ],
    { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true },
  )
  if (attErr) throw new Error(`attendance upsert: ${attErr.message}`)

  const ts = Date.now()
  const sessionEmail = `exp-admin-session-${ts}@test.invalid`
  const sessionPass = `ExpAdminSession-${ts}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: sessionEmail, password: sessionPass, email_confirm: true,
  })
  if (authErr) throw new Error(`createUser: ${authErr.message}`)
  sessionAuthUserId = authData.user.id

  const { error: appUserErr } = await svc.from('app_users').insert({
    id: sessionAuthUserId,
    email: sessionEmail,
    full_name: 'EXP Admin Session',
    role: 'admin',
    active: true,
  })
  if (appUserErr) throw new Error(`app_users insert session admin: ${appUserErr.message}`)

  const tmpClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signIn, error: signInErr } = await tmpClient.auth.signInWithPassword({ email: sessionEmail, password: sessionPass })
  if (signInErr || !signIn.session) throw new Error(`signIn: ${signInErr?.message ?? 'no session'}`)

  sessionClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  })
})

afterAll(async () => {
  if (!svc) return
  const allInstIds = [e1i1Id, e1i2Id, e2i1Id, e2i2Id, ezi1Id].filter(Boolean)
  const allEventIds = [e1Id, e2Id, ezId].filter(Boolean)
  const allPersonIds = [p1Id, p2Id, p3Id, p4Id, pz1Id, pz2Id, pz3Id, pz4Id, pz5Id].filter(Boolean)

  if (allInstIds.length > 0) {
    await svc.from('attendance').delete().in('event_instance_id', allInstIds)
    await svc.from('event_instances').delete().in('id', allInstIds)
  }
  if (allEventIds.length > 0) await svc.from('events').delete().in('id', allEventIds)
  if (allPersonIds.length > 0) {
    await svc.from('people').update({ deleted_at: null }).in('id', allPersonIds)
    await svc.from('people').delete().in('id', allPersonIds)
  }
  if (sessionAuthUserId) {
    await svc.from('app_users').delete().eq('id', sessionAuthUserId)
    await svc.auth.admin.deleteUser(sessionAuthUserId)
  }
  await svc.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
})

// ── impl_getRawAttendanceRows — filter correctness ─────────────────────────────

describe('impl_getRawAttendanceRows', () => {
  it('PARISH_X baseline: ground-truth row count matches impl result', async () => {
    const filters = { parish: PARISH_X }
    const gt = await gtRawRows(filters)
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.length).toBe(gt.length)
    expect(result.data.length).toBe(5) // P1(3) + P2(1) + P3(1)
  })

  it('includes cancelled-instance attendance (export fidelity, unlike dashboard views)', async () => {
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_X } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const row = result.data.find(r => r.event_instance_id === e1i2Id)
    expect(row).toBeDefined()
    expect(row!.instance_status).toBe('cancelled')
  })

  it('includes soft-deleted person with is_deleted=true; active person has is_deleted=false', async () => {
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_X } })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const p3Row = result.data.find(r => r.person_id === p3Id)
    const p1Row = result.data.find(r => r.person_id === p1Id)
    expect(p3Row).toBeDefined()
    expect(p3Row!.is_deleted).toBe(true)
    expect(p1Row).toBeDefined()
    expect(p1Row!.is_deleted).toBe(false)
  })

  it('date range filter (May 8 only): 3 rows, excludes May 10 and May 15', async () => {
    const filters = { parish: PARISH_X, from: '2026-05-08', to: '2026-05-08' }
    const gt = await gtRawRows(filters)
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.length).toBe(gt.length)
    expect(result.data.length).toBe(3) // P1@E1I1, P2@E1I1, P3@E1I1 (PARISH_X; P4 is null-parish, excluded)
  })

  it('eventType filter (friday_monthly): 4 rows (P1 x2 + P2 + P3), excludes P1@E2I1', async () => {
    const filters = { parish: PARISH_X, eventType: 'friday_monthly' as const }
    const gt = await gtRawRows(filters)
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.length).toBe(gt.length)
    expect(result.data.length).toBe(4)
    expect(result.data.find(r => r.event_instance_id === e2i1Id)).toBeUndefined()
  })

  it("parish=(Unknown): returns P4's row only", async () => {
    const filters = { parish: '(Unknown)' }
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const p4Row = result.data.find(r => r.person_id === p4Id)
    expect(p4Row).toBeDefined()
    expect(p4Row!.origin_parish).toBeNull()
    expect(result.data.find(r => r.person_id === p1Id)).toBeUndefined()
  })

  it('empty range (far future): ok status, empty array (not a throw)', async () => {
    const result = await impl_getRawAttendanceRows({
      supabase: sessionClient,
      filters: { parish: PARISH_X, from: '2099-01-01', to: '2099-12-31' },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data).toHaveLength(0)
  })

  it('invalid from date: returns invalid_filter', async () => {
    const result = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { from: 'not-a-date' } })
    expect(result.status).toBe('invalid_filter')
  })

  it('invalid eventType: returns invalid_filter', async () => {
    const result = await impl_getRawAttendanceRows({
      supabase: sessionClient,
      filters: { eventType: 'bad_type' as 'friday_monthly' },
    })
    expect(result.status).toBe('invalid_filter')
  })
})

// ── getPersonAttendanceSummary / getEventAttendanceSummary — pure reducers ─────

describe('getPersonAttendanceSummary + getEventAttendanceSummary', () => {
  it('PARISH_X: person counts, distinct_events (templates not instances), is_deleted carried through', async () => {
    const raw = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_X } })
    expect(raw.status).toBe('ok')
    if (raw.status !== 'ok') return

    const summary = getPersonAttendanceSummary(raw.data)
    const p1 = summary.find(r => r.person_id === p1Id)
    const p2 = summary.find(r => r.person_id === p2Id)
    const p3 = summary.find(r => r.person_id === p3Id)

    expect(p1).toBeDefined()
    expect(p1!.count).toBe(3)
    expect(p1!.distinct_events).toBe(2) // E1 + E2 templates, NOT 3 (2 E1 instances + 1 E2 instance)
    expect(p1!.is_deleted).toBe(false)

    expect(p2).toBeDefined()
    expect(p2!.count).toBe(1)
    expect(p2!.distinct_events).toBe(1)

    expect(p3).toBeDefined()
    expect(p3!.count).toBe(1)
    expect(p3!.is_deleted).toBe(true)
  })

  it('PARISH_X: event summary counts per instance, cancelled instance included', async () => {
    const raw = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_X } })
    expect(raw.status).toBe('ok')
    if (raw.status !== 'ok') return

    const summary = getEventAttendanceSummary(raw.data)
    const i1 = summary.find(r => r.event_instance_id === e1i1Id)
    const i2 = summary.find(r => r.event_instance_id === e1i2Id)

    expect(i1).toBeDefined()
    expect(i1!.count).toBe(3) // P1, P2, P3

    expect(i2).toBeDefined()
    expect(i2!.count).toBe(1) // P1 only
    expect(i2!.instance_status).toBe('cancelled')
  })

  it('zero-attendance instance (E2-I2) absent from event summary — locked semantics', async () => {
    // E2-I2 has zero attendance rows entirely, so it can never appear in a
    // raw-derived summary regardless of filter — no event_instances left-join.
    const raw = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: {} })
    expect(raw.status).toBe('ok')
    if (raw.status !== 'ok') return
    const summary = getEventAttendanceSummary(raw.data)
    expect(summary.find(r => r.event_instance_id === e2i2Id)).toBeUndefined()
  })

  it('reconciliation invariant holds across two different filter combinations', async () => {
    const combos = [{ parish: PARISH_X }, { parish: PARISH_X, eventType: 'friday_monthly' as const }]
    for (const filters of combos) {
      const raw = await impl_getRawAttendanceRows({ supabase: sessionClient, filters })
      expect(raw.status).toBe('ok')
      if (raw.status !== 'ok') continue

      const personSummary = getPersonAttendanceSummary(raw.data)
      const eventSummary = getEventAttendanceSummary(raw.data)
      const sumPerson = personSummary.reduce((s, r) => s + r.count, 0)
      const sumEvent = eventSummary.reduce((s, r) => s + r.count, 0)

      expect(sumPerson).toBe(raw.data.length)
      expect(sumEvent).toBe(raw.data.length)
    }
  })
})

// ── Pagination — row-cap truncation guard ───────────────────────────────────────

describe('impl_getRawAttendanceRows pagination', () => {
  it('mock client: no truncation across a page boundary + reconciliation holds', async () => {
    // Simulates the prod max_rows cap without seeding 500+ live fixture rows.
    // Page 1 returns exactly pageSize rows (continues); page 2 returns fewer
    // (terminates). Verifies fetchFilteredAttendanceRows's loop, not DB behavior.
    const makeRow = (i: number): Record<string, unknown> => ({
      attendance_id: `mock-att-${i}`,
      checked_in_at: `2026-01-01T00:0${i}:00Z`,
      source: 'volunteer_checkin',
      checked_in_by: FAKE_ADMIN_ID,
      person_id: `mock-person-${i % 2}`, // 2 distinct people
      full_name: `Mock Person ${i % 2}`,
      nickname: `M${i % 2}`,
      phone_e164: `+62999009199${i}`,
      origin_parish: 'Mock Parish',
      gender: null,
      marital_status: null,
      tribe: null,
      kepanitiaan: null,
      person_deleted_at: null,
      event_instance_id: 'mock-instance-0',
      scheduled_at: '2026-01-01T00:00:00Z',
      instance_status: 'completed',
      event_name_snapshot: 'Mock Event',
      event_id: 'mock-event-0',
      event_type: 'adhoc',
    })

    const page1 = [makeRow(1), makeRow(2), makeRow(3)] // pageSize rows -> loop continues
    const page2 = [makeRow(4)] // < pageSize -> loop terminates
    const pages = [page1, page2]
    let callIndex = 0

    const mockSupabase = {
      from() {
        const page = pages[callIndex] ?? []
        callIndex += 1
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builder: any = {
          select: () => builder,
          gte: () => builder,
          lt: () => builder,
          eq: () => builder,
          is: () => builder,
          order: () => builder,
          limit: () => builder,
          or: () => builder,
          then(resolve: (v: { data: unknown; error: null }) => void) {
            resolve({ data: page, error: null })
          },
        }
        return builder
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const result = await impl_getRawAttendanceRows({ supabase: mockSupabase, filters: {} }, 3)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.data.length).toBe(4) // no truncation at the pageSize boundary
    expect(callIndex).toBe(2) // exactly 2 pages fetched

    const personSummary = getPersonAttendanceSummary(result.data)
    const eventSummary = getEventAttendanceSummary(result.data)
    expect(personSummary.reduce((s, r) => s + r.count, 0)).toBe(4)
    expect(eventSummary.reduce((s, r) => s + r.count, 0)).toBe(4)
  })

  it('local-Docker: pageSize=2 over 5 real rows with checked_in_at ties — no gaps/overlaps, reconciliation holds', async () => {
    const paged = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_PAGE } }, 2)
    const unpaged = await impl_getRawAttendanceRows({ supabase: sessionClient, filters: { parish: PARISH_PAGE } }, 500)

    expect(paged.status).toBe('ok')
    expect(unpaged.status).toBe('ok')
    if (paged.status !== 'ok' || unpaged.status !== 'ok') return

    expect(paged.data.length).toBe(5)
    // Exact-set match against a single-page fetch — proves no gaps, no
    // duplicates, and correct tie-break at the (checked_in_at, attendance_id)
    // boundary (PZ1/PZ2 share a timestamp; PZ3/PZ4 share a different one).
    const pagedIds = paged.data.map((r: RawAttendanceRow) => r.attendance_id).sort()
    const unpagedIds = unpaged.data.map((r: RawAttendanceRow) => r.attendance_id).sort()
    expect(pagedIds).toEqual(unpagedIds)

    const personSummary = getPersonAttendanceSummary(paged.data)
    const eventSummary = getEventAttendanceSummary(paged.data)
    expect(personSummary.reduce((s, r) => s + r.count, 0)).toBe(5)
    expect(eventSummary.reduce((s, r) => s + r.count, 0)).toBe(5)
  })
})
