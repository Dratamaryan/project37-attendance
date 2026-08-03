// No 'use server' — imported by digest-triggers.ts (server actions) and by
// tests. Never import this file in Client Components.
//
// Privilege gate ordering, same as admin-users.impl.ts / parishes.impl.ts:
// requireActiveAdmin(supabase) is the FIRST action in each exported function,
// using the caller's own JWT-backed client. adminSupabase (service role) is
// only ever passed to the T5 cron impl AFTER that gate returns 'ok'.
//
// "Run now" calls the SAME hardened runBirthdayDigest / runAttendanceSummary
// impls the Vercel cron routes call (Sprint 5 T5) — not a force-send, not a
// separate code path. Both share the (source, ict_date) claim slot with the
// scheduled cron, so a manual trigger after today's digest already went out
// (by cron or a prior click) hits skipped_already_sent / skipped_concurrent,
// never re-sends. See docs/sprint-5-task-5-verify.md for the claim state
// machine this relies on — not re-proven here, only surfaced.
//
// now/sendMessage/getToken are optional passthroughs to the underlying impl,
// solely so tests can inject a fixed clock and a stubbed Telegram send
// without hitting the network — the real server action (digest-triggers.ts)
// never sets them, so production always uses the real clock and real send.

import type { SupabaseClient } from '@supabase/supabase-js'
import { requireActiveAdmin } from '@/lib/auth/require-admin'
import { logAudit, AUDIT_ACTIONS } from '../audit'
import { runBirthdayDigest, BIRTHDAY_DIGEST_SOURCE } from '@/lib/events/birthday-digest.impl'
import { runAttendanceSummary, ATTENDANCE_SUMMARY_SOURCE } from '@/lib/events/attendance-summary.impl'
import type { SendTelegramMessageResult } from '@/lib/telegram/client'
import type { RunBirthdayDigestNowResult, RunAttendanceSummaryNowResult } from './digest-triggers.types'

type TestInjectable = {
  now?: Date
  sendMessage?: (params: { token: string; chatId: string; text: string }) => Promise<SendTelegramMessageResult>
  getToken?: () => string | Promise<string>
}

// ── runBirthdayDigestNow ─────────────────────────────────────────────────────

export async function impl_runBirthdayDigestNow({
  supabase,
  adminSupabase,
  now = new Date(),
  sendMessage,
  getToken,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
} & TestInjectable): Promise<RunBirthdayDigestNowResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const result = await runBirthdayDigest({ supabase: adminSupabase, now, sendMessage, getToken })

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.BIRTHDAY_DIGEST_MANUAL_TRIGGER,
      entityType: 'system_health',
      entityId: `${BIRTHDAY_DIGEST_SOURCE}:${result.ict_date}`,
      detailsJson: { ...result },
    },
    supabase,
  )

  return result
}

// ── runAttendanceSummaryNow ──────────────────────────────────────────────────

export async function impl_runAttendanceSummaryNow({
  supabase,
  adminSupabase,
  now = new Date(),
  sendMessage,
  getToken,
}: {
  supabase: SupabaseClient
  adminSupabase: SupabaseClient
} & TestInjectable): Promise<RunAttendanceSummaryNowResult> {
  const guard = await requireActiveAdmin(supabase)
  if (guard.status !== 'ok') return { status: 'not_authorized' }
  const actorId = guard.actorId

  const result = await runAttendanceSummary({ supabase: adminSupabase, now, sendMessage, getToken })

  await logAudit(
    {
      actorUserId: actorId,
      action: AUDIT_ACTIONS.ATTENDANCE_SUMMARY_MANUAL_TRIGGER,
      entityType: 'system_health',
      entityId: `${ATTENDANCE_SUMMARY_SOURCE}:${result.ict_date}`,
      detailsJson: { ...result },
    },
    supabase,
  )

  return result
}
