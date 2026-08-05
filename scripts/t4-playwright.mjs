/**
 * Sprint 5 T4 — Playwright E2E for the /admin hub + AppNavLinks "Admin" entry.
 *
 * Covers: desktop topbar → hub → each of 4 cards, exactly-once topbar render,
 * mobile bottom-tab → hub → a card + grid-cols-1 collapse, non-admin block.
 *
 * Run: node scripts/t4-playwright.mjs
 *
 * Prerequisites:
 *   1. Production URL: https://project37-attendance.vercel.app
 *   2. .env.local with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY
 *   3. Test organizer: organizer@example.com in app_users (used for the
 *      non-admin-block assertion — no data is created/mutated by this script)
 *
 * Session pattern (from T6/T7): mint a real session via
 * admin.generateLink + anon.verifyOtp, inject as the sb-*-auth-token cookie.
 * Avoids the magic-link email round trip entirely — headless-safe.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const __dir   = dirname(fileURLToPath(import.meta.url))
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
const PROD_URL         = process.env.BASE_URL ?? 'https://project37-attendance.vercel.app'
const PROJECT_REF      = 'bftifxgdcmisasgvobuf'
const COOKIE_NAME      = `sb-${PROJECT_REF}-auth-token`

const ADMIN_EMAIL     = 'admin@example.com'
const ORGANIZER_EMAIL = 'organizer@example.com'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonSupabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let passed = 0
let failed = 0

function pass(id, msg) {
  console.log(`  ✅ ${id}: ${msg}`)
  passed++
}

function fail(id, msg, err) {
  console.error(`  ❌ ${id}: ${msg}`)
  if (err) console.error('    ', err.message ?? err)
  failed++
}

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
    domain: new URL(PROD_URL).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
}

async function main() {
  console.log('\n=== Sprint 5 T4 — Admin hub Playwright E2E ===\n')

  const browser = await chromium.launch({ headless: true })
  const adminSession = await getSessionFor(ADMIN_EMAIL)
  const organizerSession = await getSessionFor(ORGANIZER_EMAIL)

  // ── Desktop: topbar "Admin" → hub → each of 4 cards ──────────────────────
  console.log('── Desktop pass ──')
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await injectSession(ctx, adminSession)
    const page = await ctx.newPage()

    try {
      await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle' })
      const topbarNav = page.locator('nav[aria-label="Main navigation"]')
      const adminLink = topbarNav.getByText('Admin', { exact: true })
      await adminLink.waitFor({ state: 'visible', timeout: 10_000 })

      const topbarLinkCount = await topbarNav.locator('a').count()
      if (topbarLinkCount === 4) {
        pass('E2E-T4-01', 'Topbar shows exactly 4 links (Home, Check In, Analytics, Admin) for admin')
      } else {
        fail('E2E-T4-01', `Expected 4 topbar links, found ${topbarLinkCount}`)
      }

      const analyticsLink = topbarNav.getByText('Analytics', { exact: true })
      const analyticsVisible = await analyticsLink.isVisible().catch(() => false)
      if (analyticsVisible) {
        pass('E2E-T4-01b', 'Topbar Analytics entry present alongside Admin')
      } else {
        fail('E2E-T4-01b', 'Topbar Analytics entry missing')
      }

      await adminLink.click()
      await page.waitForURL(`${PROD_URL}/admin`, { timeout: 10_000 })
      pass('E2E-T4-02', 'Clicking topbar "Admin" navigates to /admin')
    } catch (err) {
      fail('E2E-T4-01/02', 'Topbar Admin link / navigation failed', err)
    }

    try {
      const headerCount = await page.locator('header').count()
      if (headerCount === 1) {
        pass('E2E-T4-03', 'Topbar renders exactly once on the hub (no double-layout)')
      } else {
        fail('E2E-T4-03', `Expected 1 <header>, found ${headerCount}`)
      }
    } catch (err) {
      fail('E2E-T4-03', 'Header count check failed', err)
    }

    const cards = [
      { name: 'People',    path: '/admin/people' },
      { name: 'Events',    path: '/admin/events' },
      { name: 'Analytics', path: '/admin/analytics' },
      { name: 'Import',    path: '/admin/import' },
    ]

    for (const card of cards) {
      try {
        await page.goto(`${PROD_URL}/admin`, { waitUntil: 'networkidle' })
        const link = page.locator(`[data-testid="admin-hub-grid"] a[href="${card.path}"]`)
        await link.waitFor({ state: 'visible', timeout: 10_000 })
        await link.click()
        await page.waitForURL(`${PROD_URL}${card.path}`, { timeout: 10_000 })
        pass(`E2E-T4-card-${card.name}`, `Hub card resolves to ${card.path}`)
      } catch (err) {
        fail(`E2E-T4-card-${card.name}`, `Card for ${card.path} failed to resolve`, err)
      }
    }

    await ctx.close()
  }

  // ── Non-admin: organizer hitting /admin directly is blocked ─────────────
  console.log('\n── Non-admin block ──')
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    await injectSession(ctx, organizerSession)
    const page = await ctx.newPage()

    try {
      await page.goto(`${PROD_URL}/admin`, { waitUntil: 'networkidle' })
      const grid = page.locator('[data-testid="admin-hub-grid"]')
      const gridVisible = await grid.count() > 0
      if (!gridVisible) {
        pass('E2E-T4-04', 'Organizer hitting /admin does not see the hub cards')
      } else {
        fail('E2E-T4-04', 'Organizer saw the admin hub cards — guard failed')
      }

      await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle' })
      const topbarNav = page.locator('nav[aria-label="Main navigation"]')
      const adminLinkCount = await topbarNav.getByText('Admin', { exact: true }).count()
      const analyticsLinkCount = await topbarNav.getByText('Analytics', { exact: true }).count()
      if (adminLinkCount === 0 && analyticsLinkCount === 0) {
        pass('E2E-T4-05', 'Organizer topbar has no "Admin" or "Analytics" entry')
      } else {
        fail('E2E-T4-05', `Organizer topbar unexpectedly shows admin=${adminLinkCount} analytics=${analyticsLinkCount}`)
      }
    } catch (err) {
      fail('E2E-T4-04/05', 'Non-admin block check failed', err)
    }

    await ctx.close()
  }

  // ── Mobile: bottom-tab "Admin" → hub → a card + grid-cols-1 ─────────────
  console.log('\n── Mobile pass (380px) ──')
  {
    const ctx = await browser.newContext({ viewport: { width: 380, height: 844 } })
    await injectSession(ctx, adminSession)
    const page = await ctx.newPage()

    try {
      await page.goto(`${PROD_URL}/dashboard`, { waitUntil: 'networkidle' })
      const bottomNav = page.locator('nav[aria-label="Bottom navigation"]')
      const adminTab = bottomNav.getByText('Admin', { exact: true })
      await adminTab.waitFor({ state: 'visible', timeout: 10_000 })

      const bottomLinkCount = await bottomNav.locator('a').count()
      if (bottomLinkCount === 4) {
        pass('E2E-T4-06', 'Bottom-tab bar shows exactly 4 tabs for admin at 380px')
      } else {
        fail('E2E-T4-06', `Expected 4 bottom-tab links, found ${bottomLinkCount}`)
      }

      await adminTab.click()
      await page.waitForURL(`${PROD_URL}/admin`, { timeout: 10_000 })
      pass('E2E-T4-07', 'Tapping bottom-tab "Admin" navigates to /admin')
    } catch (err) {
      fail('E2E-T4-06/07', 'Bottom-tab Admin link / navigation failed', err)
    }

    try {
      const grid = page.locator('[data-testid="admin-hub-grid"]')
      await grid.waitFor({ state: 'visible', timeout: 10_000 })
      const columns = await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns)
      const columnCount = columns.trim().split(/\s+/).length
      if (columnCount === 1) {
        pass('E2E-T4-08', `Hub grid collapses to 1 column at 380px (computed: "${columns}")`)
      } else {
        fail('E2E-T4-08', `Expected 1 grid column at 380px, computed "${columns}" (${columnCount} columns)`)
      }
    } catch (err) {
      fail('E2E-T4-08', 'Grid column-count check failed', err)
    }

    try {
      const peopleCard = page.locator('[data-testid="admin-hub-grid"] a[href="/admin/people"]')
      await peopleCard.waitFor({ state: 'visible', timeout: 10_000 })
      await peopleCard.click()
      await page.waitForURL(`${PROD_URL}/admin/people`, { timeout: 10_000 })
      pass('E2E-T4-09', 'Tapping a hub card at 380px resolves to /admin/people')
    } catch (err) {
      fail('E2E-T4-09', 'Mobile card tap failed', err)
    }

    await ctx.close()
  }

  await browser.close()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
