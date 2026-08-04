// No 'use server' — imported by invites.ts (server actions) and by tests.
// Never import this file in Client Components.
//
// Deps (supabase, transport, now, sleep, budget/interval) are all injected so
// Vitest can drive the claim-then-send loop against a stubbed transport and a
// near-zero interval without waiting on real timers — the real values are
// wired only in invites.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIcs } from '@/lib/events/ics'
import { renderInviteEmail } from '@/lib/email/template'
import type { EmailTransport, SendEmailResult } from '@/lib/email/transport'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import type {
  RecipientFilter,
  ResolveRecipientsResult,
  HasEmailRecipient,
  NoEmailRecipient,
  SendInvitesResult,
  ResendInviteResult,
  StoppedReason,
} from './invites.types'

// T9 plan (Phase 0): 240s work budget inside Vercel Hobby's 300s hard wall, 30s
// reserved for setup/teardown (resolution query, audit write) → 210s send loop.
// 8s/send is well under the ~10/min pattern that trips Gmail's behavioral
// throttle. floor(210/8) = 26; enforced as 25 for one unit of extra margin.
const SEND_LOOP_BUDGET_SECONDS_DEFAULT = 210
const SEND_INTERVAL_MS_DEFAULT = 8000
const MAX_SENDS_PER_RUN_CAP = 25

// Gmail-message-shaped heuristic, not a structured error code (nodemailer/SMTP
// gives us none). Revisit if the transport ever changes (A/4 — Resend someday
// has different error shapes).
const QUOTA_ERROR_PATTERN = /\b550\b|quota|rate.?limit|too many/i

function isQuotaExhaustedError(message: string): boolean {
  return QUOTA_ERROR_PATTERN.test(message)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type EmailIdentity = { organizerEmail: string; fromName: string; replyTo: string }

// ── admin-only guard (primary control; RLS is the backstop — schema note) ──────

type AdminGuardResult =
  | { ok: true; actorId: string }
  | { ok: false; result: { status: 'forbidden'; message: string } | { status: 'error'; message: string } }

async function assertAdmin(supabase: SupabaseClient): Promise<AdminGuardResult> {
  const result = await requireActiveAdmin(supabase)
  if (result.status === 'unauthenticated') {
    return { ok: false, result: { status: 'error', message: 'Not authenticated' } }
  }
  if (result.status === 'denied') {
    return { ok: false, result: { status: 'forbidden', message: 'Admin only' } }
  }
  return { ok: true, actorId: result.actorId }
}

// ── recipient resolution (F/2 filters, F/4 two-list split) ────────────────────

interface PersonCandidateRow {
  id: string
  full_name: string
  phone_e164: string
  email: string | null
}

export async function impl_resolveRecipients({
  supabase,
  filter,
  now = () => new Date(),
}: {
  supabase: SupabaseClient
  filter: RecipientFilter
  now?: () => Date
}): Promise<ResolveRecipientsResult> {
  let query = supabase
    .from('people')
    .select('id, full_name, phone_e164, email')
    .is('deleted_at', null) // F/2 — non-optional
    // Deterministic queue order: a partial run's "remaining" is predictable
    // across resumes (and testable), not an unspecified Postgres row order.
    .order('created_at', { ascending: true })

  if (filter.tribe) query = query.eq('tribe', filter.tribe)
  if (filter.kepanitiaan) query = query.eq('kepanitiaan', filter.kepanitiaan)

  const { data: peopleRows, error } = await query
  if (error) throw error

  let candidates = (peopleRows ?? []) as PersonCandidateRow[]

  if (filter.attendanceRecencyDays !== undefined || filter.minAttendance !== undefined) {
    const candidateIds = candidates.map((p) => p.id)
    if (candidateIds.length === 0) {
      return { hasEmail: [], noEmail: [] }
    }

    let attnQuery = supabase
      .from('person_attendance_counts')
      .select('person_id, total_attendance, last_attended_at')
      .in('person_id', candidateIds)

    if (filter.minAttendance !== undefined) {
      attnQuery = attnQuery.gte('total_attendance', filter.minAttendance)
    }
    if (filter.attendanceRecencyDays !== undefined) {
      const cutoff = new Date(now().getTime() - filter.attendanceRecencyDays * 24 * 60 * 60 * 1000).toISOString()
      attnQuery = attnQuery.gte('last_attended_at', cutoff)
    }

    const { data: attnRows, error: attnError } = await attnQuery
    if (attnError) throw attnError

    const matchingIds = new Set((attnRows ?? []).map((r) => r.person_id as string))
    candidates = candidates.filter((p) => matchingIds.has(p.id))
  }

  const hasEmail: HasEmailRecipient[] = []
  const noEmail: NoEmailRecipient[] = []
  for (const p of candidates) {
    if (p.email) {
      hasEmail.push({ personId: p.id, fullName: p.full_name, email: p.email })
    } else {
      noEmail.push({ personId: p.id, fullName: p.full_name, phoneE164: p.phone_e164 })
    }
  }

  return { hasEmail, noEmail }
}

// ── event_instances + events join (T7 finding: instance alone lacks location/duration) ──

interface InstanceEventDetails {
  eventInstanceId: string
  scheduledAt: Date
  durationMin: number
  eventNameEn: string
  eventNameId: string | null
  location: string | null
  imageUrl: string | null
}

async function loadInstanceEventDetails(
  supabase: SupabaseClient,
  eventInstanceId: string,
): Promise<InstanceEventDetails | null> {
  const { data: instance } = await supabase
    .from('event_instances')
    .select('id, event_id, scheduled_at, event_name_snapshot, event_name_snapshot_id, image_url')
    .eq('id', eventInstanceId)
    .single()
  if (!instance) return null

  const { data: event } = await supabase
    .from('events')
    .select('location, duration_min')
    .eq('id', instance.event_id)
    .single()
  if (!event) return null

  return {
    eventInstanceId: instance.id,
    scheduledAt: new Date(instance.scheduled_at),
    durationMin: event.duration_min,
    eventNameEn: instance.event_name_snapshot,
    eventNameId: instance.event_name_snapshot_id,
    location: event.location,
    imageUrl: instance.image_url,
  }
}

// ── claim-then-send state machine (S2-T8 lesson: the UNIQUE constraint is the substrate) ──

interface ClaimedInvitation {
  id: string
  sequence: number
}

type ClaimResult =
  | { alreadySent: true }
  | { alreadySent: false; invitation: ClaimedInvitation }

/**
 * SELECT-before-INSERT + 23505 race backstop (S1-T5 TOCTOU pattern). The claim
 * (INSERT status='pending') always happens before transport.send() — this is
 * what makes a crashed/retried run resumable: a claimed row records "this
 * recipient was attempted" independent of whether the send itself completed.
 *
 * Honest caveat (accepted, not fixed — same shape as Phase 0's hard-kill
 * reasoning and the birthday-digest concurrency gap): a `pending` row is
 * ambiguous about whether the email actually went out, because the crash
 * window spans claim → transport.send() → UPDATE status='sent'. A crash after
 * transport.send() returns success but before the status UPDATE lands means a
 * resume will retry a send that already succeeded — one duplicate email, not a
 * duplicate row (the UNIQUE constraint still holds) and not data corruption.
 * The window is milliseconds wide per recipient; not worth a two-phase commit
 * or an outbox table for this volume. Documented, not fixed.
 */
async function claimInvitation(
  supabase: SupabaseClient,
  eventInstanceId: string,
  personId: string,
  actorId: string,
): Promise<ClaimResult> {
  const { data: existing } = await supabase
    .from('event_invitations')
    .select('id, status, sequence')
    .eq('event_instance_id', eventInstanceId)
    .eq('person_id', personId)
    .maybeSingle()

  if (existing) {
    if (existing.status === 'sent') return { alreadySent: true }
    return { alreadySent: false, invitation: { id: existing.id, sequence: existing.sequence } }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('event_invitations')
    .insert({
      event_instance_id: eventInstanceId,
      person_id: personId,
      invited_by: actorId,
      status: 'pending',
      sequence: 0,
    })
    .select('id, sequence')
    .single()

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced } = await supabase
        .from('event_invitations')
        .select('id, status, sequence')
        .eq('event_instance_id', eventInstanceId)
        .eq('person_id', personId)
        .single()
      if (!raced) throw insertError
      if (raced.status === 'sent') return { alreadySent: true }
      return { alreadySent: false, invitation: { id: raced.id, sequence: raced.sequence } }
    }
    throw insertError
  }

  return { alreadySent: false, invitation: { id: inserted.id, sequence: inserted.sequence } }
}

async function buildAndSend({
  transport,
  details,
  recipient,
  sequence,
  emailIdentity,
  now,
}: {
  transport: EmailTransport
  details: InstanceEventDetails
  recipient: { fullName: string; email: string }
  sequence: number
  emailIdentity: EmailIdentity
  now: Date
}): Promise<SendEmailResult> {
  const rendered = renderInviteEmail({
    eventNameEn: details.eventNameEn,
    eventNameId: details.eventNameId,
    scheduledAt: details.scheduledAt,
    durationMin: details.durationMin,
    location: details.location,
    imageUrl: details.imageUrl,
  })

  // ORGANIZER/ATTENDEE starting position (T9 plan): included so Outlook renders
  // an actual Accept/Decline invitation, not a passive calendar add. Makes the
  // .ics per-recipient (ATTENDEE differs per person) — UID stays instance-
  // stable, sequence stays per-(instance,person). Confirm/adjust at T4-08 live.
  const ics = generateIcs({
    eventInstanceId: details.eventInstanceId,
    summary: details.eventNameId ?? details.eventNameEn,
    location: details.location,
    scheduledAt: details.scheduledAt,
    durationMin: details.durationMin,
    sequence,
    dtstamp: now,
    organizerEmail: emailIdentity.organizerEmail,
    attendeeEmail: recipient.email,
    attendeeName: recipient.fullName,
  })

  return transport.send({
    to: recipient.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: emailIdentity.fromName,
    replyTo: emailIdentity.replyTo,
    attachments: [
      {
        filename: 'invite.ics',
        content: ics,
        // method=REQUEST drives add-to-calendar UI (T8 forward-flag), not a
        // generic file download.
        contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      },
    ],
  })
}

// ── sendInvites — idempotent queue, never touches an already-sent row ─────────

export interface SendInvitesInput {
  supabase: SupabaseClient
  transport: EmailTransport
  eventInstanceId: string
  filter: RecipientFilter
  emailIdentity: EmailIdentity
  now?: () => Date
  sendIntervalMs?: number
  sendLoopBudgetSeconds?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Resolves recipients from `filter` fresh on every call (never trusts a stale
 * client-supplied list — S3-T8 lesson) and processes the has-email list in
 * order. Self-paces at ~MAX_SENDS_PER_RUN_CAP sends and stops cleanly
 * (`run_budget_exhausted`) rather than risk a hard kill at the Vercel wall.
 * Re-invoking with the SAME filter resumes: already-`sent` rows are skipped,
 * `pending`/`failed` rows are retried, unclaimed recipients get claimed fresh
 * — zero duplicate rows, by the UNIQUE(event_instance_id, person_id)
 * constraint.
 *
 * Honest caveat (documented, not fixed): a quota-stopped run leaves the
 * recipient it was mid-send-to as `failed`. On the next call, `failed` rows
 * are retried in filter-resolution order — i.e. BEFORE the still-unclaimed
 * remainder — so "resume after quota" re-attempts the send most likely to hit
 * the same wall again, first. Harmless for a transient/bad-address failure;
 * for a genuine quota exhaustion it means the retry immediately re-trips the
 * same throttle before reaching anyone new. No retry-count/priority column in
 * Sprint 4 scope — if this proves costly in practice, that's the trigger to
 * add one.
 */
export async function impl_sendInvites(input: SendInvitesInput): Promise<SendInvitesResult> {
  const {
    supabase,
    transport,
    eventInstanceId,
    filter,
    emailIdentity,
    now = () => new Date(),
    sendIntervalMs = SEND_INTERVAL_MS_DEFAULT,
    sendLoopBudgetSeconds = SEND_LOOP_BUDGET_SECONDS_DEFAULT,
    sleep = defaultSleep,
  } = input

  const guard = await assertAdmin(supabase)
  if (!guard.ok) return guard.result
  const actorId = guard.actorId

  const details = await loadInstanceEventDetails(supabase, eventInstanceId)
  if (!details) return { status: 'error', message: 'Event instance not found' }

  const { hasEmail, noEmail } = await impl_resolveRecipients({ supabase, filter, now })

  const dynamicCap =
    sendIntervalMs > 0 ? Math.floor((sendLoopBudgetSeconds * 1000) / sendIntervalMs) : Number.POSITIVE_INFINITY
  const maxSendsThisRun = Math.min(dynamicCap, MAX_SENDS_PER_RUN_CAP)

  let attempted = 0
  let sent = 0
  let failed = 0
  let skippedAlreadySent = 0
  let stoppedReason: StoppedReason = 'completed'

  for (let i = 0; i < hasEmail.length; i++) {
    const recipient = hasEmail[i]

    // Budget check BEFORE claiming — a recipient we won't reach this run stays
    // truly unclaimed (no row at all), not a claimed-but-untouched 'pending'.
    if (attempted >= maxSendsThisRun) {
      stoppedReason = 'run_budget_exhausted'
      break
    }

    const claim = await claimInvitation(supabase, eventInstanceId, recipient.personId, actorId)
    if (claim.alreadySent) {
      skippedAlreadySent++
      continue
    }

    const sendTime = now()
    const result = await buildAndSend({
      transport,
      details,
      recipient,
      sequence: claim.invitation.sequence,
      emailIdentity,
      now: sendTime,
    })
    attempted++

    if (result.ok) {
      sent++
      await supabase
        .from('event_invitations')
        .update({ status: 'sent', sent_at: sendTime.toISOString(), error: null })
        .eq('id', claim.invitation.id)
    } else {
      failed++
      await supabase
        .from('event_invitations')
        .update({ status: 'failed', error: result.message })
        .eq('id', claim.invitation.id)

      if (isQuotaExhaustedError(result.message)) {
        stoppedReason = 'quota_exhausted'
        break
      }
    }

    const isLast = i === hasEmail.length - 1
    if (!isLast && attempted < maxSendsThisRun) {
      await sleep(sendIntervalMs)
    }
  }

  const remaining = hasEmail.length - attempted - skippedAlreadySent

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.EVENT_INVITE_SEND,
      entityType: 'event_instance',
      entityId: eventInstanceId,
      detailsJson: {
        filter,
        resolved_has_email: hasEmail.length,
        resolved_no_email: noEmail.length,
        attempted,
        sent,
        failed,
        skipped_already_sent: skippedAlreadySent,
        remaining,
        stopped_reason: stoppedReason,
      },
    },
    supabase,
  )

  return {
    status: 'ok',
    eventInstanceId,
    noEmail,
    attempted,
    sent,
    failed,
    skippedAlreadySent,
    remaining,
    stoppedReason,
  }
}

// ── resendInvite — explicit, single-recipient, always increments sequence (E/4) ──

export interface ResendInviteInput {
  supabase: SupabaseClient
  transport: EmailTransport
  eventInstanceId: string
  personId: string
  emailIdentity: EmailIdentity
  now?: () => Date
}

/**
 * The ONLY place `sequence` increments. Unlike sendInvites' automatic retry of
 * pending/failed (never increments — nothing was ever delivered to update),
 * this is a deliberate re-invite: same UID, higher SEQUENCE, so the
 * recipient's calendar entry updates instead of duplicating (E/4). Works
 * regardless of the row's current status (sent/failed/pending) — one uniform
 * "resend now" action for T10. Validates the recipient still has an email
 * BEFORE flipping the row to pending, so a failed lookup never leaves the row
 * in a claimed-but-unsendable state.
 */
export async function impl_resendInvite(input: ResendInviteInput): Promise<ResendInviteResult> {
  const { supabase, transport, eventInstanceId, personId, emailIdentity, now = () => new Date() } = input

  const guard = await assertAdmin(supabase)
  if (!guard.ok) return guard.result
  const actorId = guard.actorId

  const { data: existing } = await supabase
    .from('event_invitations')
    .select('id, sequence')
    .eq('event_instance_id', eventInstanceId)
    .eq('person_id', personId)
    .maybeSingle()
  if (!existing) return { status: 'not_found' }

  const details = await loadInstanceEventDetails(supabase, eventInstanceId)
  if (!details) return { status: 'send_failed', message: 'Event instance not found', sequence: existing.sequence }

  const { data: person } = await supabase.from('people').select('full_name, email').eq('id', personId).single()
  if (!person?.email) {
    return { status: 'send_failed', message: 'Recipient has no email on file', sequence: existing.sequence }
  }

  const newSequence = existing.sequence + 1
  const { error: claimError } = await supabase
    .from('event_invitations')
    .update({ status: 'pending', sequence: newSequence })
    .eq('id', existing.id)
  if (claimError) throw claimError

  const sendTime = now()
  const result = await buildAndSend({
    transport,
    details,
    recipient: { fullName: person.full_name, email: person.email },
    sequence: newSequence,
    emailIdentity,
    now: sendTime,
  })

  if (result.ok) {
    await supabase
      .from('event_invitations')
      .update({ status: 'sent', sent_at: sendTime.toISOString(), error: null })
      .eq('id', existing.id)
  } else {
    await supabase.from('event_invitations').update({ status: 'failed', error: result.message }).eq('id', existing.id)
  }

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.EVENT_INVITE_RESEND,
      entityType: 'event_invitation',
      entityId: existing.id,
      detailsJson: {
        event_instance_id: eventInstanceId,
        person_id: personId,
        new_sequence: newSequence,
        result: result.ok ? 'sent' : 'failed',
      },
    },
    supabase,
  )

  if (result.ok) return { status: 'ok', sequence: newSequence }
  return { status: 'send_failed', message: result.message, sequence: newSequence }
}
