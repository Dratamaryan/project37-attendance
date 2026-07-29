/**
 * Sprint 4 T8 — live verification: a real email through the real notify SMTP
 * to Ryan's controlled inbox (E/2/E/5 — never a congregant).
 *
 * Confirms arrival + bilingual render (Indonesian first, English below) +
 * opt-out line visible in both + sample .ics attached — not just a 250
 * (E/1: a stubbed transport may never support a delivery claim).
 *
 * lib/email/config.ts imports `server-only`, which throws outside a real
 * Next.js server-component build (confirmed in the T8 plan: this includes
 * `tsx`, not just Vitest). So this script reads the five NOTIFY_SMTP_* /
 * NOTIFY_FROM_NAME / NOTIFY_REPLY_TO env vars directly instead of calling
 * getDefaultEmailTransport() — same precedent as
 * scripts/t5-birthday-digest-live-test.mjs duplicating todayICT() instead of
 * importing the server-only-guarded original.
 *
 * Run: npx tsx --env-file .env.local scripts/t8-email-live-test.ts <to-address>
 */

import { createNodemailerTransport } from '../lib/email/transport'
import { renderInviteEmail } from '../lib/email/template'
import { generateIcs } from '../lib/events/ics'

const to = process.argv[2]
if (!to) {
  console.error('Usage: npx tsx --env-file .env.local scripts/t8-email-live-test.ts <to-address>')
  console.error('  <to-address> must be one of Ryan\'s controlled inboxes (E/2/E/5) — never a congregant.')
  process.exit(1)
}

const host = process.env.NOTIFY_SMTP_HOST || 'smtp.gmail.com'
const port = Number(process.env.NOTIFY_SMTP_PORT) || 587
const user = process.env.NOTIFY_SMTP_USER
const pass = process.env.NOTIFY_SMTP_PASS
const fromName = process.env.NOTIFY_FROM_NAME || 'Project 37'
const replyTo = process.env.NOTIFY_REPLY_TO

if (!user || !pass || !replyTo) {
  console.error('Missing NOTIFY_SMTP_USER / NOTIFY_SMTP_PASS / NOTIFY_REPLY_TO in .env.local')
  process.exit(1)
}

const SAMPLE_EVENT_INSTANCE_ID = 't8-live-test-sample-0000-000000000000'

const config = { host, port, user, pass, fromName, replyTo }

async function main() {
  const transport = createNodemailerTransport(config)

  const scheduledAt = new Date('2026-08-14T11:00:00.000Z') // 18:00 Jakarta, sample only
  const rendered = renderInviteEmail({
    eventNameEn: 'Project Day',
    eventNameId: 'Hari Proyek',
    scheduledAt,
    durationMin: 120,
    location: 'Hotel Neo Puri Indah',
  })

  const ics = generateIcs({
    eventInstanceId: SAMPLE_EVENT_INSTANCE_ID,
    summary: 'Project Day / Hari Proyek',
    location: 'Hotel Neo Puri Indah',
    scheduledAt,
    durationMin: 120,
    sequence: 0,
  })

  const result = await transport.send({
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: config.fromName,
    replyTo: config.replyTo,
    attachments: [
      {
        filename: 'invite.ics',
        content: ics,
        contentType: 'text/calendar',
      },
    ],
  })

  console.log('Send result:', JSON.stringify(result, null, 2))
  if (!result.ok) {
    process.exit(1)
  }
  console.log(`\nCheck ${to} — confirm: bilingual render (ID first), opt-out visible in both languages, invite.ics attached.`)
}

main()
