import type { SupabaseClient } from '@supabase/supabase-js'

import {
  computeIctDayBounds,
  groupAttendanceByInstance,
  formatAttendanceSummary,
  type AttendanceRow,
} from '@/lib/events/attendance-summary'
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

/**
 * Flips event_instances that have actually occurred (scheduled_at < now, the
 * injected clock — never a parallel "day" computation) from 'scheduled' to
 * 'completed'. Never touches 'cancelled' (excluded structurally by the
 * status='scheduled' predicate, not just by convention). Idempotent — a second
 * call with the same or later `now` only matches rows still 'scheduled'.
 *
 * Deliberately `scheduled_at < now`, NOT the summary's [startUtc, endUtc) day
 * window: the window answers "which day am I reporting", the flip answers
 * "what has actually occurred by the moment I'm running" — these differ on a
 * manual/off-schedule fire (e.g. a mid-day live-verify or a future T8 manual
 * trigger), where `< endUtc` would prematurely complete an event still hours
 * away. `< now` is correct regardless of fire time; anything not yet flipped
 * by an early fire is picked up by that night's natural 23:30 ICT run.
 *
 * Called unconditionally, before the send-idempotency claim, on every
 * invocation — the day's events occurred regardless of whether the digest
 * send succeeds or whether this invocation wins the claim race. Decoupling
 * this from claim-acquisition means it never depends on winning the send race.
 */
export async function flipCompletedInstances(supabase: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await supabase
    .from('event_instances')
    .update({ status: 'completed' })
    .eq('status', 'scheduled')
    .lt('scheduled_at', now.toISOString())
    .select('id')

  if (error) {
    throw new Error(`Failed to flip completed instances: ${error.message}`)
  }

  return (data ?? []).length
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
