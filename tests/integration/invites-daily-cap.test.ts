// Integration tests for Sprint 6 Task 7 — NOTIFY_DAILY_CAP: a self-imposed
// policy ceiling on app-originated notify email (event invites/resends),
// additive to the existing per-run budget (T4-09). NOT a measured Gmail
// limit, NOT an auth-headroom reservation — auth (GoTrue magic-link) is
// configured entirely outside this codebase and never touches
// event_invitations, so it is structurally excluded from every assertion
// below rather than something the tests filter out.
//
// Runs against local Docker Supabase (.env.test.local). Run: npm test -- invites-daily-cap

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { impl_sendInvites, impl_resendInvite } from '@/lib/actions/invites.impl'
import { toJakartaInstant } from '@/lib/events/timezone'
import type { EmailTransport, EmailMessage, SendEmailResult } from '@/lib/email/transport'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

let serviceAdmin: SupabaseClient
let adminSession: SupabaseClient
let adminId: string
let eventId: string
let instanceId: string
let originalNotifyDailyCap: number
const personIds: string[] = []

const ts = Date.now()
const EMAIL_IDENTITY = { organizerEmail: 'organizer@test.invalid', fromName: 'Test', replyTo: 'reply@test.invalid' }
let phoneCounter = 0

function makeStubTransport(): EmailTransport {
  return {
    async send(msg: EmailMessage): Promise<SendEmailResult> {
      return { ok: true, messageId: `stub-${msg.to}`, response: '250 OK (stub)' }
    },
  }
}

async function createAppUser(label: string, role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `t7cap-${label}-${ts}@test.invalid`
  const pass = `T7CapPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `T7Cap ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function createPeopleWithEmail(tribe: string, count: number): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = []
  for (let i = 0; i < count; i++) {
    const n = phoneCounter++
    const email = `t7cap-${tribe}-${i}-${ts}@test.invalid`
    const { data, error } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62898${ts.toString().slice(-6)}${n.toString().padStart(3, '0')}`,
        full_name: `T7Cap Person ${tribe}-${i}`,
        nickname: `p${i}`,
        tribe,
        email,
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`insert person ${i}: ${error?.message}`)
    out.push({ id: data.id as string, email })
  }
  return out
}

/** Seeds an already-'sent' event_invitations row at an explicit sent_at, to test sent_today counting directly. */
async function seedSentInvitation(tribe: string, sentAt: Date): Promise<string> {
  const [{ id: personId }] = await createPeopleWithEmail(tribe, 1)
  personIds.push(personId)
  const { error } = await serviceAdmin.from('event_invitations').insert({
    event_instance_id: instanceId,
    person_id: personId,
    invited_by: adminId,
    status: 'sent',
    sequence: 0,
    sent_at: sentAt.toISOString(),
  })
  if (error) throw new Error(`seed sent invitation: ${error.message}`)
  return personId
}

async function setNotifyDailyCap(cap: number): Promise<void> {
  const { error } = await serviceAdmin.from('app_settings').update({ notify_daily_cap: cap }).eq('id', 1)
  if (error) throw new Error(`set notify_daily_cap: ${error.message}`)
}

async function unclaimedCount(peopleIds: string[]): Promise<number> {
  const { data } = await serviceAdmin
    .from('event_invitations')
    .select('id')
    .eq('event_instance_id', instanceId)
    .in('person_id', peopleIds)
  return data?.length ?? 0
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUser('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const { data: settingsRow, error: settingsErr } = await serviceAdmin
    .from('app_settings')
    .select('notify_daily_cap')
    .eq('id', 1)
    .single()
  if (settingsErr) throw new Error(`read app_settings: ${settingsErr.message}`)
  originalNotifyDailyCap = (settingsRow as { notify_daily_cap: number }).notify_daily_cap

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: `T7Cap Event ${ts}`,
      event_type: 'adhoc',
      start_date: '2026-09-01',
      start_time: '18:00:00',
      location: 'Test Hall',
      active: true,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  eventId = ev.id as string

  const { data: inst, error: instErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: eventId,
      scheduled_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      event_name_snapshot: `T7Cap Event ${ts}`,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  instanceId = inst.id as string
}, 30_000)

afterAll(async () => {
  await setNotifyDailyCap(originalNotifyDailyCap)
  if (instanceId) await serviceAdmin.from('event_instances').delete().eq('id', instanceId) // cascades event_invitations
  if (eventId) await serviceAdmin.from('events').delete().eq('id', eventId)
  if (personIds.length) await serviceAdmin.from('people').delete().in('id', personIds)
  if (adminId) {
    await serviceAdmin.from('app_users').delete().eq('id', adminId)
    await serviceAdmin.auth.admin.deleteUser(adminId)
  }
}, 30_000)

describe('NOTIFY_DAILY_CAP — impl_sendInvites', () => {
  it('(1) daily cap tighter than the per-run cap: stops a batch at exactly dailyRemaining, rest unclaimed', async () => {
    const tribe = `T7CAP-N01-${ts}`
    const people = await createPeopleWithEmail(tribe, 5)
    personIds.push(...people.map((p) => p.id))

    const fixedNow = new Date('2026-09-10T10:00:00.000Z')
    await setNotifyDailyCap(3) // well under people.length=5; per-run/dynamic caps stay default (loose)

    const result = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(3)
    expect(result.sent).toBe(3)
    expect(result.remaining).toBe(2)
    expect(result.stoppedReason).toBe('daily_cap_exhausted')

    // The 2 recipients past dailyRemaining were never claimed at all.
    const claimed = await unclaimedCount(people.map((p) => p.id))
    expect(claimed).toBe(3)
  })

  it('(2) dailyRemaining <= 0 at run start: zero sends, exactly one notify.daily_cap_deferred row, all unclaimed', async () => {
    const tribe = `T7CAP-N02-${ts}`
    const people = await createPeopleWithEmail(tribe, 3)
    personIds.push(...people.map((p) => p.id))

    const fixedNow = new Date('2026-09-13T10:00:00.000Z') // distinct day bucket — isolates sent_today from test (1)
    await setNotifyDailyCap(0)

    const result = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(0)
    expect(result.sent).toBe(0)
    expect(result.remaining).toBe(3)
    expect(result.stoppedReason).toBe('daily_cap_exhausted')

    const claimed = await unclaimedCount(people.map((p) => p.id))
    expect(claimed).toBe(0)

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_type, entity_id, details_json')
      .eq('entity_id', instanceId)
      .eq('action', 'notify.daily_cap_deferred')
      .order('created_at', { ascending: false })
      .limit(1)

    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].actor_user_id).toBe(adminId)
    expect(auditRows![0].entity_type).toBe('event_instance')
    const details = auditRows![0].details_json as Record<string, unknown>
    expect(details.cap).toBe(0)
    expect(details.sent_today).toBe(0)
    expect(details.requested).toBe(3)
    expect(details.deferred).toBe(3)
  })

  it('(3) sent_today counts only rows inside the Jakarta day window, and resets across the boundary', async () => {
    const seedDay = new Date('2026-09-16T10:00:00.000Z')
    const todayStart = toJakartaInstant(seedDay, '00:00')
    const withinToday = new Date(todayStart.getTime() + 60_000) // 1 min after Jakarta midnight
    const justBeforeToday = new Date(todayStart.getTime() - 60_000) // 1 min before — belongs to the PRIOR Jakarta day

    // 2 real sends "today", 2 real sends "yesterday" (must not count toward today's tally).
    await seedSentInvitation(`T7CAP-N03-SEEDED-${ts}`, withinToday)
    await seedSentInvitation(`T7CAP-N03-SEEDED-${ts}`, withinToday)
    await seedSentInvitation(`T7CAP-N03-SEEDED-${ts}`, justBeforeToday)
    await seedSentInvitation(`T7CAP-N03-SEEDED-${ts}`, justBeforeToday)

    const tribe = `T7CAP-N03-${ts}`
    const people = await createPeopleWithEmail(tribe, 3)
    personIds.push(...people.map((p) => p.id))

    await setNotifyDailyCap(4) // 2 seeded-today + 2 remaining headroom; the 2 "yesterday" rows must NOT subtract

    const first = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => withinToday,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    // dailyRemaining = 4 - 2(today) = 2, NOT 4 - 2 - 2 = 0 — proves yesterday's rows are excluded.
    expect(first.attempted).toBe(2)
    expect(first.remaining).toBe(1)
    expect(first.stoppedReason).toBe('daily_cap_exhausted')

    // Advance 25h — always crosses into the next Jakarta day (fixed UTC+7, no DST) —
    // everything sent above (seeded + this run) is now "yesterday" relative to `nextDay`.
    const nextDay = new Date(withinToday.getTime() + 25 * 60 * 60 * 1000)
    const second = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => nextDay,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.skippedAlreadySent).toBe(2) // already sent in the first call, resolved fresh, skipped not re-sent
    expect(second.attempted).toBe(1) // the one deferred recipient, now resumed
    expect(second.sent).toBe(1)
    expect(second.remaining).toBe(0)
    expect(second.stoppedReason).toBe('completed')
  })

  it('(4) a second sendInvites call resumes exactly the deferred recipients once the day rolls over, zero duplicates', async () => {
    const tribe = `T7CAP-N04-${ts}`
    const people = await createPeopleWithEmail(tribe, 4)
    personIds.push(...people.map((p) => p.id))

    const day1 = new Date('2026-09-20T10:00:00.000Z')
    await setNotifyDailyCap(2)

    const first = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => day1,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.attempted).toBe(2)
    expect(first.remaining).toBe(2)
    expect(first.stoppedReason).toBe('daily_cap_exhausted')

    const day2 = new Date(day1.getTime() + 25 * 60 * 60 * 1000) // next Jakarta day, cap resets
    const second = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => day2,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.skippedAlreadySent).toBe(2)
    expect(second.attempted).toBe(2)
    expect(second.sent).toBe(2)
    expect(second.remaining).toBe(0)
    expect(second.stoppedReason).toBe('completed')

    const { data: rows } = await serviceAdmin
      .from('event_invitations')
      .select('person_id, status')
      .eq('event_instance_id', instanceId)
      .in(
        'person_id',
        people.map((p) => p.id),
      )
    expect(rows).toHaveLength(4) // no duplicate rows across the two calls
    expect(rows!.every((r) => r.status === 'sent')).toBe(true)
  })

  it('(6) per-run cap tighter than the daily cap: the per-run cap still governs (composition, not override)', async () => {
    const tribe = `T7CAP-N06-${ts}`
    const people = await createPeopleWithEmail(tribe, 5)
    personIds.push(...people.map((p) => p.id))

    const fixedNow = new Date('2026-09-24T10:00:00.000Z')
    await setNotifyDailyCap(100) // loose — must not be the binding constraint here

    const result = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
      sendIntervalMs: 1000,
      sendLoopBudgetSeconds: 2, // dynamicCap = floor(2000/1000) = 2, tighter than dailyRemaining=100
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(2)
    expect(result.remaining).toBe(3)
    expect(result.stoppedReason).toBe('run_budget_exhausted')
  })

  it('(6b) dailyRemaining === runCap (tie): attributed to the daily cap, not the per-run cap', async () => {
    const tribe = `T7CAP-N06B-${ts}`
    const people = await createPeopleWithEmail(tribe, 3)
    personIds.push(...people.map((p) => p.id))

    const fixedNow = new Date('2026-09-30T10:00:00.000Z')
    await setNotifyDailyCap(2) // dailyRemaining = 2

    const result = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
      sendIntervalMs: 1000,
      sendLoopBudgetSeconds: 2, // dynamicCap = floor(2000/1000) = 2 = runCap — exact tie with dailyRemaining
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(2)
    expect(result.remaining).toBe(1)
    // Tie goes to daily: the next click would send 0 and hit the pre-loop
    // daily-exhausted path, so 'daily_cap_exhausted' is the honest signal.
    expect(result.stoppedReason).toBe('daily_cap_exhausted')
  })

  it('(7) auth user creation never affects dailyRemaining — auth is structurally excluded, not filtered', async () => {
    const tribe = `T7CAP-N07-${ts}`
    const people = await createPeopleWithEmail(tribe, 1)
    personIds.push(...people.map((p) => p.id))

    const fixedNow = new Date('2026-09-26T10:00:00.000Z')
    await setNotifyDailyCap(1) // exactly enough for 1 recipient — any leak from auth would starve it

    // Creates a real GoTrue auth user + app_users row — the only "send" a magic
    // link produces is entirely inside Supabase Auth, never event_invitations.
    const extraAdmin = await createAppUser('extra', 'admin')

    const result = await impl_sendInvites({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(1) // full cap available — unaffected by the extra auth user just created
    expect(result.remaining).toBe(0)
    expect(result.stoppedReason).toBe('completed')

    await serviceAdmin.from('app_users').delete().eq('id', extraAdmin.id)
    await serviceAdmin.auth.admin.deleteUser(extraAdmin.id)
  })
})

describe('NOTIFY_DAILY_CAP — impl_resendInvite', () => {
  it('(5) resendInvite respects the cap when exhausted: no send, no sequence bump, deferral row written', async () => {
    const tribe = `T7CAP-RESEND-${ts}`
    const [{ id: personId }] = await createPeopleWithEmail(tribe, 1)
    personIds.push(personId)

    const fixedNow = new Date('2026-09-28T10:00:00.000Z')

    const { data: invitation, error } = await serviceAdmin
      .from('event_invitations')
      .insert({
        event_instance_id: instanceId,
        person_id: personId,
        invited_by: adminId,
        status: 'sent',
        sequence: 0,
        sent_at: fixedNow.toISOString(),
      })
      .select('id')
      .single()
    if (error || !invitation) throw new Error(`insert invitation: ${error?.message}`)

    // sent_today already includes this one 'sent' row (sent_at = fixedNow); cap=1 -> sentToday(1) >= cap(1).
    await setNotifyDailyCap(1)

    const result = await impl_resendInvite({
      supabase: adminSession,
      transport: makeStubTransport(),
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
      now: () => fixedNow,
    })

    expect(result.status).toBe('daily_cap_exhausted')
    if (result.status !== 'daily_cap_exhausted') return
    expect(result.sequence).toBe(0) // unchanged — no bump

    const { data: row } = await serviceAdmin
      .from('event_invitations')
      .select('status, sequence')
      .eq('id', invitation.id as string)
      .single()
    expect(row!.status).toBe('sent') // untouched — never flipped to pending
    expect(row!.sequence).toBe(0)

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_type, entity_id, details_json')
      .eq('entity_id', invitation.id as string)
      .eq('action', 'notify.daily_cap_deferred')
      .order('created_at', { ascending: false })
      .limit(1)

    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].actor_user_id).toBe(adminId)
    expect(auditRows![0].entity_type).toBe('event_invitation')
    const details = auditRows![0].details_json as Record<string, unknown>
    expect(details.cap).toBe(1)
    expect(details.sent_today).toBe(1)
    expect(details.requested).toBe(1)
    expect(details.deferred).toBe(1)
    expect(details.person_id).toBe(personId)
  })
})
