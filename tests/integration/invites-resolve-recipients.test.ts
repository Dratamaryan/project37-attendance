// Integration tests for Sprint 4 Task 9 — recipient resolution (F/2 filters,
// F/4 has-email/no-email split). Runs against local Docker Supabase
// (.env.test.local). Uses the service-role client directly — RLS on `people`
// isn't the surface under test here (already covered by earlier sprints);
// filter/query correctness against the real schema + person_attendance_counts
// view is. Run: npm test -- invites-resolve-recipients

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { impl_resolveRecipients } from '@/lib/actions/invites.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

let serviceAdmin: SupabaseClient
let adminUserId: string
let eventId: string
const attendanceInstanceIds: string[] = []
const personIds: string[] = []

const ts = Date.now()
const TRIBE = `T9RES-Tribe-${ts}`
const KEPANITIAAN = `T9RES-Kepan-${ts}`

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const email = `t9res-admin-${ts}@test.invalid`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: `Pw-${ts}!`,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  adminUserId = authData.user.id
  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: adminUserId, email, full_name: 'T9 Res Admin', role: 'admin', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: `T9RES Event ${ts}`,
      event_type: 'adhoc',
      start_date: '2026-09-01',
      start_time: '18:00:00',
      active: true,
      created_by: adminUserId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = ev.id as string

  // uniq_attendance is UNIQUE(event_instance_id, person_id) — one attendance
  // row per person per instance. 3 separate instances let p4 accumulate
  // total_attendance=3 for the minAttendance/recency fixtures below.
  for (let i = 0; i < 3; i++) {
    const { data: inst, error: instErr } = await serviceAdmin
      .from('event_instances')
      .insert({
        event_id: eventId,
        scheduled_at: new Date(Date.now() + (5 + i) * 86_400_000).toISOString(),
        event_name_snapshot: `T9RES Event ${ts} #${i}`,
        status: 'scheduled',
      })
      .select('id')
      .single()
    if (instErr || !inst) throw new Error(`insert instance ${i}: ${instErr?.message}`)
    attendanceInstanceIds.push(inst.id as string)
  }

  // p1: tribe, has email, no attendance
  // p2: tribe, no email
  // p3: kepanitiaan, has email
  // p4: tribe, has email, 3 attendance rows (minAttendance / recency)
  // p5: tribe, has email, but soft-deleted — must always be excluded
  // p6: no tribe/kepanitiaan — control, must never match
  const fixtures = [
    { key: 'p1', tribe: TRIBE, kepanitiaan: null, email: `t9res-p1-${ts}@test.invalid`, deleted: false },
    { key: 'p2', tribe: TRIBE, kepanitiaan: null, email: null, deleted: false },
    { key: 'p3', tribe: null, kepanitiaan: KEPANITIAAN, email: `t9res-p3-${ts}@test.invalid`, deleted: false },
    { key: 'p4', tribe: TRIBE, kepanitiaan: null, email: `t9res-p4-${ts}@test.invalid`, deleted: false },
    { key: 'p5', tribe: TRIBE, kepanitiaan: null, email: `t9res-p5-${ts}@test.invalid`, deleted: true },
    { key: 'p6', tribe: null, kepanitiaan: null, email: `t9res-p6-${ts}@test.invalid`, deleted: false },
  ]

  for (const [i, p] of fixtures.entries()) {
    const { data: person, error: personErr } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62898${ts.toString().slice(-6)}${i}`,
        full_name: `T9RES Person ${p.key}`,
        nickname: p.key,
        tribe: p.tribe,
        kepanitiaan: p.kepanitiaan,
        email: p.email,
      })
      .select('id')
      .single()
    if (personErr || !person) throw new Error(`insert person ${p.key}: ${personErr?.message}`)
    personIds.push(person.id as string)
    if (p.deleted) {
      await serviceAdmin.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', person.id)
    }
  }

  const p4Id = personIds[3]
  for (let i = 0; i < 3; i++) {
    const { error: attErr } = await serviceAdmin.from('attendance').insert({
      event_instance_id: attendanceInstanceIds[i],
      person_id: p4Id,
      checked_in_by: adminUserId,
      checked_in_at: new Date(Date.now() - i * 86_400_000).toISOString(),
    })
    if (attErr) throw new Error(`insert attendance ${i}: ${attErr.message}`)
  }
}, 30_000)

afterAll(async () => {
  if (eventId) await serviceAdmin.from('events').delete().eq('id', eventId) // cascades instances + attendance
  if (personIds.length) await serviceAdmin.from('people').delete().in('id', personIds)
  if (adminUserId) {
    await serviceAdmin.from('app_users').delete().eq('id', adminUserId)
    await serviceAdmin.auth.admin.deleteUser(adminUserId)
  }
}, 30_000)

describe('impl_resolveRecipients', () => {
  it('tribe filter matches only tribe-tagged, non-deleted people; splits has-email/no-email', async () => {
    const result = await impl_resolveRecipients({ supabase: serviceAdmin, filter: { tribe: TRIBE } })
    const hasEmailIds = result.hasEmail.map((r) => r.personId)
    const noEmailIds = result.noEmail.map((r) => r.personId)

    expect(hasEmailIds).toContain(personIds[0]) // p1
    expect(hasEmailIds).toContain(personIds[3]) // p4
    expect(noEmailIds).toContain(personIds[1]) // p2
    expect(hasEmailIds).not.toContain(personIds[4]) // p5 soft-deleted, excluded
    expect(noEmailIds).not.toContain(personIds[4])
    expect(hasEmailIds).not.toContain(personIds[2]) // p3 different filter
    expect(hasEmailIds).not.toContain(personIds[5]) // p6 no tribe
  })

  it('kepanitiaan filter matches only kepanitiaan-tagged people', async () => {
    const result = await impl_resolveRecipients({ supabase: serviceAdmin, filter: { kepanitiaan: KEPANITIAAN } })
    const allIds = [...result.hasEmail.map((r) => r.personId), ...result.noEmail.map((r) => r.personId)]
    expect(allIds).toEqual([personIds[2]])
  })

  it('no-email recipients carry name + phone (F/4)', async () => {
    const result = await impl_resolveRecipients({ supabase: serviceAdmin, filter: { tribe: TRIBE } })
    const p2 = result.noEmail.find((r) => r.personId === personIds[1])
    expect(p2).toBeDefined()
    expect(p2!.fullName).toBe('T9RES Person p2')
    expect(p2!.phoneE164).toMatch(/^\+62898/)
  })

  it('minAttendance filter (via person_attendance_counts) narrows to people meeting the threshold', async () => {
    const result = await impl_resolveRecipients({
      supabase: serviceAdmin,
      filter: { tribe: TRIBE, minAttendance: 2 },
    })
    const allIds = [...result.hasEmail.map((r) => r.personId), ...result.noEmail.map((r) => r.personId)]
    expect(allIds).toEqual([personIds[3]]) // only p4 has 3 attendances
  })

  it('attendanceRecencyDays filter narrows to people who attended within N days', async () => {
    const result = await impl_resolveRecipients({
      supabase: serviceAdmin,
      filter: { tribe: TRIBE, attendanceRecencyDays: 1 },
      now: () => new Date(),
    })
    const allIds = [...result.hasEmail.map((r) => r.personId), ...result.noEmail.map((r) => r.personId)]
    expect(allIds).toEqual([personIds[3]]) // p4's most recent attendance was ~now
  })

  it('combined tribe + kepanitiaan filters both apply (AND, not OR)', async () => {
    const result = await impl_resolveRecipients({
      supabase: serviceAdmin,
      filter: { tribe: TRIBE, kepanitiaan: KEPANITIAAN },
    })
    const allIds = [...result.hasEmail.map((r) => r.personId), ...result.noEmail.map((r) => r.personId)]
    expect(allIds).toHaveLength(0) // no fixture person has both tags
  })
})
