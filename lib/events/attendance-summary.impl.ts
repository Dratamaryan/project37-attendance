import type { SupabaseClient } from '@supabase/supabase-js'

import {
  computeIctDayBounds,
  groupAttendanceByInstance,
  formatAttendanceSummary,
  type AttendanceRow,
} from '@/lib/events/attendance-summary'
import { sendTelegramMessage, type SendTelegramMessageResult } from '@/lib/telegram/client'
import { resolveChatId } from '@/lib/telegram/chat-id'

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
  | { status: 'skipped_already_sent'; ict_date: string }
  | { status: 'empty'; ict_date: string }
  | { status: 'sent'; ict_date: string; count: number; message_id: number }
  | { status: 'send_failed'; ict_date: string; count: number; reason: string }

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
type SystemHealthPayload = { source?: string; ict_date?: string }
type SystemHealthCheckRow = { table_row_counts: SystemHealthPayload | null }

/**
 * Attendance summary cron body — DB reads/writes + Telegram send, called with
 * `now` captured once by the route handler (never a second `new Date()` here,
 * per D/3). Reports the ICT day that is ENDING at the 23:30 fire time (D/2),
 * grouped by event instance (cancelled instances are annotated, not hidden —
 * see attendance-summary.ts's instanceLabel).
 *
 * Idempotency note: identical shape and identical accepted gap to
 * birthday-digest.impl.ts's runBirthdayDigest — the read-then-write check
 * closes the sequential re-fire case but NOT a concurrent double-invoke (two
 * overlapping invocations can both read "nothing sent yet" before either
 * writes, producing two Telegram sends). Accepted for Sprint 4 for the same
 * reason: worst case is a duplicate message, not corruption. Real fix is a DB
 * partial unique index on system_health(source, ict_date), deferred to land
 * with the Sprint 5 `table_row_counts` → `payload` rename (D/7), which now
 * explicitly covers both crons.
 */
export async function runAttendanceSummary(input: AttendanceSummaryInput): Promise<AttendanceSummaryResult> {
  const {
    supabase,
    now,
    sendMessage = sendTelegramMessage,
    getToken = defaultGetToken,
  } = input

  const { ictDate, startUtc, endUtc } = computeIctDayBounds(now)

  const { data: recentHealth, error: healthReadErr } = await supabase
    .from('system_health')
    .select('table_row_counts')
    .eq('status', 'ok')
    .gte('checked_at', startUtc.toISOString())
    .lt('checked_at', endUtc.toISOString())

  if (healthReadErr) {
    throw new Error(`Failed to read system_health: ${healthReadErr.message}`)
  }

  const alreadySent = ((recentHealth ?? []) as SystemHealthCheckRow[]).some(
    (row) =>
      row.table_row_counts?.source === ATTENDANCE_SUMMARY_SOURCE &&
      row.table_row_counts?.ict_date === ictDate,
  )
  if (alreadySent) {
    return { status: 'skipped_already_sent', ict_date: ictDate }
  }

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
    // Non-fatal: the empty-day outcome is already decided even if this write
    // fails — same reasoning as birthday-digest's empty-day write.
    const { error: writeErr } = await supabase.from('system_health').insert({
      checked_at: now.toISOString(),
      table_row_counts: { source: ATTENDANCE_SUMMARY_SOURCE, ict_date: ictDate, count: 0 },
      status: 'ok',
    })
    if (writeErr) {
      console.warn('[attendance-summary] system_health write failed:', writeErr.message)
    }
    return { status: 'empty', ict_date: ictDate }
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
    const { error: writeErr } = await supabase.from('system_health').insert({
      checked_at: now.toISOString(),
      table_row_counts: { source: ATTENDANCE_SUMMARY_SOURCE, ict_date: ictDate, count },
      status: 'degraded',
      notes: `attendance-summary send failed: ${reason}`,
    })
    if (writeErr) {
      console.warn('[attendance-summary] system_health write failed:', writeErr.message)
    }
    return { status: 'send_failed', ict_date: ictDate, count, reason }
  }

  // Non-fatal: the send already succeeded — a write failure here means the
  // next invocation's idempotency check won't see it and may re-send, not
  // that this run failed.
  const { error: writeErr } = await supabase.from('system_health').insert({
    checked_at: now.toISOString(),
    table_row_counts: {
      source: ATTENDANCE_SUMMARY_SOURCE,
      ict_date: ictDate,
      count,
      message_id: sendResult.messageId,
    },
    status: 'ok',
  })
  if (writeErr) {
    console.warn('[attendance-summary] system_health write failed:', writeErr.message)
  }

  return { status: 'sent', ict_date: ictDate, count, message_id: sendResult.messageId }
}
