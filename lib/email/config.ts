import 'server-only'

export interface NotifySmtpConfig {
  host: string
  port: number
  user: string
  pass: string
  fromName: string
  replyTo: string
}

/**
 * Sole reader of `NOTIFY_SMTP_*` / `NOTIFY_FROM_NAME` / `NOTIFY_REPLY_TO`.
 * Same account as Supabase Auth SMTP by design (A/1) — a second, separately
 * named App Password, not a different account. Throws loud on missing
 * required vars; callers in server contexts (route handlers, crons) decide
 * how to surface that.
 */
export function getNotifySmtpConfig(): NotifySmtpConfig {
  const host = process.env.NOTIFY_SMTP_HOST || 'smtp.gmail.com'
  const port = Number(process.env.NOTIFY_SMTP_PORT) || 587
  const user = process.env.NOTIFY_SMTP_USER
  const pass = process.env.NOTIFY_SMTP_PASS
  const fromName = process.env.NOTIFY_FROM_NAME || 'Project 37'
  const replyTo = process.env.NOTIFY_REPLY_TO

  if (!user || !pass || !replyTo) {
    throw new Error(
      'Missing NOTIFY_SMTP_USER / NOTIFY_SMTP_PASS / NOTIFY_REPLY_TO env vars. ' +
        'Configure them in Vercel project env vars (see .env.local.example) — ' +
        'these are never read from app_settings.'
    )
  }

  return { host, port, user, pass, fromName, replyTo }
}
