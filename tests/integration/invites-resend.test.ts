// Integration tests for Sprint 4 Task 9 — resendInvite: T4-10 (sequence
// increments, no duplicate row, .ics carries the new sequence via a real
// node-ical round-trip parse) + the admin-only guard + audit row. Runs
// against local Docker Supabase (.env.test.local).
// Run: npm test -- invites-resend

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as ical from 'node-ical'
import { impl_resendInvite } from '@/lib/actions/invites.impl'
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
let phoneCounter = 0

async function createAppUser(label: string, role: 'admin' | 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `t9resend-${label}-${ts}@test.invalid`
  const pass = `T9ResendPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `T9Resend ${label}`, role, active: true })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)
  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

function makeCapturingTransport(opts: { fail?: boolean; failMessage?: string } = {}): {
  transport: EmailTransport
  calls: EmailMessage[]
} {
  const calls: EmailMessage[] = []
  const transport: EmailTransport = {
    async send(msg: EmailMessage): Promise<SendEmailResult> {
      calls.push(msg)
      if (opts.fail) return { ok: false, reason: 'smtp_error', message: opts.failMessage ?? 'stub failure' }
      return { ok: true, messageId: `stub-${msg.to}`, response: '250 OK (stub)' }
    },
  }
  return { transport, calls }
}

function parseVEventFromIcs(icsString: string) {
  const parsed = ical.sync.parseICS(icsString)
  const event = Object.values(parsed).find((c) => c?.type === 'VEVENT')
  if (!event || event.type !== 'VEVENT') throw new Error('No VEVENT found in parsed .ics')
  return event
}

async function createPersonWithInvitation(opts: {
  email: string | null
  status: 'sent' | 'failed'
  sequence?: number
}): Promise<{ personId: string; invitationId: string }> {
  const n = phoneCounter++
  const { data: person, error: personErr } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62896${ts.toString().slice(-6)}${n.toString().padStart(3, '0')}`,
      full_name: `T9Resend Person ${n}`,
      nickname: `r${n}`,
      email: opts.email,
    })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person: ${personErr?.message}`)

  const { data: invitation, error: invErr } = await serviceAdmin
    .from('event_invitations')
    .insert({
      event_instance_id: instanceId,
      person_id: person.id,
      invited_by: adminId,
      status: opts.status,
      sequence: opts.sequence ?? 0,
      sent_at: opts.status === 'sent' ? new Date().toISOString() : null,
    })
    .select('id')
    .single()
  if (invErr || !invitation) throw new Error(`insert invitation: ${invErr?.message}`)

  return { personId: person.id as string, invitationId: invitation.id as string }
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
      name: `T9Resend Event ${ts}`,
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
      event_name_snapshot: `T9Resend Event ${ts}`,
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

describe('impl_resendInvite', () => {
  it('T4-10: increments sequence, no duplicate row, .ics carries the new sequence', async () => {
    const { personId, invitationId } = await createPersonWithInvitation({
      email: `t9resend-1-${ts}@test.invalid`,
      status: 'sent',
      sequence: 0,
    })
    personIds.push(personId)

    const { transport, calls } = makeCapturingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
    })

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.sequence).toBe(1)

    const { data: rows } = await serviceAdmin
      .from('event_invitations')
      .select('id, status, sequence')
      .eq('event_instance_id', instanceId)
      .eq('person_id', personId)
    expect(rows).toHaveLength(1) // same row, not a duplicate
    expect(rows![0].id).toBe(invitationId)
    expect(rows![0].status).toBe('sent')
    expect(rows![0].sequence).toBe(1)

    expect(calls).toHaveLength(1)
    const attachment = calls[0].attachments!.find((a) => a.filename === 'invite.ics')!
    const event = parseVEventFromIcs(attachment.content as string)
    expect(event.sequence).toBe(1)
  })

  it('returns not_found for a person never invited to this instance', async () => {
    const n = phoneCounter++
    const { data: person, error } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62896${ts.toString().slice(-6)}${n.toString().padStart(3, '0')}`,
        full_name: 'T9Resend Never Invited',
        nickname: 'ni',
        email: `t9resend-ni-${ts}@test.invalid`,
      })
      .select('id')
      .single()
    if (error || !person) throw new Error(`insert person: ${error?.message}`)
    personIds.push(person.id as string)

    const { transport } = makeCapturingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      personId: person.id as string,
      emailIdentity: EMAIL_IDENTITY,
    })
    expect(result.status).toBe('not_found')
  })

  it('admin-only guard: organizer is rejected', async () => {
    const { personId } = await createPersonWithInvitation({ email: `t9resend-guard-${ts}@test.invalid`, status: 'sent' })
    personIds.push(personId)

    const { transport } = makeCapturingTransport()
    const result = await impl_resendInvite({
      supabase: organizerSession,
      transport,
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
    })
    expect(result.status).toBe('forbidden')
  })

  it('recipient with no email on file: send_failed, sequence NOT incremented (never flipped to pending)', async () => {
    const { personId, invitationId } = await createPersonWithInvitation({ email: null, status: 'sent', sequence: 0 })
    personIds.push(personId)

    const { transport } = makeCapturingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
    })
    expect(result.status).toBe('send_failed')
    if (result.status !== 'send_failed') return
    expect(result.sequence).toBe(0)

    const { data: row } = await serviceAdmin
      .from('event_invitations')
      .select('status, sequence')
      .eq('id', invitationId)
      .single()
    expect(row!.status).toBe('sent') // untouched — never flipped to pending
    expect(row!.sequence).toBe(0)
  })

  it('resend works on a failed row too, not only sent', async () => {
    const { personId, invitationId } = await createPersonWithInvitation({
      email: `t9resend-failed-${ts}@test.invalid`,
      status: 'failed',
      sequence: 0,
    })
    personIds.push(personId)

    const { transport } = makeCapturingTransport()
    const result = await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.sequence).toBe(1)

    const { data: row } = await serviceAdmin
      .from('event_invitations')
      .select('status, sequence')
      .eq('id', invitationId)
      .single()
    expect(row!.status).toBe('sent')
    expect(row!.sequence).toBe(1)
  })

  it('writes one EVENT_INVITE_RESEND audit row with new_sequence + actorUserId', async () => {
    const { personId, invitationId } = await createPersonWithInvitation({
      email: `t9resend-audit-${ts}@test.invalid`,
      status: 'sent',
    })
    personIds.push(personId)

    const { transport } = makeCapturingTransport()
    await impl_resendInvite({
      supabase: adminSession,
      transport,
      eventInstanceId: instanceId,
      personId,
      emailIdentity: EMAIL_IDENTITY,
    })

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_type, entity_id, details_json')
      .eq('entity_id', invitationId)
      .eq('action', 'event_invite.resend')
      .order('created_at', { ascending: false })
      .limit(1)

    expect(auditRows).toHaveLength(1)
    expect(auditRows![0].actor_user_id).toBe(adminId)
    expect(auditRows![0].entity_type).toBe('event_invitation')
    const details = auditRows![0].details_json as Record<string, unknown>
    expect(details.new_sequence).toBe(1)
    expect(details.result).toBe('sent')
  })
})
