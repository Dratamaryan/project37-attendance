/**
 * Sprint 4 T4 — one-off prod fix: app_settings.telegram_admin_chat_id was set
 * to the bot's own user ID (8922952648) instead of Ryan's real DM chat ID.
 * Confirmed via getMe (bot id) vs getUpdates (Ryan's "Hi" message, chat id
 * 000000000, type: private) after Ryan messaged @Project37Admin_bot directly.
 *
 * Run once: node scripts/t4-fix-telegram-chat-id.mjs
 *
 * Uses the service-role client to bypass RLS for this single-row config
 * table (organizer_select/admin_select only allow SELECT, not UPDATE from
 * non-admin contexts) — same admin-client-for-maintenance-scripts pattern as
 * scripts/repair-roster-birthdates.ts. Writes one settings.update audit_log
 * row with Ryan's app_users id as actor.
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
const ADMIN_EMAIL = 'admin-example@example.test'
const CORRECT_CHAT_ID = '000000000'

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

async function getActorId(email) {
  const { data: linkData, error: linkErr } =
    await adminSupabase.auth.admin.generateLink({ type: 'magiclink', email })
  if (linkErr) throw linkErr

  const { data: verifyData, error: verifyErr } = await anonSupabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr
  return verifyData.session.user.id
}

async function main() {
  console.log('\n=== Sprint 4 T4 — fix telegram_admin_chat_id ===\n')

  const { data: before, error: beforeErr } = await adminSupabase
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .eq('id', 1)
    .single()
  if (beforeErr) throw beforeErr
  console.log('Before:', before.telegram_admin_chat_id)

  const actorId = await getActorId(ADMIN_EMAIL)

  const { error: updateErr } = await adminSupabase
    .from('app_settings')
    .update({ telegram_admin_chat_id: CORRECT_CHAT_ID, updated_at: new Date().toISOString() })
    .eq('id', 1)
  if (updateErr) throw updateErr

  const { error: auditErr } = await adminSupabase.rpc('log_audit', {
    p_actor_user_id: actorId,
    p_action: 'settings.update',
    p_entity_type: 'app_settings',
    p_entity_id: '1',
    p_details_json: {
      field: 'telegram_admin_chat_id',
      before: before.telegram_admin_chat_id,
      after: CORRECT_CHAT_ID,
      reason: 'T4-01 live verify found the stored value was the bot\'s own id, not the admin DM chat id',
    },
    p_ip_address: null,
    p_user_agent: 'scripts/t4-fix-telegram-chat-id.mjs',
  })
  if (auditErr) throw auditErr

  const { data: after, error: afterErr } = await adminSupabase
    .from('app_settings')
    .select('telegram_admin_chat_id')
    .eq('id', 1)
    .single()
  if (afterErr) throw afterErr
  console.log('After: ', after.telegram_admin_chat_id)
  console.log('\n✓ app_settings.telegram_admin_chat_id corrected + audit_log row written')
}

main().catch((err) => {
  console.error('Script error:', err)
  process.exit(1)
})
