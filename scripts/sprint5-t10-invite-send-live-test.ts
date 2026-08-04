/**
 * Sprint 5 T10 — live verification: a real send through the real invite
 * engine (impl_sendInvites, the actual built code — not a bypass) to a
 * Ryan-controlled inbox, proving the instance's own image_url (set via
 * scripts/sprint5-t10-instance-edit-playwright.mjs set) rides along into the
 * rendered invite.
 *
 * Reuses Sprint 4 T9's existing fixture event/instance (already documented as
 * excluded from the demo wipe predicate) — does NOT create a new event.
 * Inserts one throwaway `people` row scoped to a uniquely-tagged tribe so
 * `impl_sendInvites`'s filter matches ONLY this fixture recipient — the real
 * UI's tribe filter is a fixed dropdown of REAL congregant tribe names
 * (app/admin/events/[id]/instances/[instanceId]/invite/_components/filter-options.ts),
 * so driving Send through that dropdown for an isolated test address isn't
 * safe (it would over-match real congregants sharing that tribe). Same
 * reasoning and pattern as scripts/t9-invite-send-live-test.ts.
 *
 * Run: npx tsx --env-file .env.local scripts/sprint5-t10-invite-send-live-test.ts <email>
 */

import { createClient } from '@supabase/supabase-js'
import { createNodemailerTransport } from '../lib/email/transport'
import { impl_sendInvites } from '../lib/actions/invites.impl'

const recipientEmail = process.argv[2]
if (!recipientEmail) {
  console.error('Usage: npx tsx --env-file .env.local scripts/sprint5-t10-invite-send-live-test.ts <email>')
  console.error('  Must be one of Ryan\'s controlled inboxes — never a congregant.')
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const ADMIN_EMAIL = 'admin-example@example.test'

// T9's existing fixture instance — reused so the image_url set via the real
// edit UI in the Playwright step is what the send actually picks up.
const EVENT_INSTANCE_ID = '1724c4a2-0140-4694-9d91-e54ef475150f'

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
  console.log('\n=== Sprint 5 T10 — live invite send test (with instance image_url) ===\n')

  const ts = Date.now()
  const tribe = `S5-T10-LIVE-TEST-${ts}`

  const { data: person, error: personErr } = await serviceAdmin
    .from('people')
    .insert({
      phone_e164: `+62999${ts.toString().slice(-6)}0`, // +62999 prefix: matches S6-T0 demo predicate, not a real number
      full_name: 'S5-T10 Live Test Recipient',
      nickname: 's5t10live',
      tribe,
      email: recipientEmail,
    })
    .select('id')
    .single()
  if (personErr || !person) throw new Error(`insert person ${recipientEmail}: ${personErr?.message}`)

  const { data: instBefore } = await serviceAdmin
    .from('event_instances')
    .select('image_url')
    .eq('id', EVENT_INSTANCE_ID)
    .single()
  console.log('event_instances.image_url at send time:', instBefore?.image_url ?? null)

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
    eventInstanceId: EVENT_INSTANCE_ID,
    filter: { tribe },
    emailIdentity: { organizerEmail: NOTIFY_USER!, fromName: NOTIFY_FROM_NAME, replyTo: NOTIFY_REPLY_TO! },
  })

  console.log('sendInvites result:', JSON.stringify(result, null, 2))
  console.log('\n--- Record for verify report ---')
  console.log('event_instance_id:', EVENT_INSTANCE_ID)
  console.log('person_id:        ', person.id)
  console.log('tribe filter used:', tribe)

  if (result.status !== 'ok' || result.sent !== 1) {
    console.log('\n✗ FAIL — send did not report exactly 1 sent')
    process.exitCode = 1
    return
  }

  console.log(`\n✓ sendInvites reported 1/1 sent.`)
  console.log(`Check the inbox now: ${recipientEmail}`)
  console.log('Confirm: email arrived, image visible; with remote images blocked, still fully legible (text intact, no broken-image gap, alt text shown).')
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
