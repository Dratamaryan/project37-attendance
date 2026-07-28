export type SendTelegramMessageResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: 'http_error'; status: number; description: string }
  | { ok: false; reason: 'network_error'; message: string }

interface TelegramSuccessBody {
  ok: true
  result: { message_id: number }
}

interface TelegramErrorBody {
  ok: false
  description: string
}

function isTelegramSuccessBody(body: unknown): body is TelegramSuccessBody {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (b.ok !== true) return false
  if (typeof b.result !== 'object' || b.result === null) return false
  return typeof (b.result as Record<string, unknown>).message_id === 'number'
}

function isTelegramErrorBody(body: unknown): body is TelegramErrorBody {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return b.ok === false && typeof b.description === 'string'
}

/**
 * The only place that calls the Telegram Bot API. `token` is a parameter
 * (never read from env internally) so this module stays free of `server-only`
 * and testable under Vitest with a stubbed `fetch` — the guard lives in
 * lib/telegram/token.ts instead. Never throws: network and API failures both
 * resolve to a typed error variant so callers (an admin route today, a cron
 * later) can choose loud-to-admin vs quiet-log-and-skip.
 */
export async function sendTelegramMessage(params: {
  token: string
  chatId: string
  text: string
}): Promise<SendTelegramMessageResult> {
  const { token, chatId, text } = params

  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : 'Failed to parse Telegram response',
    }
  }

  if (isTelegramSuccessBody(body)) {
    return { ok: true, messageId: body.result.message_id }
  }

  const description = isTelegramErrorBody(body) ? body.description : `HTTP ${response.status}`
  return { ok: false, reason: 'http_error', status: response.status, description }
}
