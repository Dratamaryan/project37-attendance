/**
 * Sprint 4 T9 — live verification: resendInvite through the real invite
 * engine, to close the T4-08 Outlook/Exchange renderer gap AND spot-check
 * T4-10 (resend updates the calendar entry rather than duplicating) live.
 *
 * Reuses the dedicated test event_instance + person from
 * t9-invite-send-live-test.ts's most recent run.
 *
 * Run: npx tsx --env-file .env.local scripts/t9-invite-resend-live-test.ts <eventInstanceId> <personId>
 */

import { createClient } from '@supabase/supabase-js'
import { createNodemailerTransport } from '../lib/email/transport'
import { impl_resendInvite } from '../lib/actions/invites.impl'

const [eventInstanceId, personId] = process.argv.slice(2)
if (!eventInstanceId || !personId) {
  console.error('Usage: npx tsx --env-file .env.local scripts/t9-invite-resend-live-test.ts <eventInstanceId> <personId>')
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const ADMIN_EMAIL = 'admin-example@example.test'

const NOTIFY_HOST = process.env.NOTIFY_SMTP_HOST || 'smtp.gmail.com'
const NOTIFY_PORT = Number(process.env.NOTIFY_SMTP_PORT) || 587
const NOTIFY_USER = process.env.NOTIFY_SMTP_USER
const NOTIFY_PASS = process.env.NOTIFY_SMTP_PASS
const NOTIFY_FROM_NAME = process.env.NOTIFY_FROM_NAME || 'Project 37'
const NOTIFY_REPLY_TO = process.env.NOTIFY_REPLY_TO

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !NOTIFY_USER || !NOTIFY_PASS || !NOTIFY_REPLY_TO) {
  console.error('Missing required env vars')
  process.exit(1)
}

const serviceAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const { data: linkData, error: linkErr } = await serviceAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  })
  if (linkErr) throw linkErr

  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr

  const supabase = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: setSessionErr } = await supabase.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  })
  if (setSessionErr) throw setSessionErr

  const transport = createNodemailerTransport({
    host: NOTIFY_HOST,
    port: NOTIFY_PORT,
    user: NOTIFY_USER!,
    pass: NOTIFY_PASS!,
    fromName: NOTIFY_FROM_NAME,
    replyTo: NOTIFY_REPLY_TO!,
  })

  const result = await impl_resendInvite({
    supabase,
    transport,
    eventInstanceId,
    personId,
    emailIdentity: { organizerEmail: NOTIFY_USER!, fromName: NOTIFY_FROM_NAME, replyTo: NOTIFY_REPLY_TO! },
  })

  console.log('resendInvite result:', JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
