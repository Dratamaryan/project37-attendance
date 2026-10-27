// Integration tests for S9.5-T2 — invite guard: sendInvites and resendInvite
// refuse ('instance_not_open') unless the instance is 'scheduled' AND its
// event is active. A refusal claims nothing, sends nothing and never bumps
// `sequence`.
//
// Runs against local Docker Supabase (.env.test.local). Run: npm test -- invites-instance-guard

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { impl_sendInvites, impl_resendInvite } from '@/lib/actions/invites.impl'
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
let personId: string
const eventIds: string[] = []
const instanceIds: string[] = []

// Instance fixtures
let openInstanceId: string           // scheduled, active event
let cancelledInstanceId: string      // cancelled, active event
let inactiveEventInstanceId: string  // scheduled, inactive event

const ts = Date.now()
const TRIBE = `S95GUARD-${ts}`
const EMAIL_IDENTITY = { organizerEmail: 'organizer@test.invalid', fromName: 'Test', replyTo: 'reply@test.invalid' }
const FIXED_NOW = new Date('2026-11-02T03:00:00.000Z')

function makeCountingTransport(): { transport: EmailTransport; calls: () => number } {
  let n = 0
  return {
    transport: {
      async send(msg: EmailMessage): Promise<SendEmailResult> {
        n++
        return { ok: true, messageId: `stub-${msg.to}`, response: '250 OK (stub)' }
      },
    },
    calls: () => n,
  }
}

async function createEvent(label: string, active: boolean): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('events')
    .insert({
      name: `S95Guard ${label} ${ts}`,
      event_type: 'adhoc',
      start_date: '2026-11-14',
      start_time: '15:00:00',
      location: 'Test Hall',
      active,
      created_by: adminId,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert event ${label}: ${error?.message}`)
  eventIds.push(data.id as string)
  return data.id as string
}

async function createInstance(eventId: string, status: 'scheduled' | 'cancelled', dayOffset: number): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: eventId,
      scheduled_at: new Date(Date.now() + dayOffset * 86_400_000).toISOString(),
      event_name_snapshot: `S95Guard ${ts}`,
      status,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insert instance: ${error?.message}`)
  instanceIds.push(data.id as string)
  return data.id as string
}

async function seedSentInvitation(instanceId: string): Promise<void> {
  const { error } = await serviceAdmin.from('event_invitations').insert({
    event_instance_id: instanceId,
    person_id: personId,
    invited_by: adminId,
    status: 'sent',
    sequence: 0,
    sent_at: new Date('2026-10-20T03:00:00.000Z').toISOString(),
  })
  if (error) throw new Error(`seed sent invitation: ${error.message}`)
}

async function invitationRows(instanceId: string): Promise<{ status: string; sequence: number }[]> {
  const { data, error } = await serviceAdmin
    .from('event_invitations')
    .select('status, sequence')
    .eq('event_instance_id', instanceId)
  if (error) throw new Error(`read invitations: ${error.message}`)
  return (data ?? []) as { status: string; sequence: number }[]
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const email = `s95guard-admin-${ts}@test.invalid`
  const pass = `S95GuardPass-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  adminId = authData.user.id
  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: adminId, email, full_name: 'S95Guard admin', role: 'admin', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)
  adminSession = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await adminSession.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)

  const { data: person, error: personErr } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62897${ts.toString().slice(-7)}`,
      full_name: 'S95Guard Person',
      nickname: 'g',
      tribe: TRIBE,
      email: `s95guard-person-${ts}@test.invalid`,
    })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person: ${personErr?.message}`)
  personId = person.id as string

  const activeEventId = await createEvent('active', true)
  const inactiveEventId = await createEvent('inactive', false)
  openInstanceId = await createInstance(activeEventId, 'scheduled', 5)
  cancelledInstanceId = await createInstance(activeEventId, 'cancelled', 6)
  inactiveEventInstanceId = await createInstance(inactiveEventId, 'scheduled', 7)
}, 30_000)

afterAll(async () => {
  if (instanceIds.length) await serviceAdmin.from('event_instances').delete().in('id', instanceIds) // cascades event_invitations
  if (eventIds.length) await serviceAdmin.from('events').delete().in('id', eventIds)
  if (personId) await serviceAdmin.from('people').delete().eq('id', personId)
  if (adminId) {
    await serviceAdmin.from('app_users').delete().eq('id', adminId)
    await serviceAdmin.auth.admin.deleteUser(adminId)
  }
}, 30_000)

describe('S9.5-T2 invite guard — impl_sendInvites', () => {
  it('IG-01: cancelled instance → instance_not_open; nothing claimed, transport never called', async () => {
    const { transport, calls } = makeCountingTransport()
    const result = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: cancelledInstanceId,
      filter: { tribe: TRIBE },
      emailIdentity: EMAIL_IDENTITY,
      now: () => FIXED_NOW,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(result).toEqual({ status: 'instance_not_open' })
    expect(calls()).toBe(0)
    expect(await invitationRows(cancelledInstanceId)).toEqual([])
  })

  it('IG-02: scheduled instance of an inactive event → instance_not_open; nothing claimed', async () => {
    const { transport, calls } = makeCountingTransport()
    const result = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: inactiveEventInstanceId,
      filter: { tribe: TRIBE },
      emailIdentity: EMAIL_IDENTITY,
      now: () => FIXED_NOW,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(result).toEqual({ status: 'instance_not_open' })
    expect(calls()).toBe(0)
    expect(await invitationRows(inactiveEventInstanceId)).toEqual([])
  })

  it('IG-03: control — scheduled instance of an active event still sends', async () => {
    const { transport, calls } = makeCountingTransport()
    const result = await impl_sendInvites({
      supabase: adminSession,
      transport,
      eventInstanceId: openInstanceId,
      filter: { tribe: TRIBE },
      emailIdentity: EMAIL_IDENTITY,
      now: () => FIXED_NOW,
      sendIntervalMs: 0,
      sleep: async () => {},
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.sent).toBe(1)
    expect(calls()).toBe(1)
  })
})

describe('S9.5-T2 invite guard — impl_resendInvite', () => {
  it('IG-04: cancelled instance → instance_not_open; row and sequence unchanged, transport never called', async () => {
    await seedSentInvitation(cancelledInstanceId)
    const { transport, calls } = makeCountingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: cancelledInstanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
      now: () => FIXED_NOW,
    })
    expect(result).toEqual({ status: 'instance_not_open' })
    expect(calls()).toBe(0)
    expect(await invitationRows(cancelledInstanceId)).toEqual([{ status: 'sent', sequence: 0 }])
  })

  it('IG-05: scheduled instance of an inactive event → instance_not_open; row and sequence unchanged', async () => {
    await seedSentInvitation(inactiveEventInstanceId)
    const { transport, calls } = makeCountingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: inactiveEventInstanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
      now: () => FIXED_NOW,
    })
    expect(result).toEqual({ status: 'instance_not_open' })
    expect(calls()).toBe(0)
    expect(await invitationRows(inactiveEventInstanceId)).toEqual([{ status: 'sent', sequence: 0 }])
  })
})
