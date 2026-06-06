/**
 * Sprint 1 T12 — RLS acceptance tests T1-19, T1-20, T1-21
 *
 * T1-19: Organizer cannot DELETE from people via REST API
 * T1-20: Anonymous user gets empty result set from people via REST API
 * T1-21: audit_log is append-only — no UPDATE or DELETE for any authenticated user
 *
 * Run: node scripts/t12-rls.mjs
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

const SUPABASE_URL     = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY         = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const assertions = []
let allPassed = true
function assert(desc, passed, detail = '') {
  const s = passed ? '✓' : '✗ FAIL'
  assertions.push({ desc, passed, detail })
  console.log(`  ${s} ${desc}${detail ? ' — ' + detail : ''}`)
  if (!passed) allPassed = false
}

async function getOrganizerSession() {
  const { data: { users } } = await admin.auth.admin.listUsers({ perPage: 100 })
  const organizer = users.find(u => u.email === 'organizer-example@example.test')
  if (!organizer) {
    console.error('Organizer user not found. Run: node scripts/t12-setup.mjs first')
    process.exit(1)
  }

  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'organizer-example@example.test',
  })
  if (linkErr) throw linkErr

  // Create a temporary client using anon key to exchange the token
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr
  return verifyData.session
}

async function getAdminSession() {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin-example@example.test',
  })
  if (linkErr) throw linkErr

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw verifyErr
  return verifyData.session
}

async function testT119(organizerSession) {
  console.log('\n--- T1-19: Organizer cannot DELETE from people ---')

  // Get a real person to attempt deletion of
  const { data: people } = await admin.from('people').select('id,full_name').like('full_name', 'Dogfood Test%').limit(1)
  if (!people?.length) {
    console.log('  ! No Dogfood Test people found. Run t12-setup.mjs first.')
    assert('T1-19 organizer DELETE blocked by RLS', false, 'no test person available')
    return
  }
  const target = people[0]

  // Use organizer's JWT to attempt DELETE via REST API
  const deleteUrl = `${SUPABASE_URL}/rest/v1/people?id=eq.${target.id}`
  const resp = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${organizerSession.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  })

  const body = await resp.text()
  console.log(`  HTTP ${resp.status}: ${body.slice(0, 200)}`)

  // RLS with no DELETE policy → either 403 or empty result (person still exists)
  const isBlocked = resp.status === 403 || resp.status === 401 || (resp.status === 200 && body === '[]')

  assert(
    'T1-19: organizer DELETE attempt blocked by RLS (403 or 0 rows deleted)',
    isBlocked,
    `status=${resp.status}`
  )

  // Verify person still exists
  const { data: stillExists } = await admin.from('people').select('id').eq('id', target.id).maybeSingle()
  assert(
    'T1-19: person not physically deleted (still in DB)',
    !!stillExists,
    `id=${target.id}`
  )
  console.log(`  Person "${target.full_name}" (${target.id}) confirmed still in DB`)
}

async function testT120() {
  console.log('\n--- T1-20: Anonymous cannot read people ---')

  // REST API with anon key (no auth header — anon role only)
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/people?select=id,full_name&limit=10`, {
    headers: {
      apikey: ANON_KEY,
      // No Authorization header → anon role
    },
  })

  const body = await resp.text()
  console.log(`  HTTP ${resp.status}: ${body}`)

  // Expect: empty array [] (RLS filters all rows for anon role)
  assert(
    'T1-20: anon GET /rest/v1/people returns 200 (RLS silent filter)',
    resp.status === 200,
    `status=${resp.status}`
  )
  assert(
    'T1-20: anon response is empty array [] (no rows leaked)',
    body.trim() === '[]',
    `body=${body.slice(0, 100)}`
  )
}

async function testT121(adminSession) {
  console.log('\n--- T1-21: audit_log is append-only (no UPDATE/DELETE) ---')

  // Get a real audit_log row to attempt update on
  const { data: rows } = await admin.from('audit_log').select('id,action').limit(1)
  if (!rows?.length) {
    assert('T1-21 audit_log UPDATE blocked', false, 'no audit_log rows exist')
    return
  }
  const row = rows[0]

  // Attempt UPDATE on audit_log using admin JWT (not service role — that bypasses RLS)
  const updateUrl = `${SUPABASE_URL}/rest/v1/audit_log?id=eq.${row.id}`
  const updateResp = await fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${adminSession.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ action: 'TAMPERED' }),
  })
  const updateBody = await updateResp.text()
  console.log(`  UPDATE attempt — HTTP ${updateResp.status}: ${updateBody.slice(0, 200)}`)

  const updateBlocked = updateResp.status === 403 || updateResp.status === 401 || (updateResp.status === 200 && updateBody === '[]')
  assert(
    'T1-21: UPDATE audit_log blocked (no UPDATE policy for any role)',
    updateBlocked,
    `status=${updateResp.status}`
  )

  // Attempt DELETE on audit_log using admin JWT
  const deleteResp = await fetch(updateUrl, {
    method: 'DELETE',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${adminSession.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  })
  const deleteBody = await deleteResp.text()
  console.log(`  DELETE attempt — HTTP ${deleteResp.status}: ${deleteBody.slice(0, 200)}`)

  const deleteBlocked = deleteResp.status === 403 || deleteResp.status === 401 || (deleteResp.status === 200 && deleteBody === '[]')
  assert(
    'T1-21: DELETE audit_log blocked (no DELETE policy for any role)',
    deleteBlocked,
    `status=${deleteResp.status}`
  )

  // Confirm the row is unchanged
  const { data: unchanged } = await admin.from('audit_log').select('action').eq('id', row.id).single()
  assert(
    'T1-21: audit_log row unchanged (action still original value)',
    unchanged?.action === row.action,
    `expected=${row.action}, got=${unchanged?.action}`
  )
}

async function main() {
  console.log('=== T12 RLS Tests: T1-19, T1-20, T1-21 ===\n')

  // Get sessions
  console.log('Getting organizer session...')
  const organizerSession = await getOrganizerSession()
  console.log(`  Organizer JWT: ${organizerSession.access_token.slice(0, 20)}...`)

  console.log('Getting admin (non-service-role) session...')
  const adminSession = await getAdminSession()
  console.log(`  Admin JWT: ${adminSession.access_token.slice(0, 20)}...`)

  await testT119(organizerSession)
  await testT120()
  await testT121(adminSession)

  // Summary
  console.log('\n=== Summary ===')
  for (const a of assertions) {
    console.log(`  ${a.passed ? '✓' : '✗'} ${a.desc}${a.detail ? ' — ' + a.detail : ''}`)
  }
  const passed = assertions.filter(a => a.passed).length
  console.log(`\n${passed}/${assertions.length} assertions passed`)
  if (!allPassed) process.exit(1)
  console.log('\n✓ All RLS tests passed')
}

main().catch(e => { console.error(e); process.exit(1) })
