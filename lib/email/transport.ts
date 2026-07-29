import nodemailer from 'nodemailer'

import type { NotifySmtpConfig } from './config'

export interface EmailAttachment {
  filename: string
  content: string | Buffer
  contentType?: string
}

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
  fromName: string
  replyTo: string
  attachments?: EmailAttachment[]
}

export type SendEmailResult =
  | { ok: true; messageId: string; response: string }
  | { ok: false; reason: 'smtp_error'; message: string }

export interface EmailTransport {
  send(msg: EmailMessage): Promise<SendEmailResult>
}

interface RawSendResult {
  messageId: string
  response: string
}

interface RawSendOptions {
  from: string
  to: string
  replyTo: string
  subject: string
  html: string
  text: string
  attachments?: EmailAttachment[]
}

/**
 * Own narrow function type for the send seam — deliberately NOT reusing any
 * `nodemailer` type (SendMailOptions / SentMessageInfo). This keeps the "no
 * `nodemailer` import anywhere else" lock (A/3) airtight: Vitest never
 * imports `nodemailer`, not even for types, when it injects a stub here.
 */
export type RawSender = (opts: RawSendOptions) => Promise<RawSendResult>

function defaultRawSender(config: NotifySmtpConfig): RawSender {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  })

  return async (opts) => {
    const info = await transporter.sendMail(opts)
    return { messageId: info.messageId, response: info.response }
  }
}

/**
 * The only place `nodemailer` is imported (A/3). `config` is a parameter
 * (never read from env internally), and `sendRaw` is injectable, so this
 * module stays free of `server-only` and fully Vitest-testable with a
 * stubbed sender — same pattern as `lib/telegram/client.ts`. Never throws:
 * SMTP failures resolve to a typed error variant, same shape as
 * `SendTelegramMessageResult`.
 */
export function createNodemailerTransport(
  config: NotifySmtpConfig,
  sendRaw: RawSender = defaultRawSender(config)
): EmailTransport {
  return {
    async send(msg: EmailMessage): Promise<SendEmailResult> {
      try {
        const result = await sendRaw({
          from: `"${msg.fromName}" <${config.user}>`,
          to: msg.to,
          replyTo: msg.replyTo,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          attachments: msg.attachments,
        })
        return { ok: true, messageId: result.messageId, response: result.response }
      } catch (err) {
        return {
          ok: false,
          reason: 'smtp_error',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }
}

// lib/email/config.ts imports the `server-only` package, which throws on
// import outside a real server context — including under Vitest's Node
// resolution and under `tsx` (same issue T4/T5 hit; confirmed in the T8 plan
// that this applies beyond Vitest). A static top-level import here would
// throw the moment this module loads. Deferred to a dynamic import so it's
// only evaluated when the real default path actually runs (a future cron/
// route calling this in a real Next.js server-component context, where the
// `react-server` condition makes `server-only` a no-op).
export async function getDefaultEmailTransport(): Promise<EmailTransport> {
  const { getNotifySmtpConfig } = await import('./config')
  return createNodemailerTransport(getNotifySmtpConfig())
}
