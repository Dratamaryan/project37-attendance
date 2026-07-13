#!/usr/bin/env node
/**
 * Sprint 3 T8 — /admin/import UI end-to-end Playwright verify.
 *
 * Covers: full upload -> preview -> commit flow against a REAL deployed
 * instance, under a real authenticated admin browser session. Also
 * render-confirms AppTopbar + bottom nav actually appear on /admin/import
 * (S1/S2 taught us layout inheritance must be confirmed, never assumed), and
 * that the nav link + page are admin-gated (organizer session gets neither).
 * Closes T7's deferred gate: the preview step IS a real authenticated
 * mode=dry_run round trip, asserted explicitly below (200, correct
 * classification JSON, exactly one import.dry_run audit row, zero people
 * writes) before commit is ever clicked.
 *
 * Fixture phone space: +62812000921xxx (distinct from T7's own smoke script,
 * which already claimed +62812000920001/002 in scripts/t7-import-dryrun.mjs).
 * FAKE ids use app_users role='organizer' for the negative admin-gate check
 * (reuses the existing organizer test account, per T6's script).
 *
 * Run: node scripts/t8-playwright-import.mjs
 * Run against a different base URL: T8_BASE_URL=https://... node scripts/t8-playwright-import.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import * as XLSX from 'xlsx'

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
const BASE_URL = process.env.T8_BASE_URL ?? 'https://project37-attendance.vercel.app'
const PROJECT_REF = new URL(SUPABASE_URL ?? 'https://bftifxgdcmisasgvobuf.supabase.co').hostname.split('.')[0]
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

const ADMIN_EMAIL = 'admin-example@example.test'
const ORGANIZER_EMAIL = 'organizer-example@example.test'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonSupabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const PREFIX = '+62812000921'
const PHONES = {
  NEW: `${PREFIX}001`,
  DUP_IN_FILE: `${PREFIX}002`,
  DB_ACTIVE: `${PREFIX}003`,
  DB_DELETED: `${PREFIX}004`,
}
const FILENAME = 't8-playwright-smoke.xlsx'

// ── Assertion helpers ────────────────────────────────────────────────────────
const results = []
let allPassed = true
function pass(id, desc, detail = '') {
  results.push({ id, passed: true, desc, detail })
  console.log(`  ✓ ${id}: ${desc}${detail ? ' — ' + detail : ''}`)
}
function fail(id, desc, detail = '') {
  results.push({ id, passed: false, desc, detail })
  console.log(`  ✗ ${id}: ${desc}${detail ? ' — ' + detail : ''}`)
  allPassed = false
}

// ── Cookie helper — matches @supabase/ssr base64 encoding (T6 pattern) ───────
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

async function injectSession(context, session) {
  await context.addCookies([{
    name: COOKIE_NAME,
    value: sessionToCookie(session),
    domain: new URL(BASE_URL).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
}

function buildXlsxBuffer() {
  const aoa = [
    ['Nama Lengkap', 'Nomor HP'],
    ['T8 Playwright New', PHONES.NEW.replace('+62', '0')],
    ['T8 Playwright DupFile A', PHONES.DUP_IN_FILE.replace('+62', '0')],
    ['T8 Playwright DupFile B', PHONES.DUP_IN_FILE.replace('+62', '0')],
    ['T8 Playwright DB Active', PHONES.DB_ACTIVE.replace('+62', '0')],
    ['T8 Playwright DB Deleted', PHONES.DB_DELETED.replace('+62', '0')],
    ['T8 Playwright Bad Row', null],
  ]
  const worksheet = XLSX.utils.aoa_to_sheet(aoa)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

async function cleanup() {
  await adminSupabase.from('people').delete().like('phone_e164', `${PREFIX}%`)
  await adminSupabase.from('audit_log').delete().in('action', ['import.dry_run', 'import.commit']).eq('details_json->>filename', FILENAME)
  console.log('  pre-cleanup: removed stale T8 test people + audit rows')
}

async function seedDbFixtures() {
  await adminSupabase.from('people').insert({ phone_e164: PHONES.DB_ACTIVE, full_name: 'T8 Pre-existing Active', nickname: 'Active' })
  await adminSupabase.from('people').insert({
    phone_e164: PHONES.DB_DELETED,
    full_name: 'T8 Pre-existing Deleted',
    nickname: 'Deleted',
    deleted_at: new Date().toISOString(),
  })
}

async function main() {
  console.log('\n=== Sprint 3 T8 — /admin/import Playwright E2E ===\n')
  console.log(`Base URL: ${BASE_URL}`)

  await cleanup()
  await seedDbFixtures()

  const browser = await chromium.launch({ headless: true })

  // ── T8-01: Organizer session is admin-gated out (negative check) ─────────
  console.log('\nT8-01: Organizer session cannot reach /admin/import')
  try {
    const orgCtx = await browser.newContext()
    const orgSession = await getSessionFor(ORGANIZER_EMAIL)
    await injectSession(orgCtx, orgSession)
    const orgPage = await orgCtx.newPage()
    await orgPage.goto(`${BASE_URL}/admin/import`, { waitUntil: 'networkidle' })

    const hasNotAuthorized = await orgPage.waitForFunction(
      () => document.body.innerText.toLowerCase().includes('access denied')
        || document.body.innerText.toLowerCase().includes('akses ditolak'),
      { timeout: 8_000 },
    ).then(() => true).catch(() => false)

    const hasImportUI = await orgPage.locator('#import-file').count() > 0

    if (hasNotAuthorized && !hasImportUI) {
      pass('T8-01a', 'Organizer sees not-authorized, not the import form')
    } else {
      fail('T8-01a', 'Organizer guard did not render expected not-authorized state', `hasNotAuthorized=${hasNotAuthorized} hasImportUI=${hasImportUI}`)
    }

    // Nav link itself must also be admin-gated — check on a page organizers CAN reach.
    await orgPage.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' })
    const orgSeesImportLink = await orgPage.locator('a[href="/admin/import"]').count() > 0
    if (!orgSeesImportLink) {
      pass('T8-01b', 'Organizer does not see the Import nav link')
    } else {
      fail('T8-01b', 'Organizer nav unexpectedly includes the Import link')
    }
    await orgCtx.close()
  } catch (e) {
    fail('T8-01', 'Organizer negative-check errored', String(e))
  }

  // ── Admin session for the rest of the flow ────────────────────────────────
  const adminCtx = await browser.newContext()
  const adminSession = await getSessionFor(ADMIN_EMAIL)
  await injectSession(adminCtx, adminSession)
  const page = await adminCtx.newPage()

  // ── T8-02: AppTopbar + bottom nav render-confirmed on /admin/import ──────
  console.log('\nT8-02: Render-confirm AppTopbar + bottom nav on /admin/import')
  try {
    await page.goto(`${BASE_URL}/admin/import`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#import-file', { timeout: 10_000 })

    const hasTopbarNav = await page.locator('nav[aria-label="Main navigation"]').count() > 0
    const hasBottomNav = await page.locator('nav[aria-label="Bottom navigation"]').count() > 0
    const hasImportLinkInNav = await page.locator('nav a[href="/admin/import"]').count() > 0

    if (hasTopbarNav && hasBottomNav) {
      pass('T8-02a', 'Both topbar nav and bottom-tab nav render on /admin/import')
    } else {
      fail('T8-02a', 'Missing nav element(s)', `topbar=${hasTopbarNav} bottom=${hasBottomNav}`)
    }
    if (hasImportLinkInNav) {
      pass('T8-02b', 'Import nav link present for admin session')
    } else {
      fail('T8-02b', 'Import nav link missing for admin session')
    }
  } catch (e) {
    fail('T8-02', 'Layout render-confirm errored', String(e))
  }

  // ── T8-03: Upload -> preview (closes T7's dry_run gate) ───────────────────
  console.log('\nT8-03: Upload file -> preview renders correct counts (real authed dry_run round trip)')
  let dryRunImportId = null
  try {
    const buffer = buildXlsxBuffer()
    await page.setInputFiles('#import-file', {
      name: FILENAME,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    })

    const [dryRunResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/admin/import/people') && res.request().method() === 'POST'),
      page.click('#import-preview-button'),
    ])

    if (dryRunResponse.status() === 200) {
      pass('T8-03a', 'mode=dry_run POST returns 200 under real admin session (closes T7 deferred gate)')
    } else {
      fail('T8-03a', `mode=dry_run POST did not return 200`, `status=${dryRunResponse.status()}`)
    }
    const dryRunJson = await dryRunResponse.json()
    dryRunImportId = dryRunJson.importId

    await page.waitForSelector('[data-import-phase="preview_ready"]', { timeout: 10_000 })

    const counts = {
      new: await page.locator('#import-count-new').innerText(),
      dup_in_db: await page.locator('#import-count-dup_in_db').innerText(),
      dup_in_file: await page.locator('#import-count-dup_in_file').innerText(),
      dup_soft_deleted: await page.locator('#import-count-dup_soft_deleted').innerText(),
      error: await page.locator('#import-count-error').innerText(),
    }
    const expected = { new: '2', dup_in_db: '1', dup_in_file: '1', dup_soft_deleted: '1', error: '1' }
    const countsMatch = JSON.stringify(counts) === JSON.stringify(expected)
    if (countsMatch) {
      pass('T8-03b', 'Preview per-class counts match expected classification', JSON.stringify(counts))
    } else {
      fail('T8-03b', 'Preview counts mismatch', `got ${JSON.stringify(counts)} want ${JSON.stringify(expected)}`)
    }

    const rowCount = await page.locator('#import-preview-table tbody tr').count()
    if (rowCount === 6) {
      pass('T8-03c', 'Preview table renders all 6 rows')
    } else {
      fail('T8-03c', 'Preview table row count mismatch', `got ${rowCount}`)
    }

    // Exactly one import.dry_run audit row, zero people writes (T7 gap closed).
    const { count: dryRunAuditCount } = await adminSupabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'import.dry_run')
      .eq('entity_id', dryRunImportId)
    if (dryRunAuditCount === 1) {
      pass('T8-03d', 'Exactly one import.dry_run audit row written')
    } else {
      fail('T8-03d', 'import.dry_run audit row count wrong', `got ${dryRunAuditCount}`)
    }

    const { data: newPersonYet } = await adminSupabase.from('people').select('id').eq('phone_e164', PHONES.NEW).maybeSingle()
    if (!newPersonYet) {
      pass('T8-03e', 'Dry-run wrote nothing to people (NEW phone absent before commit)')
    } else {
      fail('T8-03e', 'Dry-run unexpectedly created a people row before commit')
    }
  } catch (e) {
    fail('T8-03', 'Upload/preview flow errored', String(e))
  }

  // ── T8-04: Error CSV download has correct columns/content ─────────────────
  console.log('\nT8-04: Error CSV download')
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#import-download-errors-button'),
    ])
    const csvPath = await download.path()
    const csvContent = readFileSync(csvPath, 'utf8')
    const lines = csvContent.trim().split('\n')
    const header = lines[0]
    const dataLine = lines[1]

    if (header === 'row #,phone,name,reason') {
      pass('T8-04a', 'Error CSV header matches spec exactly', header)
    } else {
      fail('T8-04a', 'Error CSV header mismatch', header)
    }

    if (dataLine.includes('T8 Playwright Bad Row') && dataLine.includes('missing_phone')) {
      pass('T8-04b', 'Error CSV row content correct', dataLine)
    } else {
      fail('T8-04b', 'Error CSV row content wrong', dataLine)
    }
  } catch (e) {
    fail('T8-04', 'Error CSV download errored', String(e))
  }

  // ── T8-05: Confirm import -> commit ───────────────────────────────────────
  console.log('\nT8-05: Confirm import (commit)')
  let commitImportId = null
  try {
    const [commitResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/admin/import/people') && res.request().method() === 'POST'),
      page.click('#import-commit-button'),
    ])

    if (commitResponse.status() === 200) {
      pass('T8-05a', 'mode=commit POST returns 200')
    } else {
      fail('T8-05a', 'mode=commit POST did not return 200', `status=${commitResponse.status()}`)
    }
    const commitJson = await commitResponse.json()
    commitImportId = commitJson.importId

    await page.waitForSelector('[data-import-phase="committed"]', { timeout: 10_000 })

    const resultCounts = {
      attempted: await page.locator('#import-result-attempted').innerText(),
      inserted: await page.locator('#import-result-inserted').innerText(),
      raced: await page.locator('#import-result-raced').innerText(),
      skipped_dup: await page.locator('#import-result-skipped_dup').innerText(),
      skipped_error: await page.locator('#import-result-skipped_error').innerText(),
    }
    const expectedResult = { attempted: '2', inserted: '2', raced: '0', skipped_dup: '3', skipped_error: '1' }
    if (JSON.stringify(resultCounts) === JSON.stringify(expectedResult)) {
      pass('T8-05b', 'Commit result summary matches expected counts', JSON.stringify(resultCounts))
    } else {
      fail('T8-05b', 'Commit result summary mismatch', `got ${JSON.stringify(resultCounts)} want ${JSON.stringify(expectedResult)}`)
    }

    // people rows: created for 'new' only, zero for dup/error.
    const { data: newRow } = await adminSupabase.from('people').select('id').eq('phone_e164', PHONES.NEW).maybeSingle()
    const { data: dupFileRow } = await adminSupabase.from('people').select('id').eq('phone_e164', PHONES.DUP_IN_FILE).maybeSingle()
    if (newRow && dupFileRow) {
      pass('T8-05c', 'People rows created for both new-classified phones')
    } else {
      fail('T8-05c', 'Expected new people rows missing', `new=${!!newRow} dupFile=${!!dupFileRow}`)
    }

    const { count: dbActiveCount } = await adminSupabase.from('people').select('id', { count: 'exact', head: true }).eq('phone_e164', PHONES.DB_ACTIVE)
    const { count: dbDeletedCount } = await adminSupabase.from('people').select('id', { count: 'exact', head: true }).eq('phone_e164', PHONES.DB_DELETED)
    if (dbActiveCount === 1 && dbDeletedCount === 1) {
      pass('T8-05d', 'dup_in_db and dup_soft_deleted phones did NOT create new rows')
    } else {
      fail('T8-05d', 'Unexpected row count for dup phones', `dbActive=${dbActiveCount} dbDeleted=${dbDeletedCount}`)
    }

    const { data: stillDeleted } = await adminSupabase.from('people').select('deleted_at').eq('phone_e164', PHONES.DB_DELETED).single()
    if (stillDeleted?.deleted_at) {
      pass('T8-05e', 'Soft-deleted person was never resurrected')
    } else {
      fail('T8-05e', 'Soft-deleted person deleted_at was cleared — resurrection bug')
    }

    const { count: commitAuditCount } = await adminSupabase
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'import.commit')
      .eq('entity_id', commitImportId)
    if (commitAuditCount === 1) {
      pass('T8-05f', 'Exactly one import.commit audit row written')
    } else {
      fail('T8-05f', 'import.commit audit row count wrong', `got ${commitAuditCount}`)
    }
  } catch (e) {
    fail('T8-05', 'Commit flow errored', String(e))
  }

  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`RESULTS: ${results.filter((r) => r.passed).length}/${results.length} passed`)
  console.log('='.repeat(60))

  // ── Final cleanup (scoped hard-delete of this run's test data) ───────────
  await adminSupabase.from('people').delete().like('phone_e164', `${PREFIX}%`)
  if (dryRunImportId) await adminSupabase.from('audit_log').delete().eq('entity_type', 'import').eq('entity_id', dryRunImportId)
  if (commitImportId) await adminSupabase.from('audit_log').delete().eq('entity_type', 'import').eq('entity_id', commitImportId)
  console.log('Cleanup: removed all +62812000921xxx test people + this run\'s audit rows')

  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
