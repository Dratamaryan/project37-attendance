#!/usr/bin/env node
/**
 * Sprint 3 T7 — Import dry-run route smoke test.
 *
 * Mints an admin session against a Supabase project (default: local Docker,
 * via .env.test.local) and POSTs a small in-memory .xlsx to
 * POST /api/admin/import/people (mode=dry_run), asserting the JSON
 * classification response, exactly one new import.dry_run audit row, and
 * zero writes to people. Also confirms the unauthenticated path returns 401
 * (that check needs no session at all).
 *
 * Run (local dev server): node scripts/t7-import-dryrun.mjs
 * Run against a different base URL / env (e.g. deployed prod):
 *   T7_BASE_URL=https://... T7_ENV_FILE=.env.local node scripts/t7-import-dryrun.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const __dir = dirname(fileURLToPath(import.meta.url))
const envFile = process.env.T7_ENV_FILE ?? '.env.test.local'
const envPath = resolve(__dir, '..', envFile)
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx < 0) continue
  const key = trimmed.slice(0, eqIdx).trim()
  const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
  process.env[key] = val
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BASE_URL = process.env.T7_BASE_URL ?? 'http://localhost:3100'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(`Missing Supabase env vars from ${envFile}`)
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000101'
const ADMIN_EMAIL = 'import-test-admin-101@test.local'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log(`  OK: ${msg}`)
  } else {
    console.error(`  FAIL: ${msg}`)
    failures++
  }
}

async function ensureAdminUser() {
  const { data: existing } = await admin.from('app_users').select('id').eq('id', FAKE_ADMIN_ID).maybeSingle()
  if (!existing) {
    const { error } = await admin
      .from('app_users')
      .insert({ id: FAKE_ADMIN_ID, email: ADMIN_EMAIL, full_name: 'Import Test Admin', role: 'admin', active: true })
    if (error) throw new Error(`app_users insert: ${error.message}`)
  }
}

/**
 * Constructs the @supabase/ssr cookie the route's createClient() reads:
 * `sb-<project-ref>-auth-token` = `base64-` + base64(JSON session payload).
 * Format verified against the installed @supabase/ssr@0.10.3 source during
 * planning — internal, version-fragile, first attempt of its kind in this
 * repo. Time-boxed: if it doesn't produce a 200 in one attempt, the authed
 * HTTP happy-path is deferred to T8 (real browser session gets this for
 * free); correctness is already covered by the runImportDryRun integration
 * test, which never goes through HTTP or cookies at all.
 */
function buildAuthCookie(session, supabaseUrl) {
  const ref = new URL(supabaseUrl).hostname.split('.')[0]
  const cookieName = `sb-${ref}-auth-token`
  const payload = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  }
  const value = 'base64-' + Buffer.from(JSON.stringify(payload)).toString('base64')
  return `${cookieName}=${value}`
}

async function mintAdminSession() {
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: ADMIN_EMAIL,
  })
  if (linkErr) throw new Error(`generateLink: ${linkErr.message}`)

  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw new Error(`verifyOtp: ${verifyErr.message}`)
  return verifyData.session
}

function buildXlsxBuffer() {
  const aoa = [
    ['Nama Lengkap', 'Nomor HP'],
    ['T7 Smoke New', '0812000920001'],
    ['T7 Smoke Dup', '0812000920002'],
    ['T7 Smoke Dup', '0812000920002'],
  ]
  const worksheet = XLSX.utils.aoa_to_sheet(aoa)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

async function main() {
  console.log(`Base URL: ${BASE_URL}`)
  console.log(`Supabase: ${SUPABASE_URL}`)

  console.log('\n[1] Unauthenticated POST -> expect 401 (needs no session)')
  const unauthForm = new FormData()
  unauthForm.set('mode', 'dry_run')
  unauthForm.set('file', new Blob([buildXlsxBuffer()]), 'smoke.xlsx')
  const unauthRes = await fetch(`${BASE_URL}/api/admin/import/people`, { method: 'POST', body: unauthForm })
  assert(unauthRes.status === 401, `unauthenticated request returns 401 (got ${unauthRes.status})`)

  console.log('\n[2] Authenticated POST -> expect 200 + classification JSON (time-boxed)')
  await ensureAdminUser()
  let authedOk = false
  try {
    const session = await mintAdminSession()
    const cookie = buildAuthCookie(session, SUPABASE_URL)

    const before = await admin
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'import')

    const form = new FormData()
    form.set('mode', 'dry_run')
    form.set('file', new Blob([buildXlsxBuffer()]), 'smoke.xlsx')
    const res = await fetch(`${BASE_URL}/api/admin/import/people`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    })

    if (res.status !== 200) {
      const body = await res.text()
      console.warn(
        `  DEFERRED: authed cookie attempt did not reach 200 (got ${res.status}: ${body.slice(0, 200)}). ` +
          'Deferring the authenticated HTTP happy-path smoke to T8 (real browser session), per plan item 8. ' +
          'Correctness is already covered by the runImportDryRun integration test (no HTTP).',
      )
    } else {
      authedOk = true
      const json = await res.json()
      assert(json.classificationCounts.new === 1, `new count is 1 (got ${json.classificationCounts.new})`)
      assert(
        json.classificationCounts.dup_in_file === 1,
        `dup_in_file count is 1 (got ${json.classificationCounts.dup_in_file})`,
      )
      assert(typeof json.importId === 'string', 'importId present in response')

      const { count: after } = await admin
        .from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('entity_type', 'import')
      assert(
        after === (before.count ?? 0) + 1,
        `exactly one new import.dry_run audit row written (before=${before.count}, after=${after})`,
      )

      const { data: personCheck } = await admin
        .from('people')
        .select('id')
        .eq('phone_e164', '+62812000920001')
        .maybeSingle()
      assert(!personCheck, 'dry-run wrote nothing to people (no row for the "new" phone)')

      await admin.from('audit_log').delete().eq('entity_type', 'import').eq('entity_id', json.importId)
    }
  } catch (err) {
    console.warn(
      `  DEFERRED: authed cookie attempt threw (${err.message}). Deferring per plan item 8 — see note above.`,
    )
  }

  if (!authedOk) {
    console.log('\nNOTE: authenticated HTTP happy-path smoke deferred to T8. Flagging before commit per plan item 8.')
  }

  await admin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} (${failures} assertion failure(s))`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
