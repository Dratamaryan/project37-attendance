/**
 * Sprint 2 T6 — Playwright E2E tests for /admin/events
 *
 * Covers: list page, create, edit, organizer access, not-found handling.
 *
 * Run: node scripts/t6-playwright.mjs
 *
 * Prerequisites:
 *   1. Production URL: https://project37-attendance.vercel.app
 *   2. .env.local with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY
 *   3. Two seeded events: "Project Day" and "Tribe Connect"
 *   4. Test organizer: organizer-example@example.test in app_users
 *
 * Pattern: pressSequentially + waitFor (never fill + isVisible).
 * Pre-cleanup at start so the script is re-runnable without DB cleanup.
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
const PROD_URL         = 'https://project37-attendance.vercel.app'
const PROJECT_REF      = 'bftifxgdcmisasgvobuf'
const COOKIE_NAME      = `sb-${PROJECT_REF}-auth-token`

const TEST_EVENT_NAME  = 'Test Adhoc 2026'
const ADMIN_EMAIL      = 'admin-example@example.test'
const ORGANIZER_EMAIL  = 'organizer-example@example.test'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonSupabase = createClient(SUPABASE_URL, ANON_KEY, {
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
  console.log(`  ✗ ${id}: ${desc}${detail ? ' — ' + detail : ''}`)
  allPassed = false
}

// ── Cookie helper — matches @supabase/ssr base64 encoding ────────────────────
function sessionToCookie(session) {
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
}

// ── Session helpers ───────────────────────────────────────────────────────────
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

// ── Pre-cleanup ───────────────────────────────────────────────────────────────
async function cleanup() {
  await adminSupabase.from('events').delete().ilike('name', `%${TEST_EVENT_NAME}%`)
  console.log('  pre-cleanup: removed stale test events')
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Sprint 2 T6 — Playwright E2E ===\n')

  await cleanup()

  const browser = await chromium.launch({ headless: true })
  const adminCtx = await browser.newContext()
  const adminSession = await getSessionFor(ADMIN_EMAIL)
  await injectSession(adminCtx, adminSession)
  const page = await adminCtx.newPage()

  // ── E2E-T6-01: List page loads with seeded events ─────────────────────────
  console.log('\nE2E-T6-01: List page loads')
  try {
    await page.goto(`${PROD_URL}/admin/events`, { waitUntil: 'networkidle' })
    await page.waitForFunction(
      () => document.querySelector('table') !== null || document.body.innerText.includes('No events'),
      { timeout: 10_000 }
    )

    const hasProjectDay = await page.waitForFunction(
      () => document.body.innerText.includes('Project Day'),
      { timeout: 8_000 }
    ).then(() => true).catch(() => false)

    const hasTribeConnect = await page.waitForFunction(
      () => document.body.innerText.includes('Tribe Connect'),
      { timeout: 8_000 }
    ).then(() => true).catch(() => false)

    if (hasProjectDay && hasTribeConnect) {
      pass('E2E-T6-01', 'List page loads with both seeded events')
    } else {
      fail('E2E-T6-01', 'Seeded events not visible', `projectDay=${hasProjectDay} tribeConnect=${hasTribeConnect}`)
    }
  } catch (e) {
    fail('E2E-T6-01', 'List page error', String(e))
  }

  // ── E2E-T6-02: Create adhoc event ─────────────────────────────────────────
  console.log('\nE2E-T6-02: Create adhoc event')
  try {
    await page.goto(`${PROD_URL}/admin/events/new`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelector('form') !== null, { timeout: 8_000 })

    // Event type
    await page.click('input[value="adhoc"]')

    // Name
    const nameInput = page.getByLabel(/event name.*en/i)
    await nameInput.click()
    await nameInput.pressSequentially(TEST_EVENT_NAME, { delay: 30 })

    // Start date: 30 days from today
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    await page.getByLabel(/start date/i).fill(futureDate.toISOString().slice(0, 10))
    await page.getByLabel(/start time/i).fill('19:00')
    await page.getByLabel(/duration/i).fill('90')

    await page.click('button[type="submit"]')
    await page.waitForURL(/\/admin\/events(\?|$)/, { timeout: 15_000 })
    await page.waitForFunction(
      () => document.body.innerText.includes('Test Adhoc 2026'),
      { timeout: 10_000 }
    )

    const url = page.url()
    if (url.includes('created=')) {
      pass('E2E-T6-02', 'Adhoc event created, redirected with created param')
    } else {
      fail('E2E-T6-02', 'Redirect URL missing created param', url)
    }
  } catch (e) {
    fail('E2E-T6-02', 'Create event error', String(e))
  }

  // ── E2E-T6-03: Edit newly-created event ───────────────────────────────────
  // D7: row link now goes to /[id] (detail page); Edit button on detail page links to /[id]/edit.
  console.log('\nE2E-T6-03: Edit created event (via detail page)')
  try {
    // Step 1: Click the "View" link for the test event row → detail page
    const testRow = page.locator('tr').filter({ hasText: TEST_EVENT_NAME })
    const viewLink = testRow.locator('a').first()
    await viewLink.waitFor({ state: 'visible', timeout: 8_000 })
    await viewLink.click()
    await page.waitForURL(/\/admin\/events\/[^/]+$/, { timeout: 10_000 })

    // Step 2: On detail page, click the "Edit event" button → edit form
    const editBtn = page.locator('a[href$="/edit"]').first()
    await editBtn.waitFor({ state: 'visible', timeout: 8_000 })
    await editBtn.click()
    await page.waitForURL(/\/edit$/, { timeout: 10_000 })
    await page.waitForFunction(() => document.querySelector('form') !== null, { timeout: 8_000 })

    // Rename
    const nameInput = page.getByLabel(/event name.*en/i)
    await nameInput.click()
    await nameInput.selectText()
    await nameInput.pressSequentially(`${TEST_EVENT_NAME} (renamed)`, { delay: 30 })

    await page.click('button[type="submit"]')
    await page.waitForURL(/\/admin\/events(\?|$)/, { timeout: 15_000 })

    const hasUpdated = await page.waitForFunction(
      () => document.body.innerText.includes('renamed'),
      { timeout: 10_000 }
    ).then(() => true).catch(() => false)

    if (hasUpdated) {
      pass('E2E-T6-03', 'Edit saved — renamed event visible in list')
    } else {
      fail('E2E-T6-03', 'Renamed event not visible after edit')
    }
  } catch (e) {
    fail('E2E-T6-03', 'Edit event error', String(e))
  }

  // ── E2E-T6-04: Organizer access — no cancel-instance affordance ───────────
  console.log('\nE2E-T6-04: Organizer access')
  try {
    const orgCtx = await browser.newContext()
    const orgSession = await getSessionFor(ORGANIZER_EMAIL)
    await injectSession(orgCtx, orgSession)
    const orgPage = await orgCtx.newPage()

    await orgPage.goto(`${PROD_URL}/admin/events`, { waitUntil: 'networkidle' })
    await orgPage.waitForFunction(
      () => !document.body.innerText.includes('Loading'),
      { timeout: 8_000 }
    )

    const redirected = orgPage.url().includes('/dashboard')
    if (redirected) {
      fail('E2E-T6-04', 'Organizer was redirected — should have access to /admin/events')
    } else {
      const hasCancelInstance = await orgPage.locator('[data-testid="cancel-instance"]').count() > 0
      if (!hasCancelInstance) {
        pass('E2E-T6-04', 'Organizer sees list; no cancel-instance affordance')
      } else {
        fail('E2E-T6-04', 'cancel-instance element visible for organizer — should not appear in T6')
      }
    }
    await orgCtx.close()
  } catch (e) {
    fail('E2E-T6-04', 'Organizer access error', String(e))
  }

  // ── E2E-T6-05: Cleanup — mark test event inactive ─────────────────────────
  console.log('\nE2E-T6-05: Cleanup')
  try {
    await adminSupabase
      .from('events')
      .update({ active: false })
      .ilike('name', `%${TEST_EVENT_NAME}%`)
    pass('E2E-T6-05', 'Test event marked inactive via DB')
  } catch (e) {
    fail('E2E-T6-05', 'Cleanup error', String(e))
  }

  // ── E2E-T6-06: Non-existent event id → redirects with error banner ─────────
  console.log('\nE2E-T6-06: Non-existent event id not-found handling')
  try {
    const bogusId = '00000000-0000-0000-0000-000000000000'
    await page.goto(`${PROD_URL}/admin/events/${bogusId}/edit`, { waitUntil: 'networkidle' })

    // Should redirect to /admin/events?event_not_found=1
    await page.waitForURL(/\/admin\/events/, { timeout: 8_000 })

    const url = page.url()
    const hasNotFoundParam = url.includes('event_not_found=1')
    const hasErrorBanner = await page.locator('[role="alert"]').count() > 0

    if (hasNotFoundParam && hasErrorBanner) {
      pass('E2E-T6-06', 'Non-existent event id redirects to list with error banner')
    } else {
      fail('E2E-T6-06', 'Not-found handling incorrect', `param=${hasNotFoundParam} banner=${hasErrorBanner} url=${url}`)
    }
  } catch (e) {
    fail('E2E-T6-06', 'Not-found test error', String(e))
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  await browser.close()

  console.log('\n=== Results ===')
  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.desc}`)
  }

  const passed = results.filter(r => r.passed).length
  console.log(`\n${passed}/${results.length} passed`)

  if (!allPassed) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
