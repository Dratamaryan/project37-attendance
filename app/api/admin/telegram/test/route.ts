import { NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { resolveChatId } from '@/lib/telegram/chat-id'
import { sendTelegramMessage } from '@/lib/telegram/client'
import { getTelegramBotToken } from '@/lib/telegram/token'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type AppSettingsChatIdRow = { telegram_admin_chat_id: string | null }

/**
 * POST /api/admin/telegram/test
 *
 * Admin-only. Sends one real Telegram message to the chat ID stored in
 * app_settings, so delivery can be proven live and re-proven any time.
 * Failures (bad chat ID, send failure, missing token) are returned to the
 * admin's screen as a clear discriminated result — never a silent failure.
 */
export async function POST() {
  const supabase = await createClient()

  const { data: claimsResult } = await supabase.auth.getClaims()
  if (!claimsResult) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: appUser } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', claimsResult.claims.sub)
    .single()

  if (appUser?.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data: rawSettings, error: settingsError } = await supabase
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .limit(1)
    .maybeSingle()

  if (settingsError) {
    return NextResponse.json(
      { error: `Failed to read app_settings: ${settingsError.message}` },
      { status: 500 },
    )
  }

  const settings = rawSettings as AppSettingsChatIdRow | null
  const rawChatId = settings?.telegram_admin_chat_id

  if (!rawChatId) {
    return NextResponse.json({ ok: false, reason: 'not_configured' }, { status: 400 })
  }

  const resolved = resolveChatId(rawChatId)
  if (resolved.status === 'invalid') {
    return NextResponse.json(
      { ok: false, reason: 'invalid_chat_id', detail: resolved },
      { status: 400 },
    )
  }

  let token: string
  try {
    token = getTelegramBotToken()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TELEGRAM_BOT_TOKEN is not configured' },
      { status: 500 },
    )
  }

  const sendResult = await sendTelegramMessage({
    token,
    chatId: resolved.value,
    text: `✅ Project 37 test message — ${new Date().toISOString()}`,
  })

  if (!sendResult.ok) {
    return NextResponse.json(sendResult, { status: 400 })
  }

  return NextResponse.json({ ok: true, messageId: sendResult.messageId })
}
