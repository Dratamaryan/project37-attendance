/**
 * Sprint 3 T9 — Live prod acceptance checks for T3-01 and T3-02
 *
 * T3-01: Filter analytics to last 90 days → all KPIs reflect the filtered range.
 * T3-02: Filter to a single parish → counts match ground-truth SQL
 *        (attendance_summary WHERE instance_status <> 'cancelled'
 *         AND person_deleted_at IS NULL AND origin_parish = X — the exact
 *         semantics impl_getKpiSummary queries against).
 *
 * Ground-truth numbers below were captured via the Supabase Management API
 * read-only SQL endpoint immediately before this run (see docs/sprint-3-acceptance.md
 * for the queries). This script only exercises the LIVE UI and diffs against
 * those pre-captured numbers — it does not re-derive them, to keep the
 * assertion honest about what changed between capture and run (if prod data
 * shifts between the two, the diff will fail loudly rather than silently
 * re-deriving a moving target).
 *
 * Run: node scripts/t9-acceptance-live.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

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
const PROD_URL         = 'https://project37-attendance.vercel.app'
const PROJECT_REF      = 'bftifxgdcmisasgvobuf'
const COOKIE_NAME      = `sb-${PROJECT_REF}-auth-token`

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Ground truth, captured via Management API just before this run ─────────
// SELECT count(*), count(distinct person_id) FROM attendance_summary
//   WHERE instance_status <> 'cancelled' AND person_deleted_at IS NULL
//   AND checked_in_at >= '2026-04-14' AND checked_in_at < '2026-07-14';
const T3_01_FROM = '2026-04-14'
const T3_01_TO   = '2026-07-13'
const T3_01_GT   = { total_checkins: 80, distinct_people: 29 }

// SELECT count(*), count(distinct person_id), count(distinct event_id),
//   count(distinct event_instance_id) FROM attendance_summary
//   WHERE instance_status <> 'cancelled' AND person_deleted_at IS NULL
//   AND origin_parish = 'Paroki Bintaro Jaya';
const T3_02_PARISH = 'Paroki Bintaro Jaya'
const T3_02_GT     = { total_checkins: 27, distinct_people: 9, distinct_events: 3, distinct_instances: 13 }

// ── Assertion helpers ────────────────────────────────────────────────────────
const results = []
let allPassed = true
function pass(id, desc, detail = '') {
  results.push({ id, passed: true, desc, detail })
  console.log(`  ✓ ${id}: ${desc}${detail ? ' — ' + detail : ''}`)
}
function fail(id, desc, detail = '') {
  results.push({ id, passed: false, desc, detail })
  console.error(`  ✗ ${id}: ${desc}${detail ? ' — ' + detail : ''}`)
  allPassed = false
}

async function getSessionForEmail(email) {
  const { data: linkData, error: linkErr } = await adminSupabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr) throw new Error(`generateLink failed for ${email}: ${linkErr.message}`)

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: verifyData, error: verifyErr } = await anonClient.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (verifyErr) throw new Error(`verifyOtp failed: ${verifyErr.message}`)
  return verifyData.session
}

function sessionToCookie(session) {
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
}

async function injectSession(context, session) {
  await context.addCookies([{
    name: COOKIE_NAME,
    value: sessionToCookie(session),
    domain: 'project37-attendance.vercel.app',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
}

const NAV_TIMEOUT = 15000
const SETTLE      = 1500

async function readKpis(page) {
  const read = async (testId) => {
    const el = page.locator(`[data-testid="${testId}"]`)
    await el.waitFor({ state: 'attached', timeout: 8000 })
    const txt = (await el.textContent())?.trim()
    return txt
  }
  return {
    total_checkins:     await read('kpi-total-checkins'),
    distinct_people:    await read('kpi-distinct-people'),
    distinct_events:    await read('kpi-distinct-events'),
    distinct_instances: await read('kpi-distinct-instances'),
  }
}

async function main() {
  console.log(`\n=== T9 Live Acceptance — T3-01 (date range) + T3-02 (parish) ===`)
  console.log(`Production: ${PROD_URL}\n`)

  console.log('Getting admin session...')
  const adminSession = await getSessionForEmail('admin-example@example.test')
  console.log(`  Admin session obtained (${adminSession.user?.email})\n`)

  const browser = await chromium.launch({ headless: true })

  try {
    // ── T3-01: last-90-days filter ────────────────────────────────────────
    console.log(`T3-01: last-90-days filter (${T3_01_FROM} .. ${T3_01_TO})`)
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      const url = `${PROD_URL}/admin/analytics?from=${T3_01_FROM}&to=${T3_01_TO}`
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const urlNow = page.url()
      if (urlNow.includes(`from=${T3_01_FROM}`) && urlNow.includes(`to=${T3_01_TO}`)) {
        pass('T3-01a', 'URL carries from/to params', urlNow.split('?')[1])
      } else {
        fail('T3-01a', 'URL missing from/to params', urlNow)
      }

      const kpis = await readKpis(page)
      if (kpis.total_checkins === String(T3_01_GT.total_checkins)) {
        pass('T3-01b', `KPI total_checkins matches ground truth: ${kpis.total_checkins}`)
      } else {
        fail('T3-01b', `KPI total_checkins mismatch`, `got ${kpis.total_checkins}, expected ${T3_01_GT.total_checkins}`)
      }
      if (kpis.distinct_people === String(T3_01_GT.distinct_people)) {
        pass('T3-01c', `KPI distinct_people matches ground truth: ${kpis.distinct_people}`)
      } else {
        fail('T3-01c', `KPI distinct_people mismatch`, `got ${kpis.distinct_people}, expected ${T3_01_GT.distinct_people}`)
      }

      await ctx.close()
    }

    // ── T3-02: single-parish filter ───────────────────────────────────────
    console.log(`\nT3-02: single-parish filter (${T3_02_PARISH})`)
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      const url = `${PROD_URL}/admin/analytics?parish=${encodeURIComponent(T3_02_PARISH)}`
      await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const urlNow = page.url()
      if (decodeURIComponent(urlNow).includes(`parish=${T3_02_PARISH}`)) {
        pass('T3-02a', 'URL carries parish param', urlNow.split('?')[1])
      } else {
        fail('T3-02a', 'URL missing parish param', urlNow)
      }

      const kpis = await readKpis(page)
      if (kpis.total_checkins === String(T3_02_GT.total_checkins)) {
        pass('T3-02b', `KPI total_checkins matches ground truth: ${kpis.total_checkins}`)
      } else {
        fail('T3-02b', `KPI total_checkins mismatch`, `got ${kpis.total_checkins}, expected ${T3_02_GT.total_checkins}`)
      }
      if (kpis.distinct_people === String(T3_02_GT.distinct_people)) {
        pass('T3-02c', `KPI distinct_people matches ground truth: ${kpis.distinct_people}`)
      } else {
        fail('T3-02c', `KPI distinct_people mismatch`, `got ${kpis.distinct_people}, expected ${T3_02_GT.distinct_people}`)
      }
      if (kpis.distinct_events === String(T3_02_GT.distinct_events)) {
        pass('T3-02d', `KPI distinct_events matches ground truth: ${kpis.distinct_events}`)
      } else {
        fail('T3-02d', `KPI distinct_events mismatch`, `got ${kpis.distinct_events}, expected ${T3_02_GT.distinct_events}`)
      }
      if (kpis.distinct_instances === String(T3_02_GT.distinct_instances)) {
        pass('T3-02e', `KPI distinct_instances matches ground truth: ${kpis.distinct_instances}`)
      } else {
        fail('T3-02e', `KPI distinct_instances mismatch`, `got ${kpis.distinct_instances}, expected ${T3_02_GT.distinct_instances}`)
      }

      // Sanity: parish filter must also actually narrow the result vs unfiltered
      if (Number(kpis.total_checkins) < 205) {
        pass('T3-02f', `Filtered total_checkins (${kpis.total_checkins}) < unfiltered baseline (205)`)
      } else {
        fail('T3-02f', `Expected filtered count < unfiltered baseline (205)`, `got ${kpis.total_checkins}`)
      }

      await ctx.close()
    }

  } finally {
    await browser.close()
  }

  console.log('\n' + '─'.repeat(60))
  console.log(`Results: ${results.filter(r => r.passed).length}/${results.length} passed`)
  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.desc}`)
  }

  if (!allPassed) {
    console.error('\nSome tests failed.')
    process.exit(1)
  } else {
    console.log('\nAll tests passed.')
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
