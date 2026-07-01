/**
 * Sprint 3 T5 — Playwright spec for /admin/analytics dashboard
 *
 * Tests: auth guard, topbar/nav smoke, analytics nav link visibility,
 *        non-admin role guard, KPI cards, date filter → URL update,
 *        event-type filter → URL update, back-button restores state,
 *        empty state on future date range.
 *
 * Run: node scripts/t5-playwright.mjs
 *
 * Prerequisites:
 *   1. .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   2. npm install playwright  (or npx playwright install chromium)
 *   3. Production must have demo data seeded (run seed:demo once)
 *
 * Note: Parish dropdown lists only parishes present in analytics data — this is
 *       by design for T5 (no additional T4 function added for T5).
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
const TEMP_ORG_EMAIL   = 't5-temp-organizer@test.internal'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

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

// ── Session helpers ───────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== T5 Playwright Spec — /admin/analytics Dashboard ===`)
  console.log(`Production: ${PROD_URL}\n`)

  // ── Setup: create temp organizer user ─────────────────────────────────────
  console.log('Setup: creating temp organizer user...')
  let tempOrgUserId = null
  try {
    // Clean up any leftover from a prior run first
    const { data: existing } = await adminSupabase.auth.admin.listUsers()
    const prior = existing?.users?.find(u => u.email === TEMP_ORG_EMAIL)
    if (prior) {
      await adminSupabase.from('app_users').delete().eq('id', prior.id)
      await adminSupabase.auth.admin.deleteUser(prior.id)
    }

    const { data: orgUser, error: createErr } = await adminSupabase.auth.admin.createUser({
      email: TEMP_ORG_EMAIL,
      email_confirm: true,
    })
    if (createErr) throw createErr
    tempOrgUserId = orgUser.user.id

    await adminSupabase.from('app_users').insert({
      id: tempOrgUserId,
      email: TEMP_ORG_EMAIL,
      role: 'organizer',
    })
    console.log(`  Temp organizer created: ${tempOrgUserId}\n`)
  } catch (err) {
    console.warn(`  Warning: could not create temp organizer — guard test will be skipped: ${err.message}\n`)
  }

  // ── Admin session ─────────────────────────────────────────────────────────
  console.log('Getting admin session...')
  const adminSession = await getSessionForEmail('admin-example@example.test')
  console.log(`  Admin session obtained (${adminSession.user?.email})\n`)

  // ── Organizer session (if user was created) ───────────────────────────────
  let orgSession = null
  if (tempOrgUserId) {
    try {
      orgSession = await getSessionForEmail(TEMP_ORG_EMAIL)
      console.log('  Organizer session obtained\n')
    } catch (err) {
      console.warn(`  Warning: could not get organizer session: ${err.message}\n`)
    }
  }

  const browser = await chromium.launch({ headless: true })

  try {
    // ── T5-A1: Unauthenticated → redirect to /login ────────────────────────
    console.log('T5-A1: Auth guard — unauthenticated redirect')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)
      const url = page.url()
      if (url.includes('/login')) {
        pass('T5-A1', 'Unauthenticated GET /admin/analytics → redirected to /login', url)
      } else {
        fail('T5-A1', 'Expected redirect to /login', `actual: ${url}`)
      }
      await ctx.close()
    }

    // ── T5-A2: Topbar + bottom nav render ─────────────────────────────────
    console.log('\nT5-A2: Layout — topbar + bottom nav smoke test')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const topbar = await page.$('header')
      if (topbar) {
        pass('T5-A2a', 'Topbar <header> present in DOM')
      } else {
        fail('T5-A2a', 'Topbar <header> not found in DOM')
      }

      const bottomNav = await page.$('nav[aria-label="Bottom navigation"]')
      if (bottomNav) {
        pass('T5-A2b', 'Bottom nav (aria-label="Bottom navigation") present in DOM')
      } else {
        fail('T5-A2b', 'Bottom nav not found in DOM')
      }

      const h1Text = await page.textContent('h1')
      if (h1Text && (h1Text.includes('Analytics') || h1Text.includes('Analitik'))) {
        pass('T5-A2c', `Page title rendered: "${h1Text.trim()}"`)
      } else {
        fail('T5-A2c', `Expected Analytics title, got: "${h1Text}"`)
      }
      await ctx.close()
    }

    // ── T5-A3: Analytics nav link visible for admin, absent for organizer ──
    console.log('\nT5-A3: Nav link visibility — admin sees /admin/analytics, organizer does not')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const analyticsLink = await page.$('a[href="/admin/analytics"]')
      if (analyticsLink) {
        pass('T5-A3a', 'Admin: /admin/analytics nav link present')
      } else {
        fail('T5-A3a', 'Admin: /admin/analytics nav link NOT found')
      }
      await ctx.close()
    }

    if (orgSession) {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, orgSession)
      await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const analyticsLink = await page.$('a[href="/admin/analytics"]')
      if (!analyticsLink) {
        pass('T5-A3b', 'Organizer: /admin/analytics nav link NOT present (correct)')
      } else {
        fail('T5-A3b', 'Organizer should NOT see /admin/analytics nav link')
      }
      await ctx.close()
    } else {
      console.log('  (T5-A3b skipped — no organizer session)')
    }

    // ── T5-A4: Role guard — organizer GET /admin/analytics → /dashboard ────
    console.log('\nT5-A4: Role guard — organizer redirected from /admin/analytics')
    if (orgSession) {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, orgSession)
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)
      const url = page.url()
      if (url.includes('/dashboard')) {
        pass('T5-A4', 'Organizer GET /admin/analytics → redirected to /dashboard', url)
      } else {
        fail('T5-A4', `Expected redirect to /dashboard, got: ${url}`)
      }
      await ctx.close()
    } else {
      console.log('  (T5-A4 skipped — no organizer session)')
    }

    // ── T5-A5: KPI cards show numeric values ──────────────────────────────
    console.log('\nT5-A5: KPI cards — numeric values visible')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      const kpiEl = page.locator('[data-testid="kpi-total-checkins"]')
      try {
        await kpiEl.waitFor({ state: 'attached', timeout: 8000 })
        const val = (await kpiEl.textContent())?.trim()
        if (val && val !== '—' && /^\d+$/.test(val)) {
          pass('T5-A5', `KPI total-checkins value: ${val}`)
        } else {
          fail('T5-A5', `KPI value unexpected: "${val}"`)
        }
      } catch {
        fail('T5-A5', '[data-testid="kpi-total-checkins"] not found')
      }
      await ctx.close()
    }

    // ── T5-A6: Date filter → URL update + KPI changes ─────────────────────
    console.log('\nT5-A6: Date filter → URL searchParams update')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      // Read baseline KPI (unfiltered; includes all demo + any manual-test data)
      const baseVal = await page.locator('[data-testid="kpi-total-checkins"]').textContent()

      // Step 1 — set 'from' and wait for URL + RSC to fully settle before
      // touching 'to'.  Rapid double-fill races the RSC re-render: the second
      // fill's update() would read stale currentFilters={} and write only
      // ?to=… to the URL, dropping the from= param.
      await page.fill('[data-testid="filter-from"]', '2026-04-01')
      await page.waitForFunction(
        () => window.location.search.includes('from='),
        { timeout: 8000 }
      ).catch(() => {})
      await page.waitForTimeout(2000)  // let RSC re-render deliver currentFilters={from}

      // Step 2 — 'to' fill now merges into currentFilters that already has from=
      await page.fill('[data-testid="filter-to"]', '2026-06-30')
      await page.waitForFunction(
        () => window.location.search.includes('to=') && window.location.search.includes('from='),
        { timeout: 8000 }
      ).catch(() => {})
      await page.waitForTimeout(SETTLE)

      const urlAfter = page.url()
      if (urlAfter.includes('from=2026-04-01')) {
        pass('T5-A6a', `URL contains from= param: ${urlAfter.split('?')[1]}`)
      } else {
        fail('T5-A6a', `URL missing from= param: ${urlAfter}`)
      }
      if (urlAfter.includes('to=2026-06-30')) {
        pass('T5-A6b', 'URL contains to= param')
      } else {
        fail('T5-A6b', `URL missing to= param: ${urlAfter}`)
      }

      // Strengthen A6c: assert the KPI actually dropped, not just re-rendered.
      // Q2-2026 (3 months) is a subset of the 12-month demo window, so the
      // filtered total must be strictly less than the unfiltered baseline.
      await page.waitForTimeout(SETTLE)
      const filteredVal = await page.locator('[data-testid="kpi-total-checkins"]').textContent()
      const filteredNum = parseInt(filteredVal?.trim() ?? '999', 10)
      const baseNum     = parseInt(baseVal?.trim()     ?? '0',   10)
      if (!isNaN(filteredNum) && filteredNum < baseNum) {
        pass('T5-A6c', `KPI dropped after date filter: ${filteredNum} < ${baseNum} (from=2026-04-01&to=2026-06-30)`)
      } else {
        fail('T5-A6c', `Expected KPI < ${baseNum} after date filter, got: "${filteredVal?.trim()}"`)
      }

      await ctx.close()
    }

    // ── T5-A7: Event type filter → URL update ─────────────────────────────
    console.log('\nT5-A7: Event type filter → URL update')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      await page.selectOption('[data-testid="filter-event-type"]', 'friday_monthly')
      await page.waitForFunction(
        () => window.location.search.includes('eventType='),
        { timeout: 8000 }
      ).catch(() => {})
      await page.waitForTimeout(SETTLE)

      const url = page.url()
      if (url.includes('eventType=friday_monthly')) {
        pass('T5-A7', `URL contains eventType=friday_monthly: ${url.split('?')[1]}`)
      } else {
        fail('T5-A7', `URL missing eventType param: ${url}`)
      }
      await ctx.close()
    }

    // ── T5-A8: Back button restores prior filter state ────────────────────
    console.log('\nT5-A8: Back button restores prior filter state')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)

      // Start unfiltered
      await page.goto(`${PROD_URL}/admin/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE)

      // Apply a filter
      await page.selectOption('[data-testid="filter-event-type"]', 'sunday_monthly')
      await page.waitForFunction(
        () => window.location.search.includes('eventType='),
        { timeout: 8000 }
      ).catch(() => {})
      await page.waitForTimeout(SETTLE)
      const urlFiltered = page.url()

      // Go back
      await page.goBack()
      await page.waitForTimeout(SETTLE)
      const urlAfterBack = page.url()

      const restored = !urlAfterBack.includes('eventType=')
      if (restored) {
        pass('T5-A8', `Back button restored state (no eventType param): ${urlAfterBack.split('?')[1] ?? 'no params'}`)
      } else {
        fail('T5-A8', `Back button did not restore: filtered=${urlFiltered} back=${urlAfterBack}`)
      }
      await ctx.close()
    }

    // ── T5-A9: Future date range → empty state shown ──────────────────────
    console.log('\nT5-A9: Future date range → empty state message')
    {
      const ctx  = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await ctx.newPage()
      await injectSession(ctx, adminSession)
      const futureUrl = `${PROD_URL}/admin/analytics?from=2099-01-01&to=2099-12-31`
      await page.goto(futureUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
      await page.waitForTimeout(SETTLE + 1000)  // extra wait for dynamic charts to mount

      const kpiEl = await page.locator('[data-testid="kpi-total-checkins"]').textContent()
      const kpiIsZeroOrDash = kpiEl?.trim() === '0' || kpiEl?.trim() === '—'
      if (kpiIsZeroOrDash) {
        pass('T5-A9a', `KPI shows zero/dash for future range: "${kpiEl?.trim()}"`)
      } else {
        fail('T5-A9a', `Expected 0 or — for future range, got: "${kpiEl?.trim()}"`)
      }

      // Chart empty states: at least one "No data" message should appear
      // (charts only mount client-side; give them extra time)
      await page.waitForTimeout(2000)
      const emptyEls = await page.locator('[data-testid="analytics-empty"]').count()
      if (emptyEls > 0) {
        pass('T5-A9b', `${emptyEls} empty-state message(s) rendered for future date range`)
      } else {
        fail('T5-A9b', 'No [data-testid="analytics-empty"] elements found for future range')
      }
      await ctx.close()
    }

  } finally {
    await browser.close()

    // ── Cleanup: remove temp organizer ────────────────────────────────────
    if (tempOrgUserId) {
      try {
        await adminSupabase.from('app_users').delete().eq('id', tempOrgUserId)
        await adminSupabase.auth.admin.deleteUser(tempOrgUserId)
        console.log('\nCleanup: temp organizer removed.')
      } catch (err) {
        console.warn(`\nCleanup warning: ${err.message}`)
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
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
