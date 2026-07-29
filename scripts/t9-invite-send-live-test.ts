/**
 * Sprint 4 T9 — live verification: a real send through the real invite engine
 * (impl_sendInvites, the actual built code — not a bypass) to Ryan's
 * controlled inboxes (E/2/E/5 — never a congregant).
 *
 * Seeds a DEDICATED test event + event_instance + two test `people` rows
 * (clearly marked, not real congregants) on prod, gets a real admin session
 * via the established magic-link pattern (scripts/t4-telegram-live-test.mjs),
 * and calls impl_sendInvites with the real Nodemailer transport. Per E/5 and
 * the schema addendum, this residue is NOT covered by the S6-T0 demo wipe
 * predicate — left in place intentionally, IDs printed for the verify report
 * and S6-T0.1 tracking, not cleaned up here.
 *
 * lib/email/config.ts imports `server-only`, which throws outside a real
 * Next.js server build (same precedent as scripts/t8-email-live-test.ts) — so
 * this reads NOTIFY_SMTP_ / NOTIFY_FROM_NAME / NOTIFY_REPLY_TO env vars
 * directly instead of calling getDefaultEmailTransport() / getNotifySmtpConfig().
 *
 * Run: npx tsx --env-file .env.local scripts/t9-invite-send-live-test.ts <email1> [email2 ...]
 */

import { createClient } from '@supabase/supabase-js'
import { createNodemailerTransport } from '../lib/email/transport'
import { impl_sendInvites } from '../lib/actions/invites.impl'

const recipientEmails = process.argv.slice(2)
if (recipientEmails.length === 0) {
  console.error('Usage: npx tsx --env-file .env.local scripts/t9-invite-send-live-test.ts <email1> [email2 ...]')
  console.error('  Each address must be one of Ryan\'s controlled inboxes (E/2/E/5) — never a congregant.')
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const ADMIN_EMAIL = 'admin-example@example.test' // matches scripts/t4-telegram-live-test.mjs — the real prod admin

const NOTIFY_HOST = process.env.NOTIFY_SMTP_HOST || 'smtp.gmail.com'
const NOTIFY_PORT = Number(process.env.NOTIFY_SMTP_PORT) || 587
const NOTIFY_USER = process.env.NOTIFY_SMTP_USER
const NOTIFY_PASS = process.env.NOTIFY_SMTP_PASS
const NOTIFY_FROM_NAME = process.env.NOTIFY_FROM_NAME || 'Project 37'
const NOTIFY_REPLY_TO = process.env.NOTIFY_REPLY_TO

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}
if (!NOTIFY_USER || !NOTIFY_PASS || !NOTIFY_REPLY_TO) {
  console.error('Missing NOTIFY_SMTP_USER / NOTIFY_SMTP_PASS / NOTIFY_REPLY_TO in .env.local')
  process.exit(1)
}

const serviceAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function getAdminSession() {
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
  if (!verifyData.session) throw new Error('verifyOtp succeeded but returned no session')
  return verifyData.session
}

async function main() {
  console.log('\n=== Sprint 4 T9 — live invite send test ===\n')

  const ts = Date.now()
  const tribe = `T9-LIVE-TEST-${ts}`

  // Real admin app_user id, needed for events.created_by.
  const { data: adminAppUser, error: adminLookupErr } = await serviceAdmin
    .from('app_users')
    .select('id')
    .eq('email', ADMIN_EMAIL)
    .single()
  if (adminLookupErr || !adminAppUser) throw new Error(`admin app_user lookup: ${adminLookupErr?.message}`)

  const { data: event, error: eventErr } = await serviceAdmin
    .from('events')
    .insert({
      name: 'T9 Live Test Event [DO NOT USE]',
      event_type: 'adhoc',
      start_date: '2026-08-14',
      start_time: '18:00:00',
      duration_min: 120,
      location: 'Hotel Neo Puri Indah',
      active: true,
      created_by: adminAppUser.id,
    })
    .select('id')
    .single()
  if (eventErr || !event) throw new Error(`insert event: ${eventErr?.message}`)

  const { data: instance, error: instanceErr } = await serviceAdmin
    .from('event_instances')
    .insert({
      event_id: event.id,
      scheduled_at: '2026-08-14T11:00:00.000Z', // 18:00 Jakarta
      event_name_snapshot: 'T9 Live Test Event [DO NOT USE]',
      event_name_snapshot_id: 'Acara Uji T9 [JANGAN DIGUNAKAN]',
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instanceErr || !instance) throw new Error(`insert instance: ${instanceErr?.message}`)

  const personIds: string[] = []
  for (const [i, email] of recipientEmails.entries()) {
    const { data: person, error: personErr } = await serviceAdmin
      .from('people')
      .insert({
        phone_e164: `+62999${ts.toString().slice(-6)}${i}`, // +62999 prefix: matches S6-T0 demo predicate, not a real number
        full_name: `T9 Live Test Recipient ${i}`,
        nickname: `t9live${i}`,
        tribe,
        email,
      })
      .select('id')
      .single()
    if (personErr || !person) throw new Error(`insert person ${email}: ${personErr?.message}`)
    personIds.push(person.id as string)
  }

  const session = await getAdminSession()
  const supabase = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: setSessionErr } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
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

  const result = await impl_sendInvites({
    supabase,
    transport,
    eventInstanceId: instance.id as string,
    filter: { tribe },
    emailIdentity: { organizerEmail: NOTIFY_USER!, fromName: NOTIFY_FROM_NAME, replyTo: NOTIFY_REPLY_TO! },
  })

  console.log('sendInvites result:', JSON.stringify(result, null, 2))
  console.log('\n--- Record for verify report / S6-T0.1 ---')
  console.log('event_id:        ', event.id)
  console.log('event_instance_id:', instance.id)
  console.log('person_ids:       ', personIds.join(', '))
  console.log('tribe filter used:', tribe)

  if (result.status !== 'ok' || result.sent !== recipientEmails.length) {
    console.log('\n✗ FAIL — not all recipients sent successfully')
    process.exitCode = 1
    return
  }

  console.log(`\n✓ sendInvites reported ${result.sent}/${recipientEmails.length} sent.`)
  console.log(`Check each inbox now: ${recipientEmails.join(', ')}`)
  console.log('Confirm: email arrived, renders correctly, invite.ics present and opens as an add-to-calendar invitation with correct date/time/location.')
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
