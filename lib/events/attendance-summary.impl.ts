import type { SupabaseClient } from '@supabase/supabase-js'

import {
  computeIctDayBounds,
  groupAttendanceByInstance,
  formatAttendanceSummary,
  type AttendanceRow,
} from '@/lib/events/attendance-summary'
import { formatJakarta } from '@/lib/events/timezone'
import { sendTelegramMessage, type SendTelegramMessageResult } from '@/lib/telegram/client'
import { resolveChatId } from '@/lib/telegram/chat-id'
import { claimCronSlot, resolveCronClaim } from '@/lib/cron/idempotent-claim'

// See birthday-digest.impl.ts's identical comment for the full rationale —
// lib/telegram/token.ts imports `server-only`, which throws outside a real
// server context (including under Vitest). Deferred to a dynamic import so
// it's only evaluated on the real cron-route path.
async function defaultGetToken(): Promise<string> {
  const { getTelegramBotToken } = await import('@/lib/telegram/token')
  return getTelegramBotToken()
}

export const ATTENDANCE_SUMMARY_SOURCE = 'attendance-summary'

export type AttendanceSummaryResult =
  | { status: 'skipped_already_sent'; ict_date: string; flipped_count: number }
  | { status: 'skipped_concurrent'; ict_date: string; flipped_count: number }
  | { status: 'empty'; ict_date: string; flipped_count: number }
  | { status: 'sent'; ict_date: string; count: number; message_id: number; flipped_count: number }
  | { status: 'send_failed'; ict_date: string; count: number; reason: string; flipped_count: number }

export type AttendanceSummaryInput = {
  /** MUST be the admin (service-role) client — attendance_summary is
   * WITH (security_invoker = on), so RLS runs as the querying role; this
   * cron has no user session, so only the admin client sees any rows. */
  supabase: SupabaseClient
  now: Date
  /** Injected for tests; defaults to the real Telegram Bot API call */
  sendMessage?: (params: {
    token: string
    chatId: string
    text: string
  }) => Promise<SendTelegramMessageResult>
  /** Injected for tests; defaults to reading TELEGRAM_BOT_TOKEN via getTelegramBotToken() */
  getToken?: () => string | Promise<string>
}

type AppSettingsChatIdRow = { telegram_admin_chat_id: string | null }

type FlipCandidateRow = {
  id: string
  scheduled_at: string
  events: { duration_min: number }
}

/** WIB calendar date ('yyyy-MM-dd') on which an instance ends. scheduled_at is
 * a full timestamptz (explicit offset), so parsing it yields an exact instant;
 * the calendar date is only ever derived in Asia/Jakarta via formatJakarta. */
function instanceEndWibDate(scheduledAt: string, durationMin: number): string {
  const endInstant = new Date(Date.parse(scheduledAt) + durationMin * 60_000)
  return formatJakarta(endInstant, 'yyyy-MM-dd')
}

/**
 * Flips event_instances from 'scheduled' to 'completed' iff the WIB date of
 * their end (scheduled_at + events.duration_min) is strictly before the WIB
 * date of `now` (the injected clock). Never touches 'cancelled' or 'completed'
 * (excluded structurally by the status='scheduled' predicate on both the read
 * and the write). Idempotent — a second call with the same or later `now` only
 * matches rows still 'scheduled'.
 *
 * S8-T9 tightened this from S5-T5's `scheduled_at < now`. That rule completed
 * an instance the moment it STARTED, so an off-schedule fire (the admin "Run
 * now" trigger, or a late-night event) dropped a still-running or just-ended
 * event out of the /checkin picker (which lists status='scheduled' only) —
 * S5-T5 accepted that risk on the assumption that only the 23:30 ICT cron ever
 * flips. The end-day rule removes it: an instance stays 'scheduled', and
 * check-in-able, for the whole WIB day it ends on, whatever the fire time.
 * Consequence: the 23:30 ICT run no longer completes that same day's events;
 * the next night's run does. Events crossing WIB midnight complete after their
 * end day, not their start day.
 *
 * `scheduled_at < now` stays on the read as a cheap narrowing pre-filter (any
 * instance that ended before today's WIB date started before now); the
 * end-date comparison happens here, as 'yyyy-MM-dd' string compares.
 *
 * Called unconditionally, before the send-idempotency claim, on every
 * invocation — the day's events occurred regardless of whether the digest
 * send succeeds or whether this invocation wins the claim race. Decoupling
 * this from claim-acquisition means it never depends on winning the send race.
 */
export async function flipCompletedInstances(supabase: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await supabase
    .from('event_instances')
    .select('id, scheduled_at, events!inner(duration_min)')
    .eq('status', 'scheduled')
    .lt('scheduled_at', now.toISOString())

  if (error) {
    throw new Error(`Failed to read flip candidates: ${error.message}`)
  }

  const todayWib = formatJakarta(now, 'yyyy-MM-dd')
  const ids = ((data ?? []) as unknown as FlipCandidateRow[])
    .filter((row) => instanceEndWibDate(row.scheduled_at, row.events.duration_min) < todayWib)
    .map((row) => row.id)

  if (ids.length === 0) return 0

  const { data: flipped, error: updateError } = await supabase
    .from('event_instances')
    .update({ status: 'completed' })
    .in('id', ids)
    .eq('status', 'scheduled')
    .select('id')

  if (updateError) {
    throw new Error(`Failed to flip completed instances: ${updateError.message}`)
  }

  return (flipped ?? []).length
}

/**
 * Attendance summary cron body — DB reads/writes + Telegram send, called with
 * `now` captured once by the route handler (never a second `new Date()` here,
 * per D/3). Reports the ICT day that is ENDING at the 23:30 fire time (D/2),
 * grouped by event instance (cancelled instances are annotated, not hidden —
 * see attendance-summary.ts's instanceLabel).
 *
 * Idempotency: claim-first against system_health(source, ict_date) via
 * lib/cron/idempotent-claim.ts (Sprint 5 T5) — identical mechanism and
 * identical accepted residual to birthday-digest.impl.ts's runBirthdayDigest;
 * see that file's comment and docs/sprint-5-task-5-verify.md.
 */
export async function runAttendanceSummary(input: AttendanceSummaryInput): Promise<AttendanceSummaryResult> {
  const {
    supabase,
    now,
    sendMessage = sendTelegramMessage,
    getToken = defaultGetToken,
  } = input

  const flippedCount = await flipCompletedInstances(supabase, now)

  const { ictDate, startUtc, endUtc } = computeIctDayBounds(now)

  const claim = await claimCronSlot({ supabase, source: ATTENDANCE_SUMMARY_SOURCE, ictDate, now })
  if (claim.outcome === 'already_done') {
    return { status: 'skipped_already_sent', ict_date: ictDate, flipped_count: flippedCount }
  }
  if (claim.outcome === 'concurrent') {
    return { status: 'skipped_concurrent', ict_date: ictDate, flipped_count: flippedCount }
  }
  const { claimId } = claim

  const { data: rawRows, error: attendanceErr } = await supabase
    .from('attendance_summary')
    .select(
      'event_instance_id, full_name, checked_in_at, event_name_snapshot, event_name_snapshot_id, scheduled_at, instance_status',
    )
    .gte('checked_in_at', startUtc.toISOString())
    .lt('checked_in_at', endUtc.toISOString())
    .order('checked_in_at', { ascending: true })

  if (attendanceErr) {
    throw new Error(`Failed to read attendance_summary: ${attendanceErr.message}`)
  }

  const rows = (rawRows ?? []) as AttendanceRow[]

  if (rows.length === 0) {
    await resolveCronClaim({
      supabase,
      claimId,
      status: 'ok',
      now,
      payload: { source: ATTENDANCE_SUMMARY_SOURCE, ict_date: ictDate, count: 0 },
    })
    return { status: 'empty', ict_date: ictDate, flipped_count: flippedCount }
  }

  const instances = groupAttendanceByInstance(rows)
  const count = rows.length

  const { data: rawSettings, error: settingsErr } = await supabase
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .limit(1)
    .maybeSingle()

  if (settingsErr) {
    throw new Error(`Failed to read app_settings: ${settingsErr.message}`)
  }

  const rawChatId = (rawSettings as AppSettingsChatIdRow | null)?.telegram_admin_chat_id
  if (!rawChatId) {
    throw new Error('app_settings.telegram_admin_chat_id is not configured')
  }

  const resolvedChatId = resolveChatId(rawChatId)
  if (resolvedChatId.status === 'invalid') {
    throw new Error(`Invalid app_settings.telegram_admin_chat_id: ${resolvedChatId.reason}`)
  }

  const token = await getToken()
  const text = formatAttendanceSummary(instances)
  const sendResult = await sendMessage({ token, chatId: resolvedChatId.value, text })

  if (!sendResult.ok) {
    const reason = sendResult.reason === 'http_error' ? sendResult.description : sendResult.message
    await resolveCronClaim({
      supabase,
      claimId,
      status: 'degraded',
      now,
      notes: `attendance-summary send failed: ${reason}`,
      payload: { source: ATTENDANCE_SUMMARY_SOURCE, ict_date: ictDate, count },
    })
    return { status: 'send_failed', ict_date: ictDate, count, reason, flipped_count: flippedCount }
  }

  await resolveCronClaim({
    supabase,
    claimId,
    status: 'ok',
    now,
    payload: {
      source: ATTENDANCE_SUMMARY_SOURCE,
      ict_date: ictDate,
      count,
      message_id: sendResult.messageId,
    },
  })

  return { status: 'sent', ict_date: ictDate, count, message_id: sendResult.messageId, flipped_count: flippedCount }
}
