/**
 * Sprint 4 T4-01 — live verification: POST /api/admin/telegram/test against
 * prod, confirm a message actually reaches Ryan's Telegram.
 *
 * Run: node scripts/t4-telegram-live-test.mjs
 *
 * Auth pattern matches scripts/t6-playwright.mjs: service-role client
 * generates a magic link, anon client verifies it to get a session, session
 * is packed into the sb-<ref>-auth-token cookie @supabase/ssr expects. No
 * browser needed — this route has no UI to drive, just a POST to assert on.
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
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const PROD_URL = 'https://project37-attendance.vercel.app'
const PROJECT_REF = 'bftifxgdcmisasgvobuf'
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`
const ADMIN_EMAIL = 'admin@example.com'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars')
  process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonSupabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function sessionToCookie(session) {
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
}

async function getSessionFor(email) {
  const { data: linkData, error: linkErr } =
    await adminSupabase.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr

  const { data: verifyData, error: verifyErr } = await anonSupabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr
  return verifyData.session
}

async function main() {
  console.log('\n=== Sprint 4 T4-01 — live Telegram test ===\n')

  const session = await getSessionFor(ADMIN_EMAIL)
  const cookie = `${COOKIE_NAME}=${sessionToCookie(session)}`

  const res = await fetch(`${PROD_URL}/api/admin/telegram/test`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })

  const body = await res.json().catch(() => null)
  console.log(`HTTP ${res.status}`)
  console.log(JSON.stringify(body, null, 2))

  if (res.status === 200 && body?.ok === true) {
    console.log('\n✓ T4-01 PASS — Telegram accepted the message, messageId:', body.messageId)
    console.log('  Manual step: confirm the message physically arrived in Telegram before citing verified: live.')
  } else {
    console.log('\n✗ T4-01 FAIL')
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
