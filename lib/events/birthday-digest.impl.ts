import type { SupabaseClient } from '@supabase/supabase-js'
import { addHours } from 'date-fns'

import { formatJakarta, toJakartaInstant } from '@/lib/events/timezone'
import { selectBirthdaysToday, formatBirthdayDigest, type PersonRow } from '@/lib/events/birthday-digest'
import { sendTelegramMessage, type SendTelegramMessageResult } from '@/lib/telegram/client'
import { resolveChatId } from '@/lib/telegram/chat-id'

// lib/telegram/token.ts imports the `server-only` package, which throws on import
// outside a real server context — including under Vitest's Node resolution (same
// issue T4 hit; token.ts has no direct test file for this reason). A static
// top-level import here would throw the moment this module loads, even in tests
// that always override `getToken`. Deferred to a dynamic import so it's only
// evaluated when the real default path actually runs (the cron route, a real
// server context).
async function defaultGetToken(): Promise<string> {
  const { getTelegramBotToken } = await import('@/lib/telegram/token')
  return getTelegramBotToken()
}

export const BIRTHDAY_DIGEST_SOURCE = 'birthday-digest'

export type BirthdayDigestResult =
  | { status: 'skipped_already_sent'; ict_date: string }
  | { status: 'empty'; ict_date: string }
  | { status: 'sent'; ict_date: string; count: number; message_id: number }
  | { status: 'send_failed'; ict_date: string; count: number; reason: string }

export type BirthdayDigestInput = {
  /** MUST be the admin (service-role) client — bypasses RLS */
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
 * Birthday digest cron body — DB reads/writes + Telegram send, called with `now`
 * captured once by the route handler (never a second `new Date()` here, per D/3).
 *
 * Idempotency note: the read-then-write check below closes the sequential
 * re-fire case (a later invocation sees the prior `ok` row and skips) but NOT
 * a concurrent double-invoke — two overlapping invocations can both read
 * "nothing sent yet" before either writes, producing two Telegram sends.
 * Accepted for Sprint 4: worst case is a duplicate (ugly, not harmful — no
 * wrong-person greeting, no data corruption), and the real fix is a DB-level
 * partial unique index on system_health(source, ict_date), which wants
 * typed columns and belongs with the D/7 `table_row_counts` → `payload`
 * rename already deferred to Sprint 5. See docs/sprint-4-task-5-verify.md.
 */
export async function runBirthdayDigest(input: BirthdayDigestInput): Promise<BirthdayDigestResult> {
  const {
    supabase,
    now,
    sendMessage = sendTelegramMessage,
    getToken = defaultGetToken,
  } = input

  const todayICT = formatJakarta(now, 'yyyy-MM-dd')
  const dayStartUtc = toJakartaInstant(todayICT, '00:00')
  const dayEndUtc = addHours(dayStartUtc, 24)

  const { data: recentHealth, error: healthReadErr } = await supabase
    .from('system_health')
    .select('table_row_counts')
    .eq('status', 'ok')
    .gte('checked_at', dayStartUtc.toISOString())
    .lt('checked_at', dayEndUtc.toISOString())

  if (healthReadErr) {
    throw new Error(`Failed to read system_health: ${healthReadErr.message}`)
  }

  const alreadySent = ((recentHealth ?? []) as SystemHealthCheckRow[]).some(
    (row) =>
      row.table_row_counts?.source === BIRTHDAY_DIGEST_SOURCE &&
      row.table_row_counts?.ict_date === todayICT,
  )
  if (alreadySent) {
    return { status: 'skipped_already_sent', ict_date: todayICT }
  }

  const { data: rawPeople, error: peopleErr } = await supabase
    .from('people')
    .select('id, full_name, birth_date, photo_publish_consent, deleted_at')
    .not('birth_date', 'is', null)
    .is('deleted_at', null)

  if (peopleErr) {
    throw new Error(`Failed to read people: ${peopleErr.message}`)
  }

  const birthdayPeople = selectBirthdaysToday((rawPeople ?? []) as PersonRow[], todayICT)

  if (birthdayPeople.length === 0) {
    // Non-fatal: the empty-day outcome is already decided even if this write fails —
    // same reasoning as materializeEvents' observability write (materialize.impl.ts).
    const { error: writeErr } = await supabase.from('system_health').insert({
      checked_at: now.toISOString(),
      table_row_counts: { source: BIRTHDAY_DIGEST_SOURCE, ict_date: todayICT, count: 0 },
      status: 'ok',
    })
    if (writeErr) {
      console.warn('[birthday-digest] system_health write failed:', writeErr.message)
    }
    return { status: 'empty', ict_date: todayICT }
  }

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
  const text = formatBirthdayDigest(birthdayPeople)
  const sendResult = await sendMessage({ token, chatId: resolvedChatId.value, text })

  if (!sendResult.ok) {
    const reason = sendResult.reason === 'http_error' ? sendResult.description : sendResult.message
    const { error: writeErr } = await supabase.from('system_health').insert({
      checked_at: now.toISOString(),
      table_row_counts: {
        source: BIRTHDAY_DIGEST_SOURCE,
        ict_date: todayICT,
        count: birthdayPeople.length,
      },
      status: 'degraded',
      notes: `birthday-digest send failed: ${reason}`,
    })
    if (writeErr) {
      console.warn('[birthday-digest] system_health write failed:', writeErr.message)
    }
    return { status: 'send_failed', ict_date: todayICT, count: birthdayPeople.length, reason }
  }

  // Non-fatal: the send already succeeded — a write failure here means the next
  // invocation's idempotency check won't see it and may re-send, not that this run failed.
  const { error: writeErr } = await supabase.from('system_health').insert({
    checked_at: now.toISOString(),
    table_row_counts: {
      source: BIRTHDAY_DIGEST_SOURCE,
      ict_date: todayICT,
      count: birthdayPeople.length,
      message_id: sendResult.messageId,
    },
    status: 'ok',
  })
  if (writeErr) {
    console.warn('[birthday-digest] system_health write failed:', writeErr.message)
  }

  return {
    status: 'sent',
    ict_date: todayICT,
    count: birthdayPeople.length,
    message_id: sendResult.messageId,
  }
}
