// Integration tests for Sprint 4 Task 9 — sendInvites: claim-then-send state
// machine against a stubbed transport + real local Docker Postgres (S2-T8
// lesson: ON CONFLICT/resume must be proven against real Postgres, not a
// mock). Covers T4-05, T4-07, T4-09 (both variants), the admin-only guard,
// and the audit row. Run: npm test -- invites-send

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { impl_sendInvites } from '@/lib/actions/invites.impl'
import type { EmailTransport, EmailMessage, SendEmailResult } from '@/lib/email/transport'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

let serviceAdmin: SupabaseClient
let adminSession: SupabaseClient
let organizerSession: SupabaseClient
let adminId: string
let organizerId: string
let eventId: string
let instanceId: string
const personIds: string[] = []

const ts = Date.now()
const EMAIL_IDENTITY = { organizerEmail: 'organizer@test.invalid', fromName: 'Test', replyTo: 'reply@test.invalid' }

async function createAppUser(label: string, role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `t9send-${label}-${ts}@test.invalid`
  const pass = `T9SendPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `T9Send ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

function makeStubTransport(opts: { failFor?: Set<string>; failMessage?: string } = {}): EmailTransport {
  return {
    async send(msg: EmailMessage): Promise<SendEmailResult> {
      if (opts.failFor?.has(msg.to)) {
        return { ok: false, reason: 'smtp_error', message: opts.failMessage ?? '550 5.4.5 Daily sending quota exceeded' }
      }
      return { ok: true, messageId: `stub-${msg.to}`, response: '250 OK (stub)' }
    },
  }
}

// Module-wide counter, not per-call — phone_e164 is UNIQUE across the whole
// table, and multiple test groups in this file each call createPeopleWithEmail
// with their own tribe, so a per-call index alone would collide across groups.
let phoneCounter = 0

async function createPeopleWithEmail(tribe: string, count: number): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = []
  for (let i = 0; i < count; i++) {
    const n = phoneCounter++
    const email = `t9send-${tribe}-${i}-${ts}@test.invalid`
    const { data, error } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62897${ts.toString().slice(-6)}${n.toString().padStart(3, '0')}`,
        full_name: `T9Send Person ${tribe}-${i}`,
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

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUser('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUser('organizer', 'organizer')
  organizerId = organizer.id
  organizerSession = organizer.session

  const { data: ev, error: evErr } = await serviceAdmin
    .from('events')
    .insert({
      name: `T9Send Event ${ts}`,
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
      event_name_snapshot: `T9Send Event ${ts}`,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  instanceId = inst.id as string
}, 30_000)

afterAll(async () => {
  if (instanceId) await serviceAdmin.from('event_instances').delete().eq('id', instanceId) // cascades event_invitations
  if (eventId) await serviceAdmin.from('events').delete().eq('id', eventId)
  if (personIds.length) await serviceAdmin.from('people').delete().in('id', personIds)
  for (const userId of [adminId, organizerId].filter(Boolean)) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
}, 30_000)

describe('impl_sendInvites', () => {
  it('T4-05: sends to every recipient in a resolved filtered list, one event_invitations row each', async () => {
    const tribe = `T9SEND-N05-${ts}`
    const people = await createPeopleWithEmail(tribe, 12)
    personIds.push(...people.map((p) => p.id))

    const transport = makeStubTransport()
    const result = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(12)
    expect(result.sent).toBe(12)
    expect(result.failed).toBe(0)
    expect(result.remaining).toBe(0)
    expect(result.stoppedReason).toBe('completed')

    const { data: rows } = await serviceAdmin
      .from('event_invitations')
      .select('person_id, status, sequence')
      .eq('event_instance_id', instanceId)
      .in(
        'person_id',
        people.map((p) => p.id),
      )
    expect(rows).toHaveLength(12)
    expect(rows!.every((r) => r.status === 'sent' && r.sequence === 0)).toBe(true)
  })

  it('T4-07: recipients without email are excluded from the send and returned in noEmail', async () => {
    const tribe = `T9SEND-NOEMAIL-${ts}`
    const people = await createPeopleWithEmail(tribe, 2)
    personIds.push(...people.map((p) => p.id))

    const { data: noEmailPerson, error } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62897${ts.toString().slice(-6)}${(phoneCounter++).toString().padStart(3, '0')}`,
        full_name: `T9Send NoEmail ${tribe}`,
        nickname: 'noemail',
        tribe,
        email: null,
      })
      .select('id')
      .single()
    if (error || !noEmailPerson) throw new Error(`insert no-email person: ${error?.message}`)
    personIds.push(noEmailPerson.id as string)

    const transport = makeStubTransport()
    const result = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.attempted).toBe(2)
    expect(result.noEmail).toHaveLength(1)
    expect(result.noEmail[0].personId).toBe(noEmailPerson.id)
    expect(result.noEmail[0].fullName).toBe(`T9Send NoEmail ${tribe}`)

    const { data: rows } = await serviceAdmin
      .from('event_invitations')
      .select('person_id')
      .eq('event_instance_id', instanceId)
      .eq('person_id', noEmailPerson.id)
    expect(rows).toHaveLength(0)
  })

  it('admin-only guard: organizer is rejected, no rows written', async () => {
    const tribe = `T9SEND-GUARD-${ts}`
    const people = await createPeopleWithEmail(tribe, 2)
    personIds.push(...people.map((p) => p.id))

    const transport = makeStubTransport()
    const result = await impl_sendInvites({
      supabase: organizerSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    expect(result.status).toBe('forbidden')

    const { data: rows } = await serviceAdmin
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
      .in(
        'person_id',
        people.map((p) => p.id),
      )
    expect(rows).toHaveLength(0)
  })

  it('T4-09 (budget): pauses cleanly at the run budget, resume completes the remainder with zero duplicates', async () => {
    const tribe = `T9SEND-BUDGET-${ts}`
    const people = await createPeopleWithEmail(tribe, 5)
    personIds.push(...people.map((p) => p.id))

    const transport = makeStubTransport()

    // sendIntervalMs=1000, sendLoopBudgetSeconds=3 -> dynamic cap floor(3000/1000)=3
    const first = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 1000,
      sendLoopBudgetSeconds: 3,
      sleep: async () => {}, // count-based cap under test, not real timing
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.attempted).toBe(3)
    expect(first.sent).toBe(3)
    expect(first.remaining).toBe(2)
    expect(first.stoppedReason).toBe('run_budget_exhausted')

    const second = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.attempted).toBe(2)
    expect(second.sent).toBe(2)
    expect(second.skippedAlreadySent).toBe(3)
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
    expect(rows).toHaveLength(5) // no duplicate rows across the two runs
    expect(rows!.every((r) => r.status === 'sent')).toBe(true)
  })

  it('T4-09 (quota): a stubbed 550 stops the run immediately; resume retries the failure and completes the rest', async () => {
    const tribe = `T9SEND-QUOTA-${ts}`
    const people = await createPeopleWithEmail(tribe, 4)
    personIds.push(...people.map((p) => p.id))

    // people are processed in created_at order (deterministic — see
    // impl_resolveRecipients). Fail the 3rd recipient's send.
    const failingEmail = people[2].email
    const quotaTransport = makeStubTransport({ failFor: new Set([failingEmail]) })

    const first = await impl_sendInvites({
      supabase: adminSession,
      transport: quotaTransport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.attempted).toBe(3) // people[0], people[1] succeed; people[2] fails and stops
    expect(first.sent).toBe(2)
    expect(first.failed).toBe(1)
    expect(first.remaining).toBe(1) // people[3] never reached
    expect(first.stoppedReason).toBe('quota_exhausted')

    const { data: midRows } = await serviceAdmin
      .from('event_invitations')
      .select('person_id, status')
      .eq('event_instance_id', instanceId)
      .eq('person_id', people[2].id)
      .single()
    expect(midRows!.status).toBe('failed')

    const { data: unclaimedRows } = await serviceAdmin
      .from('event_invitations')
      .select('id')
      .eq('event_instance_id', instanceId)
      .eq('person_id', people[3].id)
    expect(unclaimedRows).toHaveLength(0) // truly unclaimed, not a stray pending row

    // Quota "clears" — resume with a transport that now succeeds for everyone.
    const clearTransport = makeStubTransport()
    const second = await impl_sendInvites({
      supabase: adminSession,
      transport: clearTransport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(second.status).toBe('ok')
    if (second.status !== 'ok') return
    expect(second.skippedAlreadySent).toBe(2) // people[0], people[1]
    expect(second.attempted).toBe(2) // retries people[2] (failed->pending->sent), claims people[3] fresh
    expect(second.sent).toBe(2)
    expect(second.remaining).toBe(0)
    expect(second.stoppedReason).toBe('completed')

    const { data: finalRows } = await serviceAdmin
      .from('event_invitations')
      .select('person_id, status, sequence')
      .eq('event_instance_id', instanceId)
      .in(
        'person_id',
        people.map((p) => p.id),
      )
    expect(finalRows).toHaveLength(4) // no duplicates
    expect(finalRows!.every((r) => r.status === 'sent')).toBe(true)
    // Automatic retry of a failed row never increments sequence — only an
    // explicit resendInvite() does (E/4).
    expect(finalRows!.every((r) => r.sequence === 0)).toBe(true)
  })

  it('writes one EVENT_INVITE_SEND audit row with the named action + actorUserId', async () => {
    const tribe = `T9SEND-AUDIT-${ts}`
    const people = await createPeopleWithEmail(tribe, 2)
    personIds.push(...people.map((p) => p.id))

    const transport = makeStubTransport()
    await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      filter: { tribe },
      emailIdentity: EMAIL_IDENTITY,
      sendIntervalMs: 0,
      sleep: async () => {},
    })

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_type, entity_id, details_json')
      .eq('entity_id', instanceId)
      .eq('action', 'event_invite.send')
      .order('created_at', { ascending: false })
      .limit(1)

    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].action).toBe('event_invite.send')
    expect(auditRows![0].actor_user_id).toBe(adminId)
    expect(auditRows![0].entity_type).toBe('event_instance')
    const details = auditRows![0].details_json as Record<string, unknown>
    expect(details.sent).toBe(2)
  })
})
