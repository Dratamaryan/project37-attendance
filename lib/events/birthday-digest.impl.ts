import type { SupabaseClient } from '@supabase/supabase-js'

import { formatJakarta } from '@/lib/events/timezone'
import { cohortDateFor, selectBirthdaysOn, formatBirthdayDigest, type PersonRow } from '@/lib/events/birthday-digest'
import { sendTelegramMessage, type SendTelegramMessageResult } from '@/lib/telegram/client'
import { resolveChatId } from '@/lib/telegram/chat-id'
import { claimCronSlot, resolveCronClaim } from '@/lib/cron/idempotent-claim'

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

// S8-T6 (H-1): send_date is the WIB day the run fires; cohort_date is the WIB day being
// greeted (tomorrow) and is the claim key, so a same-day "Run now" shares the cron's slot.
export type BirthdayDigestResult =
  | { status: 'skipped_already_sent'; send_date: string; cohort_date: string }
  | { status: 'skipped_concurrent'; send_date: string; cohort_date: string }
  | { status: 'empty'; send_date: string; cohort_date: string }
  | { status: 'sent'; send_date: string; cohort_date: string; count: number; message_id: number }
  | { status: 'send_failed'; send_date: string; cohort_date: string; count: number; reason: string }

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

/**
 * Birthday digest cron body — DB reads/writes + Telegram send, called with `now`
 * captured once by the route handler (never a second `new Date()` here, per D/3).
 *
 * Idempotency: claim-first against system_health(source, ict_date = cohort_date) via
 * lib/cron/idempotent-claim.ts (Sprint 5 T5) — see that file for the full
 * outcome-state-machine rationale (concurrent double-invoke, already-sent skip,
 * degraded/stale-pending reattempt) and the one accepted residual (a crash between
 * a successful send and the resolveCronClaim write can still cause a duplicate on a
 * later retry — see docs/sprint-5-task-5-verify.md).
 */
export async function runBirthdayDigest(input: BirthdayDigestInput): Promise<BirthdayDigestResult> {
  const {
    supabase,
    now,
    sendMessage = sendTelegramMessage,
    getToken = defaultGetToken,
  } = input

  const sendDate = formatJakarta(now, 'yyyy-MM-dd')
  const cohortDate = cohortDateFor(now)
  const dates = { send_date: sendDate, cohort_date: cohortDate }
  const payloadBase = { source: BIRTHDAY_DIGEST_SOURCE, ict_date: cohortDate, ...dates }

  const claim = await claimCronSlot({ supabase, source: BIRTHDAY_DIGEST_SOURCE, ictDate: cohortDate, now })
  if (claim.outcome === 'already_done') {
    return { status: 'skipped_already_sent', ...dates }
  }
  if (claim.outcome === 'concurrent') {
    return { status: 'skipped_concurrent', ...dates }
  }
  const { claimId } = claim

  const { data: rawPeople, error: peopleErr } = await supabase
    .from('people')
    .select('id, full_name, birth_date, photo_publish_consent, photo_consent_state, deleted_at')
    .not('birth_date', 'is', null)
    .is('deleted_at', null)

  if (peopleErr) {
    throw new Error(`Failed to read people: ${peopleErr.message}`)
  }

  const birthdayPeople = selectBirthdaysOn((rawPeople ?? []) as PersonRow[], cohortDate)

  if (birthdayPeople.length === 0) {
    await resolveCronClaim({
      supabase,
      claimId,
      status: 'ok',
      now,
      payload: { ...payloadBase, count: 0 },
    })
    return { status: 'empty', ...dates }
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
  const text = formatBirthdayDigest(birthdayPeople, cohortDate)
  const sendResult = await sendMessage({ token, chatId: resolvedChatId.value, text })

  if (!sendResult.ok) {
    const reason = sendResult.reason === 'http_error' ? sendResult.description : sendResult.message
    await resolveCronClaim({
      supabase,
      claimId,
      status: 'degraded',
      now,
      notes: `birthday-digest send failed: ${reason}`,
      payload: { ...payloadBase, count: birthdayPeople.length },
    })
    return { status: 'send_failed', ...dates, count: birthdayPeople.length, reason }
  }

  await resolveCronClaim({
    supabase,
    claimId,
    status: 'ok',
    now,
    payload: { ...payloadBase, count: birthdayPeople.length, message_id: sendResult.messageId },
  })

  return { status: 'sent', ...dates, count: birthdayPeople.length, message_id: sendResult.messageId }
}
