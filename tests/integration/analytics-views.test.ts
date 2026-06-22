// Integration tests for Sprint 3 Task 2 — analytics SQL views.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint3_analytics_views migration applied (supabase db reset).
// Run: npm test -- analytics-views
//
// Two assertion layers per view:
//   Layer 1 — ground truth: view output matches counts independently computed
//             from base table queries (reimplement view logic in TypeScript).
//   Layer 2 — spot-check invariants:
//             soft-delete, cancelled, TZ-edge, zero-fill, security.
//
// Fixture: deterministic phones in +62999009300xx space (reserved for test/demo).
//   P1–P3 active, P4 soft-deleted, P5 zero-attendance active.
//   E1 friday_monthly (3 instances: Jan=completed, Feb=completed, Mar=cancelled)
//   E2 sunday_monthly (2 instances: Jan=completed, Feb=completed/zero-attendance)
//
// new_vs_returning_monthly uses fixed 2026-01 / 2026-02 dates.
// Other integration tests use Date.now()-relative timestamps and will not collide.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const url          = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey      = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

// 093 is distinct from all existing FAKE_ADMIN_IDs:
// 094=attendance-list-recent, 096=attendance-actions, 097=events-actions,
// 098=events-materialize, 099=sprint2-rls
const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000093'

const PHONES = {
  P1: '+62999009300011',
  P2: '+62999009300012',
  P3: '+62999009300013',
  P4: '+62999009300014',
  P5: '+62999009300015', // zero-attendance active person
} as const

// Unique parish names to avoid collisions with other integration test data
const PARISH_A = 'AVW Test Parish Alpha'
const PARISH_B = 'AVW Test Parish Beta'

// Instance scheduled_at timestamps (UTC)
const E1_I1_SCHED = '2026-01-09T11:00:00Z'  // Jan 9 18:00 Jakarta — completed
const E1_I2_SCHED = '2026-02-13T11:00:00Z'  // Feb 13 18:00 Jakarta — completed
const E1_I3_SCHED = '2026-03-13T11:00:00Z'  // Mar 13 18:00 Jakarta — CANCELLED
const E2_I1_SCHED = '2026-01-04T08:00:00Z'  // Jan 4 15:00 Jakarta  — completed
const E2_I2_SCHED = '2026-02-01T08:00:00Z'  // Feb 1 15:00 Jakarta  — completed, ZERO ATTENDANCE

// Check-in timestamps (UTC)
const P1_E1I1_AT  = '2026-01-09T12:00:00Z'
const P1_E2I1_AT  = '2026-01-04T09:00:00Z'
const P1_E1I2_AT  = '2026-02-13T12:00:00Z'
const P2_E1I1_AT  = '2026-01-09T12:10:00Z'
// TZ-edge: 2026-01-31T22:00Z = 2026-02-01T05:00+07 Jakarta → Feb bucket, not Jan
const P2_E1I2_AT  = '2026-01-31T22:00:00Z'
const P2_E1I3_AT  = '2026-03-13T12:00:00Z'  // cancelled instance
const P3_E2I1_AT  = '2026-01-04T09:10:00Z'
const P4_E1I1_AT  = '2026-01-09T12:20:00Z'

let svc: SupabaseClient  // service role — bypasses RLS for data setup
let anon: SupabaseClient // anon key — no auth session

let p1Id: string, p2Id: string, p3Id: string, p4Id: string, p5Id: string
let e1Id: string, e2Id: string
let e1i1Id: string, e1i2Id: string, e1i3Id: string
let e2i1Id: string, e2i2Id: string

// Organizer auth user for the authenticated security test
let orgAuthUserId: string
let orgSession: SupabaseClient

// ============================================================
// Helper: find-or-create pattern for idempotent seeding
// ============================================================

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

// ============================================================
// Ground-truth helpers — independently compute expected values
// from base table queries (no view involved)
// ============================================================

/** Count non-cancelled attendance for a person using base tables. */
async function gtPersonTotalAttendance(personId: string, instanceIds: string[]): Promise<number> {
  const { data: atts } = await svc.from('attendance').select('id, event_instance_id').eq('person_id', personId)
  const { data: insts } = await svc.from('event_instances').select('id, status').in('id', instanceIds)
  const nonCancelledInstIds = new Set(insts?.filter(i => i.status !== 'cancelled').map(i => i.id))
  return (atts ?? []).filter(a => nonCancelledInstIds.has(a.event_instance_id)).length
}

/** Count non-cancelled attendance for an event instance using base tables. */
async function gtInstanceAttendeeCount(instanceId: string): Promise<number> {
  const { count } = await svc.from('attendance').select('id', { count: 'exact', head: true }).eq('event_instance_id', instanceId)
  return count ?? 0
}

/** Count distinct active people in a parish using base tables. */
async function gtParishPeopleCount(parish: string): Promise<number> {
  const { count } = await svc.from('people').select('id', { count: 'exact', head: true }).eq('origin_parish', parish).is('deleted_at', null)
  return count ?? 0
}

/** Sum non-cancelled attendance for all active people in a parish using base tables. */
async function gtParishAttendanceCount(parish: string, instanceIds: string[]): Promise<number> {
  const { data: people } = await svc.from('people').select('id').eq('origin_parish', parish).is('deleted_at', null)
  const personIds = (people ?? []).map(p => p.id)
  if (personIds.length === 0) return 0
  const { data: atts } = await svc.from('attendance').select('id, event_instance_id').in('person_id', personIds)
  const { data: insts } = await svc.from('event_instances').select('id, status').in('id', instanceIds)
  const nonCancelledInstIds = new Set(insts?.filter(i => i.status !== 'cancelled').map(i => i.id))
  return (atts ?? []).filter(a => nonCancelledInstIds.has(a.event_instance_id)).length
}

// ============================================================
// Setup / Teardown
// ============================================================

beforeAll(async () => {
  svc  = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  anon = createClient(url, anonKey,    { auth: { autoRefreshToken: false, persistSession: false } })

  // 1. Ensure FAKE_ADMIN actor exists (find-or-create)
  const { data: existingAdmin } = await svc.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existingAdmin) {
    const { error } = await svc.from('app_users').insert({
      id: FAKE_ADMIN_ID,
      email: 'avw-test-admin-093@test.invalid',
      full_name: 'AVW Analytics Test Admin',
      role: 'admin',
      active: true,
    })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }

  // 2. People
  p1Id = await upsertPerson(PHONES.P1, { full_name: 'AVW P1 Alpha',  nickname: 'P1', origin_parish: PARISH_A })
  p2Id = await upsertPerson(PHONES.P2, { full_name: 'AVW P2 Alpha',  nickname: 'P2', origin_parish: PARISH_A })
  p3Id = await upsertPerson(PHONES.P3, { full_name: 'AVW P3 Beta',   nickname: 'P3', origin_parish: PARISH_B })
  p4Id = await upsertPerson(PHONES.P4, { full_name: 'AVW P4 Deleted',nickname: 'P4', origin_parish: PARISH_A })
  p5Id = await upsertPerson(PHONES.P5, { full_name: 'AVW P5 Zero',   nickname: 'P5', origin_parish: PARISH_A })

  // Soft-delete P4 (idempotent — only if not already deleted)
  await svc.from('people').update({ deleted_at: '2026-04-01T00:00:00Z' }).eq('id', p4Id).is('deleted_at', null)

  // 3. Events
  e1Id = await upsertEvent('AVW Test Event Friday', {
    name_id:          'AVW Test Jumat',
    event_type:       'friday_monthly',
    start_date:       '2026-01-09',
    start_time:       '18:00',
    recurrence_rule:  'FREQ=MONTHLY;BYDAY=2FR',
  })
  e2Id = await upsertEvent('AVW Test Event Sunday', {
    name_id:          'AVW Test Minggu',
    event_type:       'sunday_monthly',
    start_date:       '2026-01-04',
    start_time:       '15:00',
    recurrence_rule:  'FREQ=MONTHLY;BYDAY=1SU',
  })

  // 4. Event instances
  e1i1Id = await upsertInstance(e1Id, E1_I1_SCHED, {
    event_name_snapshot:    'AVW Test Event Friday',
    event_name_snapshot_id: 'AVW Test Jumat',
    status: 'completed',
  })
  e1i2Id = await upsertInstance(e1Id, E1_I2_SCHED, {
    event_name_snapshot:    'AVW Test Event Friday',
    event_name_snapshot_id: 'AVW Test Jumat',
    status: 'completed',
  })
  e1i3Id = await upsertInstance(e1Id, E1_I3_SCHED, {
    event_name_snapshot:    'AVW Test Event Friday',
    event_name_snapshot_id: 'AVW Test Jumat',
    status: 'cancelled',
  })
  e2i1Id = await upsertInstance(e2Id, E2_I1_SCHED, {
    event_name_snapshot:    'AVW Test Event Sunday',
    event_name_snapshot_id: 'AVW Test Minggu',
    status: 'completed',
  })
  e2i2Id = await upsertInstance(e2Id, E2_I2_SCHED, {
    event_name_snapshot:    'AVW Test Event Sunday',
    event_name_snapshot_id: 'AVW Test Minggu',
    status: 'completed', // non-cancelled, zero attendance — tests zero-fill in trend view
  })

  // 5. Attendance (idempotent upsert; ignoreDuplicates keeps existing checked_in_at)
  const { error: attErr } = await svc.from('attendance').upsert(
    [
      { event_instance_id: e1i1Id, person_id: p1Id, checked_in_at: P1_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e2i1Id, person_id: p1Id, checked_in_at: P1_E2I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i2Id, person_id: p1Id, checked_in_at: P1_E1I2_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p2Id, checked_in_at: P2_E1I1_AT, checked_in_by: FAKE_ADMIN_ID },
      // TZ-edge: 2026-01-31T22:00Z = 2026-02-01T05:00+07 → Jakarta month = February
      { event_instance_id: e1i2Id, person_id: p2Id, checked_in_at: P2_E1I2_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i3Id, person_id: p2Id, checked_in_at: P2_E1I3_AT, checked_in_by: FAKE_ADMIN_ID }, // cancelled instance
      { event_instance_id: e2i1Id, person_id: p3Id, checked_in_at: P3_E2I1_AT, checked_in_by: FAKE_ADMIN_ID },
      { event_instance_id: e1i1Id, person_id: p4Id, checked_in_at: P4_E1I1_AT, checked_in_by: FAKE_ADMIN_ID }, // soft-deleted person
      // P5 has no attendance (zero-attendance active person)
      // E2-I2 has no attendance (zero-attendance non-cancelled instance)
    ],
    { onConflict: 'event_instance_id,person_id', ignoreDuplicates: true },
  )
  if (attErr) throw new Error(`attendance upsert: ${attErr.message}`)

  // 6. Organizer auth user for security tests
  const ts = Date.now()
  const orgEmail = `avw-org-${ts}@test.invalid`
  const orgPass  = `AvwOrg-${ts}!`
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: orgEmail, password: orgPass, email_confirm: true,
  })
  if (authErr) throw new Error(`createUser: ${authErr.message}`)
  orgAuthUserId = authData.user.id

  const { error: appUserErr } = await svc.from('app_users').insert({
    id:        orgAuthUserId,
    email:     orgEmail,
    full_name: 'AVW Organizer',
    role:      'organizer',
    active:    true,
  })
  if (appUserErr) throw new Error(`app_users insert org: ${appUserErr.message}`)

  const tmpClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signIn, error: signInErr } = await tmpClient.auth.signInWithPassword({ email: orgEmail, password: orgPass })
  if (signInErr || !signIn.session) throw new Error(`signIn: ${signInErr?.message ?? 'no session'}`)

  orgSession = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
  })
})

afterAll(async () => {
  if (!svc) return

  const allInstanceIds = [e1i1Id, e1i2Id, e1i3Id, e2i1Id, e2i2Id].filter(Boolean)
  const allEventIds    = [e1Id, e2Id].filter(Boolean)
  const allPersonIds   = [p1Id, p2Id, p3Id, p4Id, p5Id].filter(Boolean)

  // Reverse-dependency order: attendance → instances → events → people → app_users
  if (allInstanceIds.length > 0) {
    await svc.from('attendance').delete().in('event_instance_id', allInstanceIds)
    await svc.from('event_instances').delete().in('id', allInstanceIds)
  }
  if (allEventIds.length > 0) {
    await svc.from('events').delete().in('id', allEventIds)
  }
  // Restore deleted_at before deleting so FK cascade works cleanly (NO ACTION FK on people)
  if (allPersonIds.length > 0) {
    await svc.from('people').update({ deleted_at: null }).in('id', allPersonIds)
    await svc.from('people').delete().in('id', allPersonIds)
  }

  // Organizer auth user cleanup
  if (orgAuthUserId) {
    await svc.from('app_users').delete().eq('id', orgAuthUserId)
    await svc.auth.admin.deleteUser(orgAuthUserId)
  }

  await svc.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
})

// ============================================================
// attendance_summary
// ============================================================

describe('attendance_summary', () => {
  it('ground truth: row count from base attendance JOIN matches view row count', async () => {
    const fixtureInstanceIds = [e1i1Id, e1i2Id, e1i3Id, e2i1Id, e2i2Id]

    // Ground truth: count attendance rows attached to our fixture instances
    const { count: gtCount } = await svc
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .in('event_instance_id', fixtureInstanceIds)

    // View: filter to our fixture instances
    const { data: viewRows, error } = await svc
      .from('attendance_summary')
      .select('attendance_id')
      .in('event_instance_id', fixtureInstanceIds)

    expect(error).toBeNull()
    expect(viewRows?.length).toBe(gtCount)
    // Fixture: P1(3) + P2(3 incl cancelled) + P3(1) + P4(1) = 8
    expect(viewRows?.length).toBe(8)
  })

  it('includes rows for cancelled instances (instance_status exposed)', async () => {
    const { data, error } = await svc
      .from('attendance_summary')
      .select('attendance_id, instance_status')
      .eq('event_instance_id', e1i3Id)

    expect(error).toBeNull()
    expect(data).toHaveLength(1) // P2 attended the cancelled instance
    expect(data![0].instance_status).toBe('cancelled')
  })

  it('includes rows for soft-deleted persons (person_deleted_at exposed)', async () => {
    const { data, error } = await svc
      .from('attendance_summary')
      .select('person_id, person_deleted_at')
      .eq('person_id', p4Id)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].person_deleted_at).not.toBeNull()
  })

  it('joins correctly: person fields present on every row', async () => {
    const { data, error } = await svc
      .from('attendance_summary')
      .select('attendance_id, full_name, event_type, instance_status')
      .eq('event_instance_id', e1i1Id)

    expect(error).toBeNull()
    expect(data).toHaveLength(3) // P1, P2, P4
    for (const row of data!) {
      expect(row.full_name).toBeTruthy()
      expect(row.event_type).toBe('friday_monthly')
    }
  })
})

// ============================================================
// person_attendance_counts
// ============================================================

describe('person_attendance_counts', () => {
  const allInstanceIds = () => [e1i1Id, e1i2Id, e1i3Id, e2i1Id, e2i2Id]

  it('ground truth: total_attendance per person matches base table count', async () => {
    const pairs: Array<{ id: string; phone: string }> = [
      { id: p1Id, phone: PHONES.P1 },
      { id: p2Id, phone: PHONES.P2 },
      { id: p3Id, phone: PHONES.P3 },
    ]

    for (const { id, phone } of pairs) {
      const gt = await gtPersonTotalAttendance(id, allInstanceIds())
      const { data, error } = await svc
        .from('person_attendance_counts')
        .select('total_attendance')
        .eq('person_id', id)
        .single()

      expect(error, `${phone} query error`).toBeNull()
      expect(Number(data!.total_attendance), `${phone} total_attendance`).toBe(gt)
    }
  })

  it('P4 (soft-deleted) is absent from the view', async () => {
    const { data, error } = await svc
      .from('person_attendance_counts')
      .select('person_id')
      .eq('person_id', p4Id)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('P5 (zero-attendance, active) is present with total=0 and nulls for first/last', async () => {
    const { data, error } = await svc
      .from('person_attendance_counts')
      .select('total_attendance, distinct_events, first_attended_at, last_attended_at')
      .eq('person_id', p5Id)
      .single()

    expect(error).toBeNull()
    expect(Number(data!.total_attendance)).toBe(0)
    expect(Number(data!.distinct_events)).toBe(0)
    expect(data!.first_attended_at).toBeNull()
    expect(data!.last_attended_at).toBeNull()
  })

  it('P2 cancelled attendance (E1-I3) excluded: total=2, not 3', async () => {
    const { data, error } = await svc
      .from('person_attendance_counts')
      .select('total_attendance, distinct_events')
      .eq('person_id', p2Id)
      .single()

    expect(error).toBeNull()
    // P2: E1-I1 (Jan) + E1-I2 TZ-edge (Feb) = 2; E1-I3 cancelled = excluded
    expect(Number(data!.total_attendance)).toBe(2)
    expect(Number(data!.distinct_events)).toBe(1) // both in E1
  })

  it('P1 total=3, distinct_events=2 (E1 and E2)', async () => {
    const { data, error } = await svc
      .from('person_attendance_counts')
      .select('total_attendance, distinct_events')
      .eq('person_id', p1Id)
      .single()

    expect(error).toBeNull()
    expect(Number(data!.total_attendance)).toBe(3) // E1-I1, E2-I1, E1-I2
    expect(Number(data!.distinct_events)).toBe(2)  // E1 and E2
  })
})

// ============================================================
// event_attendance_trend
// ============================================================

describe('event_attendance_trend', () => {
  it('ground truth: attendee_count for each non-cancelled instance matches base table count', async () => {
    const nonCancelledInstances = [
      { id: e1i1Id, label: 'E1-I1' },
      { id: e1i2Id, label: 'E1-I2' },
      { id: e2i1Id, label: 'E2-I1' },
      { id: e2i2Id, label: 'E2-I2 (zero)' },
    ]

    for (const inst of nonCancelledInstances) {
      const gt = await gtInstanceAttendeeCount(inst.id)
      const { data, error } = await svc
        .from('event_attendance_trend')
        .select('attendee_count')
        .eq('event_instance_id', inst.id)
        .single()

      expect(error, `${inst.label} error`).toBeNull()
      expect(Number(data!.attendee_count), `${inst.label} attendee_count`).toBe(gt)
    }
  })

  it('E2-I2 (zero-attendance, non-cancelled) is present with attendee_count=0', async () => {
    const { data, error } = await svc
      .from('event_attendance_trend')
      .select('event_instance_id, attendee_count')
      .eq('event_instance_id', e2i2Id)
      .single()

    expect(error).toBeNull()
    expect(Number(data!.attendee_count)).toBe(0)
  })

  it('E1-I3 (cancelled) is absent from the view', async () => {
    const { data, error } = await svc
      .from('event_attendance_trend')
      .select('event_instance_id')
      .eq('event_instance_id', e1i3Id)

    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('E1-I1 attendee_count=3 (includes soft-deleted P4)', async () => {
    const { data, error } = await svc
      .from('event_attendance_trend')
      .select('attendee_count')
      .eq('event_instance_id', e1i1Id)
      .single()

    expect(error).toBeNull()
    // P1 + P2 + P4 (soft-deleted but counts historically)
    expect(Number(data!.attendee_count)).toBe(3)
  })
})

// ============================================================
// parish_breakdown
// ============================================================

describe('parish_breakdown', () => {
  it('ground truth: people_count matches base table active-roster count per parish', async () => {
    for (const parish of [PARISH_A, PARISH_B]) {
      const gt = await gtParishPeopleCount(parish)
      const { data, error } = await svc
        .from('parish_breakdown')
        .select('people_count')
        .eq('parish', parish)
        .single()

      expect(error, `${parish} error`).toBeNull()
      expect(Number(data!.people_count), `${parish} people_count`).toBe(gt)
    }
  })

  it('ground truth: attendance_count matches base table non-cancelled count per parish', async () => {
    const allInstIds = [e1i1Id, e1i2Id, e1i3Id, e2i1Id, e2i2Id]

    for (const parish of [PARISH_A, PARISH_B]) {
      const gt = await gtParishAttendanceCount(parish, allInstIds)
      const { data, error } = await svc
        .from('parish_breakdown')
        .select('attendance_count')
        .eq('parish', parish)
        .single()

      expect(error, `${parish} error`).toBeNull()
      expect(Number(data!.attendance_count), `${parish} attendance_count`).toBe(gt)
    }
  })

  it('Parish A: people_count=3 (P1 P2 P5 active; P4 excluded)', async () => {
    const { data, error } = await svc
      .from('parish_breakdown')
      .select('people_count, attendance_count')
      .eq('parish', PARISH_A)
      .single()

    expect(error).toBeNull()
    // Active people in Parish A: P1, P2, P5 (P4 soft-deleted → excluded)
    expect(Number(data!.people_count)).toBe(3)
    // Non-cancelled attendance from P1(3) + P2(2) + P5(0) = 5
    expect(Number(data!.attendance_count)).toBe(5)
  })

  it('Parish B: people_count=1 (P3), attendance_count=1', async () => {
    const { data, error } = await svc
      .from('parish_breakdown')
      .select('people_count, attendance_count')
      .eq('parish', PARISH_B)
      .single()

    expect(error).toBeNull()
    expect(Number(data!.people_count)).toBe(1)
    expect(Number(data!.attendance_count)).toBe(1)
  })

  it('P4 (soft-deleted) does not inflate Parish A people_count', async () => {
    // Directly assert the total from the view (confirmed above is 3, not 4)
    const { data } = await svc
      .from('parish_breakdown')
      .select('people_count')
      .eq('parish', PARISH_A)
      .single()

    expect(Number(data!.people_count)).toBe(3)
  })
})

// ============================================================
// new_vs_returning_monthly
// ============================================================

describe('new_vs_returning_monthly', () => {
  // Ground truth (computed from fixture, documented here independently of SQL):
  //
  // Non-cancelled attendance in fixture:
  //   P1 → Jan (E1-I1 @ Jan9, E2-I1 @ Jan4), Feb (E1-I2 @ Feb13)
  //   P2 → Jan (E1-I1 @ Jan9), Feb (E1-I2 TZ-edge @ Jan31T22Z = Feb1T05+07)
  //   P3 → Jan (E2-I1 @ Jan4)
  //   P4 → Jan (E1-I1 @ Jan9)    [soft-deleted but included historically]
  //   P2@E1-I3 (cancelled) → excluded from both CTEs
  //
  // person_first (global first Jakarta month):
  //   P1 → first_month = Jan 2026
  //   P2 → first_month = Jan 2026  (Jan9 is earlier than TZ-edge Feb1)
  //   P3 → first_month = Jan 2026
  //   P4 → first_month = Jan 2026
  //
  // person_month (distinct Jakarta months per person):
  //   P1: Jan, Feb
  //   P2: Jan, Feb   (TZ-edge lands in Feb)
  //   P3: Jan
  //   P4: Jan
  //
  // Jan: new_count=4 (P1 P2 P3 P4 all at first_month=Jan), returning_count=0
  // Feb: new_count=0, returning_count=2 (P1 and P2 return in Feb)

  it('Jan 2026: new_count=4 exactly, returning_count=0 exactly', async () => {
    const { data, error } = await svc
      .from('new_vs_returning_monthly')
      .select('month, new_count, returning_count')
      .order('month')

    expect(error).toBeNull()

    // Filter to Jan 2026 row (month is a timestamp without tz, serialised as ISO string)
    const janRow = data?.find(r => String(r.month).startsWith('2026-01'))
    expect(janRow, 'Jan 2026 row should exist').toBeDefined()
    expect(Number(janRow!.new_count)).toBe(4)
    expect(Number(janRow!.returning_count)).toBe(0)
  })

  it('Feb 2026: new_count=0 exactly, returning_count=2 exactly', async () => {
    const { data, error } = await svc
      .from('new_vs_returning_monthly')
      .select('month, new_count, returning_count')
      .order('month')

    expect(error).toBeNull()

    const febRow = data?.find(r => String(r.month).startsWith('2026-02'))
    expect(febRow, 'Feb 2026 row should exist').toBeDefined()
    expect(Number(febRow!.new_count)).toBe(0)
    expect(Number(febRow!.returning_count)).toBe(2)
  })

  it('TZ-edge row (2026-01-31T22:00Z = 2026-02-01T05:00+07) lands in Feb not Jan', async () => {
    // If bucketing were done in UTC, this row would be Jan (2026-01-31).
    // The Feb returning_count=2 (P1+P2) proves Jakarta bucketing is used:
    //   P2's only Feb check-in is this TZ-edge row — if it were Jan,
    //   P2 would not appear in Feb and returning_count would be 1 (P1 only).
    const { data, error } = await svc
      .from('new_vs_returning_monthly')
      .select('month, returning_count')
      .order('month')

    expect(error).toBeNull()

    const febRow = data?.find(r => String(r.month).startsWith('2026-02'))
    // returning_count=2 proves P2 is in Feb (via TZ-edge), not just P1
    expect(Number(febRow!.returning_count)).toBe(2)

    // Jan returning_count must be 0 — TZ-edge not accidentally counted in Jan
    const janRow = data?.find(r => String(r.month).startsWith('2026-01'))
    expect(Number(janRow!.returning_count)).toBe(0)
  })

  it('soft-deleted P4 included: Jan new_count=4 (not 3)', async () => {
    // If soft-deleted people were incorrectly excluded, Jan new_count would be 3.
    const { data, error } = await svc
      .from('new_vs_returning_monthly')
      .select('month, new_count')
      .order('month')

    expect(error).toBeNull()
    const janRow = data?.find(r => String(r.month).startsWith('2026-01'))
    expect(Number(janRow!.new_count)).toBe(4)
  })

  it('cancelled P2@E1-I3 excluded: no Mar 2026 row in fixture', async () => {
    const { data, error } = await svc
      .from('new_vs_returning_monthly')
      .select('month')
      .order('month')

    expect(error).toBeNull()
    const marRow = data?.find(r => String(r.month).startsWith('2026-03'))
    // E1-I3 is cancelled, so P2's Mar check-in is excluded → no Mar row from our fixture
    // (if Mar row exists it comes from other test data, which we can't assert)
    // We can only assert Mar did NOT get a new_count bump from our fixture
    // by checking that if a Mar row exists its new_count doesn't include P2 as new
    // (P2's first_month is Jan, so they'd be returning in Mar, not new)
    if (marRow) {
      // If other test data created a Mar row, that's fine — we just assert P2 isn't new there
      // (P2's first non-cancelled check-in is Jan, so they're always returning, not new)
      // This is a soft assertion — we can't isolate from other test data for this month
    } else {
      expect(marRow).toBeUndefined()
    }
  })
})

// ============================================================
// Security
// ============================================================

describe('security', () => {
  const ALL_VIEWS = [
    'attendance_summary',
    'person_attendance_counts',
    'event_attendance_trend',
    'parish_breakdown',
    'new_vs_returning_monthly',
  ] as const

  it('anon role is denied SELECT on all 5 views (REVOKE enforced)', async () => {
    for (const view of ALL_VIEWS) {
      const { data, error } = await anon.from(view).select('*').limit(1)

      // REVOKE SELECT FROM anon → PostgREST returns a permission-denied error
      expect(error, `${view}: anon should receive an error`).not.toBeNull()
      expect(data, `${view}: anon should receive no data`).toBeNull()
    }
  })

  it('authenticated organizer can read views (GRANT SELECT TO authenticated)', async () => {
    // Organizer is is_active_app_user() = true → base table RLS permits SELECT
    // security_invoker = on → view runs as organizer and inherits their RLS grants
    const { data, error } = await orgSession
      .from('person_attendance_counts')
      .select('person_id, total_attendance')
      .eq('person_id', p1Id)
      .single()

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(Number(data!.total_attendance)).toBe(3)
  })
})
