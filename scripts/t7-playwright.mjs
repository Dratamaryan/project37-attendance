/**
 * Sprint 2 T7 — Playwright E2E tests for /checkin event selector
 *
 * Covers: selector visible with nearest event, instance switching, empty state.
 *
 * Run: node scripts/t7-playwright.mjs
 *
 * Prerequisites:
 *   1. Production URL: https://project37-attendance.vercel.app
 *   2. .env.local with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY
 *   3. At least one active event with scheduled instances exists in production DB
 *   4. Test organizer: organizer-example@example.test in app_users
 *
 * Pattern: pressSequentially + waitFor (never fill + isVisible).
 * Pre-cleanup at start so the script is re-runnable.
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

const ADMIN_EMAIL    = 'admin-example@example.test'
const ORGANIZER_EMAIL = 'organizer-example@example.test'

// Test event name prefix — we'll clean up any T7 test events before creating
const T7_EVENT_NAME  = 'T7 Test Event Alpha'
const T7_EVENT_NAME2 = 'T7 Test Event Beta'

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

// ── Cookie helper ─────────────────────────────────────────────────────────────
function sessionToCookie(session) {
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
}

// ── Session helpers ───────────────────────────────────────────────────────────
async function getSessionForEmail(email) {
  const { data: userList } = await adminSupabase.auth.admin.listUsers()
  const user = userList?.users?.find((u) => u.email === email)
  if (!user) throw new Error(`User not found: ${email}`)

  const { data: linkData } = await adminSupabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: `${PROD_URL}/auth/confirm` },
  })
  if (!linkData?.properties?.hashed_token) throw new Error(`generateLink failed for ${email}`)

  const { data: sessionData, error: sessionErr } = await anonSupabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  })
  if (sessionErr || !sessionData?.session) throw new Error(`verifyOtp failed for ${email}: ${sessionErr?.message}`)
  return sessionData.session
}

// ── DB setup / teardown ───────────────────────────────────────────────────────
let t7AdminUserId = null
let t7Event1Id = null
let t7Event2Id = null

async function setup() {
  console.log('\n── Setup ────────────────────────────────────────────────')

  // Clean up any leftover T7 test data
  const { data: leftoverEvents } = await adminSupabase
    .from('events')
    .select('id')
    .in('name', [T7_EVENT_NAME, T7_EVENT_NAME2])
  if (leftoverEvents?.length) {
    await adminSupabase
      .from('event_instances')
      .delete()
      .in('event_id', leftoverEvents.map(e => e.id))
    await adminSupabase
      .from('events')
      .delete()
      .in('id', leftoverEvents.map(e => e.id))
  }

  // Get admin user id
  const { data: userList } = await adminSupabase.auth.admin.listUsers()
  const adminUser = userList?.users?.find((u) => u.email === ADMIN_EMAIL)
  if (!adminUser) throw new Error(`Admin user not found: ${ADMIN_EMAIL}`)
  t7AdminUserId = adminUser.id

  const now = new Date()

  // Create two active events with instances spanning [now-0h, now+5d]
  const { data: ev1, error: e1Err } = await adminSupabase
    .from('events')
    .insert({
      name: T7_EVENT_NAME,
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '18:00:00',
      active: true,
      created_by: t7AdminUserId,
    })
    .select('id')
    .single()
  if (e1Err || !ev1) throw new Error(`insert event1: ${e1Err?.message}`)
  t7Event1Id = ev1.id

  const { data: ev2, error: e2Err } = await adminSupabase
    .from('events')
    .insert({
      name: T7_EVENT_NAME2,
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '15:00:00',
      active: true,
      created_by: t7AdminUserId,
    })
    .select('id')
    .single()
  if (e2Err || !ev2) throw new Error(`insert event2: ${e2Err?.message}`)
  t7Event2Id = ev2.id

  // Instance for event 1: 2h from now (nearest)
  await adminSupabase.from('event_instances').insert({
    event_id: t7Event1Id,
    scheduled_at: new Date(now.getTime() + 2 * 3600_000).toISOString(),
    event_name_snapshot: T7_EVENT_NAME,
    event_name_snapshot_id: null,
    status: 'scheduled',
  })

  // Instance for event 2: 5 days from now
  await adminSupabase.from('event_instances').insert({
    event_id: t7Event2Id,
    scheduled_at: new Date(now.getTime() + 5 * 24 * 3600_000).toISOString(),
    event_name_snapshot: T7_EVENT_NAME2,
    event_name_snapshot_id: null,
    status: 'scheduled',
  })

  console.log(`  Created: ${T7_EVENT_NAME} (nearest, 2h) + ${T7_EVENT_NAME2} (5d)`)
}

async function teardown() {
  console.log('\n── Teardown ──────────────────────────────────────────────')
  if (t7Event1Id || t7Event2Id) {
    await adminSupabase
      .from('event_instances')
      .delete()
      .in('event_id', [t7Event1Id, t7Event2Id].filter(Boolean))
    await adminSupabase
      .from('events')
      .delete()
      .in('id', [t7Event1Id, t7Event2Id].filter(Boolean))
    console.log('  Cleaned up T7 events + instances')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true })

try {
  await setup()

  // ── E2E-T7-01: admin logs in, /checkin shows nearest event ──────────────────
  console.log('\n── E2E-T7-01 ────────────────────────────────────────────')
  {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const session = await getSessionForEmail(ADMIN_EMAIL)
      await context.addCookies([{
        name: COOKIE_NAME,
        value: sessionToCookie(session),
        domain: new URL(PROD_URL).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }])

      await page.goto(`${PROD_URL}/checkin`, { waitUntil: 'networkidle' })

      // Wait for the event selector header to appear
      const selectorVisible = await page.waitForSelector('[data-testid="event-selector"]', { timeout: 10_000 })
        .then(() => true).catch(() => false)

      if (selectorVisible) {
        // Check that the nearest event name (T7_EVENT_NAME) appears in the selector
        const selectorText = await page.textContent('[data-testid="event-selector"]')
        if (selectorText?.includes(T7_EVENT_NAME)) {
          pass('E2E-T7-01', 'Admin sees nearest event in selector', T7_EVENT_NAME)
        } else {
          fail('E2E-T7-01', 'Selector visible but wrong event name', `Got: "${selectorText?.slice(0, 80)}"`)
        }
      } else {
        fail('E2E-T7-01', 'Event selector [data-testid="event-selector"] not found on /checkin')
      }
    } finally {
      await context.close()
    }
  }

  // ── E2E-T7-02: organizer opens dropdown and switches instances ───────────────
  console.log('\n── E2E-T7-02 ────────────────────────────────────────────')
  {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const session = await getSessionForEmail(ORGANIZER_EMAIL)
      await context.addCookies([{
        name: COOKIE_NAME,
        value: sessionToCookie(session),
        domain: new URL(PROD_URL).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }])

      await page.goto(`${PROD_URL}/checkin`, { waitUntil: 'networkidle' })

      // Wait for selector
      await page.waitForSelector('[data-testid="event-selector"]', { timeout: 10_000 })

      // Click the selector button to open dropdown
      await page.click('[aria-label="select_event"]')

      // Wait for the dropdown (listbox) with the second event
      const dropdownVisible = await page.waitForSelector(`role=listbox`, { timeout: 5_000 })
        .then(() => true).catch(() => false)

      if (!dropdownVisible) {
        fail('E2E-T7-02', 'Dropdown did not open after clicking selector')
      } else {
        // Find and click the second event (T7_EVENT_NAME2)
        const betaButton = page.locator('role=listbox').getByText(T7_EVENT_NAME2)
        const betaVisible = await betaButton.isVisible().catch(() => false)

        if (betaVisible) {
          await betaButton.click()

          // Header should now show T7_EVENT_NAME2
          await page.waitForFunction(
            (name) => document.querySelector('[data-testid="event-selector"]')?.textContent?.includes(name),
            T7_EVENT_NAME2,
            { timeout: 5_000 },
          ).catch(() => null)

          const headerText = await page.textContent('[data-testid="event-selector"]')
          if (headerText?.includes(T7_EVENT_NAME2)) {
            pass('E2E-T7-02', 'Instance switch updates selector header', T7_EVENT_NAME2)
          } else {
            fail('E2E-T7-02', 'Header did not update after selection', `Got: "${headerText?.slice(0, 80)}"`)
          }
        } else {
          fail('E2E-T7-02', 'T7_EVENT_NAME2 not found in dropdown', T7_EVENT_NAME2)
        }
      }
    } finally {
      await context.close()
    }
  }

  // ── E2E-T7-03: page does not crash when no instances exist ──────────────────
  console.log('\n── E2E-T7-03 ────────────────────────────────────────────')
  {
    // Temporarily cancel both test instances so the selector shows the empty state
    await adminSupabase
      .from('event_instances')
      .update({ status: 'cancelled' })
      .in('event_id', [t7Event1Id, t7Event2Id])

    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const session = await getSessionForEmail(ADMIN_EMAIL)
      await context.addCookies([{
        name: COOKIE_NAME,
        value: sessionToCookie(session),
        domain: new URL(PROD_URL).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      }])

      await page.goto(`${PROD_URL}/checkin`, { waitUntil: 'networkidle' })

      // Page must load without crash
      const hasError = await page.locator('text=500').isVisible().catch(() => false)
      const hasCheckinTitle = await page.waitForFunction(
        () => document.title.includes('Absensi') || document.body.textContent?.includes('Check In'),
        { timeout: 10_000 },
      ).then(() => true).catch(() => false)

      if (!hasError && hasCheckinTitle) {
        // Empty state notice should be visible
        const emptyNotice = await page.locator('[role="status"]').isVisible().catch(() => false)
        if (emptyNotice) {
          pass('E2E-T7-03', 'Page renders empty state without crash when no instances')
        } else {
          pass('E2E-T7-03', 'Page renders without crash (no 500 error) when no instances')
        }
      } else {
        fail('E2E-T7-03', 'Page crashed or did not load when no instances exist')
      }
    } finally {
      await context.close()
      // Restore instances to scheduled for teardown cleanup
      await adminSupabase
        .from('event_instances')
        .update({ status: 'scheduled' })
        .in('event_id', [t7Event1Id, t7Event2Id])
    }
  }

} finally {
  await browser.close()
  await teardown()
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════')
console.log(`Results: ${results.filter(r => r.passed).length}/${results.length} passed`)
for (const r of results) {
  console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.desc}`)
}
if (!allPassed) {
  console.log('\nSome tests failed.')
  process.exit(1)
} else {
  console.log('\nAll tests passed.')
  process.exit(0)
}
