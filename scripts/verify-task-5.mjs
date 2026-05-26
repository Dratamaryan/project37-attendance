/**
 * CLI verify script for Sprint 1 Task 5 (JavaScript/ESM, no TypeScript needed).
 * Reads .env.local, uses the Supabase admin client to exercise the same DB logic
 * as impl_createPerson + impl_setPhotoConsent, and queries the resulting audit rows.
 *
 * Run:  node scripts/verify-task-5.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

// ── Load .env.local ──────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env.local')
const envLines = readFileSync(envPath, 'utf8').split('\n')
for (const line of envLines) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx < 0) continue
  const key = trimmed.slice(0, eqIdx).trim()
  const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
  if (!process.env[key]) process.env[key] = val
}

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// ── Admin client (service role — for verify only) ────────────────────────────
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// E.164 from normalizePhone('08123450999', 'ID')
const VERIFY_E164 = '+628123450999'

async function main() {
  // Get admin user (actor for audit rows)
  const { data: usersPage, error: usersError } = await admin.auth.admin.listUsers({ perPage: 50 })
  if (usersError) { console.error('listUsers failed:', usersError); process.exit(1) }

  const adminUser =
    usersPage.users.find(u => u.email === 'admin-example@example.test') ??
    usersPage.users[0]

  if (!adminUser) { console.error('No users found'); process.exit(1) }
  const actorId = adminUser.id
  console.log(`Actor: ${adminUser.email} (${actorId})\n`)

  // Clean up any leftover from a previous run
  const { data: leftover } = await admin
    .from('people')
    .select('id')
    .eq('phone_e164', VERIFY_E164)
    .maybeSingle()

  if (leftover) {
    await admin.from('people').update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', leftover.id)
    console.log(`Cleaned up leftover: ${leftover.id}\n`)
  }

  // ── Step 1: INSERT person (mirrors impl_createPerson) ────────────────────
  console.log('--- Step 1: INSERT person ---')
  const now = new Date().toISOString()

  const { data: created, error: insertErr } = await admin
    .from('people')
    .insert({
      phone_e164:            VERIFY_E164,
      full_name:             '_VerifyTask5 Test Person',
      nickname:              '_VerifyTask5',
      birth_date:            '2000-01-01',
      photo_publish_consent: false,
      updated_at:            now,
    })
    .select('id, phone_e164, full_name, nickname, photo_publish_consent, created_at')
    .single()

  if (insertErr) { console.error('INSERT failed:', insertErr); process.exit(1) }
  const personId = created.id
  console.log('Person created:', JSON.stringify(created, null, 2))

  // log_audit for create (mirrors logAudit call in impl_createPerson)
  const { error: auditErr1 } = await admin.rpc('log_audit', {
    p_actor_user_id: actorId,
    p_action:        'people.create',
    p_entity_type:   'people',
    p_entity_id:     personId,
    p_details_json:  { phone_e164: VERIFY_E164, full_name: '_VerifyTask5 Test Person', has_photo: false },
  })
  if (auditErr1) { console.error('log_audit (create) failed:', auditErr1); process.exit(1) }

  // ── Step 2: UPDATE consent (mirrors impl_setPhotoConsent) ────────────────
  console.log('\n--- Step 2: UPDATE photo consent (grant) ---')

  // Read consent policy version
  const { data: settings } = await admin.from('app_settings').select('consent_policy_version').single()
  const policyVersion = settings?.consent_policy_version ?? null

  const { data: updated, error: updateErr } = await admin
    .from('people')
    .update({
      photo_publish_consent: true,
      photo_consent_at:      new Date().toISOString(),
      photo_consent_version: policyVersion,
      updated_at:            new Date().toISOString(),
    })
    .eq('id', personId)
    .select('id, photo_publish_consent, photo_consent_version, photo_consent_at')
    .single()

  if (updateErr) { console.error('UPDATE consent failed:', updateErr); process.exit(1) }
  console.log('Consent update result:', JSON.stringify(updated, null, 2))

  // log_audit for consent.grant (mirrors logAudit call in impl_setPhotoConsent)
  const { error: auditErr2 } = await admin.rpc('log_audit', {
    p_actor_user_id: actorId,
    p_action:        'consent.grant',
    p_entity_type:   'people',
    p_entity_id:     personId,
    p_details_json:  { from: false, to: true },
  })
  if (auditErr2) { console.error('log_audit (consent.grant) failed:', auditErr2); process.exit(1) }

  // ── Step 3: query audit_log ──────────────────────────────────────────────
  console.log('\n--- Step 3: audit_log rows ---')
  const { data: rows, error: queryErr } = await admin
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json, created_at')
    .eq('entity_id', personId)
    .order('created_at', { ascending: true })

  if (queryErr) { console.error('audit_log query failed:', queryErr); process.exit(1) }
  console.log(JSON.stringify(rows, null, 2))

  // ── Assertions ───────────────────────────────────────────────────────────
  console.log('\n--- Assertions ---')
  const assertions = {
    'two audit rows written':              rows.length === 2,
    'row[0] actor_user_id = actorId':     rows[0]?.actor_user_id === actorId,
    'row[0] action = people.create':      rows[0]?.action === 'people.create',
    'row[0] details has phone_e164':      !!rows[0]?.details_json?.phone_e164,
    'row[0] details no birth_date':       !rows[0]?.details_json?.birth_date,
    'row[1] actor_user_id = actorId':     rows[1]?.actor_user_id === actorId,
    'row[1] action = consent.grant':      rows[1]?.action === 'consent.grant',
    'row[1] action ≠ people.update':      rows[1]?.action !== 'people.update',
    'row[1] details.from = false':        rows[1]?.details_json?.from === false,
    'row[1] details.to = true':           rows[1]?.details_json?.to === true,
  }
  let allPassed = true
  for (const [desc, passed] of Object.entries(assertions)) {
    console.log(`  ${passed ? '✓' : '✗'} ${desc}`)
    if (!passed) allPassed = false
  }
  console.log(allPassed ? '\n✓ All assertions passed' : '\n✗ Some assertions FAILED')

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await admin.from('people').update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', personId)
  console.log(`\nCleaned up test person ${personId}`)

  return { rows, allPassed }
}

main().catch(e => { console.error(e); process.exit(1) })
