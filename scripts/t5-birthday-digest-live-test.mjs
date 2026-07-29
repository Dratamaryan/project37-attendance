/**
 * Sprint 4 T5-01 — live verification: GET /api/cron/birthday-digest against
 * prod, confirm a real digest message reaches Ryan's Telegram with the
 * correct names/ages/badges — not just a 200.
 *
 * Seeds two prod fixture people with TODAY's real ICT birthday (one
 * photo_publish_consent=true, one =false, to exercise both badges in one
 * real send), triggers the deployed cron route with CRON_SECRET bearer auth
 * (same pattern as the T2/Sprint2 materialize-events live check), then
 * removes the fixtures. The system_health row the cron writes is left in
 * place — it's a real record of a real cron invocation, not test residue.
 *
 * Run: node scripts/t5-birthday-digest-live-test.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env.local')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
} catch { /* env may already be set */ }

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const CRON_SECRET = process.env.CRON_SECRET
const PROD_URL = 'https://project37-attendance.vercel.app'

const PHONE_PUBLISHABLE = '+628888005001'
const PHONE_PRIVATE = '+628888005002'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !CRON_SECRET) {
  console.error('Missing env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ICT (Asia/Jakarta) has a fixed UTC+7 offset, no DST — matches the invariant
// lib/events/timezone.ts encodes for app code. Duplicated here only because
// this is a standalone fixture-setup script, not a route/impl under test.
function todayICT() {
  const now = new Date()
  const ict = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  const y = ict.getUTCFullYear()
  const m = String(ict.getUTCMonth() + 1).padStart(2, '0')
  const d = String(ict.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

async function main() {
  console.log('\n=== Sprint 4 T5-01 — live birthday digest test ===\n')

  const birthDate = todayICT()
  console.log('Today (ICT):', birthDate)

  // Pre-cleanup so the script is re-runnable
  const { data: existing } = await admin
    .from('people')
    .select('id')
    .in('phone_e164', [PHONE_PUBLISHABLE, PHONE_PRIVATE])
  if (existing?.length) {
    await admin.from('people').delete().in('id', existing.map((p) => p.id))
    console.log(`  Pre-cleanup: removed ${existing.length} existing T5 fixture people`)
  }

  const { data: inserted, error: insertErr } = await admin
    .from('people')
    .insert([
      {
        phone_e164: PHONE_PUBLISHABLE,
        full_name: 'T5 Live Publishable',
        nickname: 'T5Pub',
        birth_date: birthDate,
        photo_publish_consent: true,
      },
      {
        phone_e164: PHONE_PRIVATE,
        full_name: 'T5 Live Private',
        nickname: 'T5Priv',
        birth_date: birthDate,
        photo_publish_consent: false,
      },
    ])
    .select('id, full_name')
  if (insertErr) throw insertErr
  console.log('  Inserted fixtures:', inserted.map((p) => p.full_name).join(', '))

  console.log('\nTriggering GET /api/cron/birthday-digest ...')
  const res = await fetch(`${PROD_URL}/api/cron/birthday-digest`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  })
  const body = await res.json().catch(() => null)
  console.log(`HTTP ${res.status}`)
  console.log(JSON.stringify(body, null, 2))

  // Cleanup fixture people regardless of outcome — never leave test residue on prod
  await admin.from('people').delete().in('id', inserted.map((p) => p.id))
  console.log('\n  Cleanup: removed T5 fixture people')

  if (res.status === 200 && body?.ok === true && body?.status === 'sent') {
    console.log(`\n✓ T5-01 PASS — Telegram accepted the digest, messageId: ${body.message_id}, count: ${body.count}`)
    console.log('  Manual step: confirm the message physically arrived with correct names/ages/badges')
    console.log('  before citing verified: live (a 200 to a wrong chat is a silent failure).')
  } else {
    console.log('\n✗ T5-01 FAIL')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
