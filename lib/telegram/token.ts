import 'server-only'

/**
 * Sole reader of `TELEGRAM_BOT_TOKEN`. Env var by decision (Sprint 4 C/1) —
 * never a DB column. Throws loud on absence; callers in server contexts
 * (route handlers, crons) decide how to surface that.
 */
export function getTelegramBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN

  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not set. Configure it in Vercel project env vars ' +
        '(see .env.local.example) — it is never read from app_settings.'
    )
  }

  return token
}
