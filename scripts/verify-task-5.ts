/**
 * CLI verify script for Sprint 1 Task 5 — people server actions.
 *
 * Calls impl_createPerson + impl_setPhotoConsent against the real Supabase DB,
 * queries the resulting audit_log rows, prints them as JSON, then cleans up.
 *
 * Uses the admin (service-role) client for DB operations so it works without a
 * browser session. The actor_user_id is injected by listing the first admin
 * user via the Admin Auth API — this is the same UUID that real server actions
 * would write to audit_log when that user is logged in.
 *
 * Run (requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env):
 *   npx dotenv -e .env.local -- npx tsx scripts/verify-task-5.ts
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { impl_createPerson, impl_setPhotoConsent } from '../lib/actions/people.impl'

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!
const VERIFY_PHONE      = '08123450999'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

async function main() {
  // Admin client for DB operations (bypasses RLS — acceptable for CLI verify only)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // Get the first admin user to use as the verify actor
  const { data: usersPage, error: usersError } = await admin.auth.admin.listUsers({ perPage: 50 })
  if (usersError) { console.error('Could not list users:', usersError); process.exit(1) }

  // Find admin user (admin-example@example.test or first user)
  const adminUser =
    usersPage.users.find(u => u.email === 'admin-example@example.test') ??
    usersPage.users[0]

  if (!adminUser) { console.error('No users found in Supabase'); process.exit(1) }

  console.log(`Using actor: ${adminUser.email} (${adminUser.id})\n`)

  // Build a supabase client that patches auth.getUser() to return the admin user.
  // All DB calls go through the service role key (real writes to the real DB).
  // This simulates the server action chain: session → actor_user_id → audit log.
  const supabase: SupabaseClient = {
    ...admin,
    auth: {
      ...admin.auth,
      getUser: () =>
        Promise.resolve({
          data: { user: { id: adminUser.id, email: adminUser.email } },
          error: null,
        }),
    },
  } as unknown as SupabaseClient

  // Clean up leftover from previous run
  const E164 = '+6281234509999'
  const { data: leftover } = await admin.from('people').select('id').eq('phone_e164', E164).maybeSingle()
  if (leftover) {
    await admin.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', leftover.id)
    console.log(`Cleaned up leftover test person: ${leftover.id}\n`)
  }

  // ── Step 1: createPerson ─────────────────────────────────────────────────
  console.log('--- Step 1: createPerson ---')
  const createResult = await impl_createPerson(
    {
      phone_e164_raw: VERIFY_PHONE,
      country:        'ID',
      full_name:      '_VerifyTask5 Test Person',
      nickname:       '_VerifyTask5',
      birth_date:     '2000-01-01',
    },
    supabase,
  )
  console.log(JSON.stringify(createResult, null, 2))

  if (createResult.status !== 'created') {
    console.error('\ncreateResult was not "created" — aborting')
    process.exit(1)
  }
  const personId = createResult.person.id

  // ── Step 2: setPhotoConsent (grant) ─────────────────────────────────────
  console.log('\n--- Step 2: setPhotoConsent(true) ---')
  const consentResult = await impl_setPhotoConsent(personId, true, supabase)
  console.log(JSON.stringify(consentResult, null, 2))

  // ── Step 3: query audit_log ──────────────────────────────────────────────
  console.log('\n--- Step 3: audit_log rows for entity ---')
  const { data: rows, error: auditErr } = await admin
    .from('audit_log')
    .select('id, actor_user_id, action, entity_type, entity_id, details_json, created_at')
    .eq('entity_id', personId)
    .order('created_at', { ascending: true })

  if (auditErr) { console.error('audit_log query error:', auditErr) }
  console.log(JSON.stringify(rows, null, 2))

  // ── Assertions ───────────────────────────────────────────────────────────
  console.log('\n--- Assertions ---')
  const assertions = {
    'row[0] actor_user_id = adminUser.id': rows?.[0]?.actor_user_id === adminUser.id,
    'row[0] action = people.create':       rows?.[0]?.action === 'people.create',
    'row[0] details has phone_e164':       !!rows?.[0]?.details_json?.phone_e164,
    'row[0] details no birth_date':        !rows?.[0]?.details_json?.birth_date,
    'row[1] actor_user_id = adminUser.id': rows?.[1]?.actor_user_id === adminUser.id,
    'row[1] action = consent.grant':       rows?.[1]?.action === 'consent.grant',
    'row[1] action ≠ people.update':       rows?.[1]?.action !== 'people.update',
    'row[1] details.from = false':         rows?.[1]?.details_json?.from === false,
    'row[1] details.to = true':            rows?.[1]?.details_json?.to === true,
  }
  console.log(JSON.stringify(assertions, null, 2))

  const passed = Object.values(assertions).every(Boolean)
  console.log(`\n${passed ? '✓ All assertions passed' : '✗ Some assertions FAILED'}`)

  // ── Cleanup ──────────────────────────────────────────────────────────────
  await admin.from('people').update({ deleted_at: new Date().toISOString() }).eq('id', personId)
  console.log(`\nCleaned up test person ${personId}`)
}

main().catch(e => { console.error(e); process.exit(1) })
