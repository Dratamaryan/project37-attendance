/**
 * Sprint 2 T8 — Playwright E2E tests for /checkin attendance writes
 *
 * Covers: happy-path check-in, duplicate check-in banner, cancelled-instance
 * error, new-person create + check-in, and cleanup.
 *
 * Run: node scripts/t8-playwright.mjs
 *
 * Prerequisites:
 *   1. Production URL: https://project37-attendance.vercel.app
 *   2. .env.local with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *      SUPABASE_SERVICE_ROLE_KEY
 *   3. Admin user admin-example@example.test in app_users
 *
 * Pattern: pressSequentially + waitFor (never fill + isVisible for React inputs).
 * Pre-cleanup at start so the script is re-runnable.
 * Production locale is Indonesian — text selectors use ID strings.
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

const ADMIN_EMAIL = 'admin-example@example.test'

const T8_EVENT_NAME    = 'T8 Test Attendance Event'
const T8_PERSON_NAME   = 'T8 Test Person'
const T8_PERSON_PHONE  = '+628888001081'          // existing-person path
const T8_NEW_NAME      = 'T8 Test New Person'
const T8_NEW_PHONE     = '+628888001082'          // new-person path
const LOOKUP_TIMEOUT   = 15_000

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

// ── Cookie / session helpers ─────────────────────────────────────────────────
function sessionToCookie(session) {
  return 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
}

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

async function loginContext(browser, email) {
  const context = await browser.newContext()
  const session = await getSessionForEmail(email)
  await context.addCookies([{
    name: COOKIE_NAME,
    value: sessionToCookie(session),
    domain: new URL(PROD_URL).hostname,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
  return context
}

// React controlled inputs need char-by-char input (Sprint 1 locked pattern)
async function typePhone(page, phone) {
  const input = page.locator('input[type="tel"]')
  await input.click()
  await input.selectText().catch(() => null)
  await input.pressSequentially(phone, { delay: 30 })
}

// ── DB setup / teardown ───────────────────────────────────────────────────────
let t8AdminUserId = null
let t8EventId = null
let t8InstanceId = null
let t8PersonId = null

async function cleanupTestData() {
  // Attendance for any leftover T8 instances
  const { data: leftoverEvents } = await adminSupabase
    .from('events')
    .select('id')
    .eq('name', T8_EVENT_NAME)
  if (leftoverEvents?.length) {
    const eventIds = leftoverEvents.map((e) => e.id)
    const { data: insts } = await adminSupabase
      .from('event_instances')
      .select('id')
      .in('event_id', eventIds)
    if (insts?.length) {
      await adminSupabase.from('attendance').delete().in('event_instance_id', insts.map((i) => i.id))
    }
    await adminSupabase.from('event_instances').delete().in('event_id', eventIds)
    await adminSupabase.from('events').delete().in('id', eventIds)
  }

  // T8 test people (and any attendance rows pointing at them)
  const { data: leftoverPeople } = await adminSupabase
    .from('people')
    .select('id')
    .in('phone_e164', [T8_PERSON_PHONE, T8_NEW_PHONE])
  if (leftoverPeople?.length) {
    const personIds = leftoverPeople.map((p) => p.id)
    await adminSupabase.from('attendance').delete().in('person_id', personIds)
    await adminSupabase.from('people').delete().in('id', personIds)
  }
}

async function setup() {
  console.log('\n── Setup ────────────────────────────────────────────────')
  await cleanupTestData()

  const { data: userList } = await adminSupabase.auth.admin.listUsers()
  const adminUser = userList?.users?.find((u) => u.email === ADMIN_EMAIL)
  if (!adminUser) throw new Error(`Admin user not found: ${ADMIN_EMAIL}`)
  t8AdminUserId = adminUser.id

  // Active event with one instance 2h from now → it is the nearest, so the
  // EventSelector defaults to it on page load.
  const { data: ev, error: evErr } = await adminSupabase
    .from('events')
    .insert({
      name: T8_EVENT_NAME,
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '18:00:00',
      active: true,
      created_by: t8AdminUserId,
    })
    .select('id')
    .single()
  if (evErr || !ev) throw new Error(`insert event: ${evErr?.message}`)
  t8EventId = ev.id

  const { data: inst, error: instErr } = await adminSupabase
    .from('event_instances')
    .insert({
      event_id: t8EventId,
      scheduled_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
      event_name_snapshot: T8_EVENT_NAME,
      event_name_snapshot_id: null,
      status: 'scheduled',
    })
    .select('id')
    .single()
  if (instErr || !inst) throw new Error(`insert instance: ${instErr?.message}`)
  t8InstanceId = inst.id

  // Existing person for the happy path
  const { data: person, error: pErr } = await adminSupabase
    .from('people')
    .insert({
      phone_e164: T8_PERSON_PHONE,
      full_name: T8_PERSON_NAME,
      nickname: 'T8Test',
    })
    .select('id')
    .single()
  if (pErr || !person) throw new Error(`insert person: ${pErr?.message}`)
  t8PersonId = person.id

  console.log(`  Created: ${T8_EVENT_NAME} (instance +2h) + ${T8_PERSON_NAME} (${T8_PERSON_PHONE})`)
}

async function teardown() {
  console.log('\n── Teardown (E2E-T8-05) ──────────────────────────────────')
  await cleanupTestData()
  console.log('  Cleaned up T8 events, instances, attendance, and people')
}

// ── Main ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true })

try {
  await setup()

  const context = await loginContext(browser, ADMIN_EMAIL)
  const page = await context.newPage()

  // ── E2E-T8-01: existing person check-in happy path ───────────────────────────
  console.log('\n── E2E-T8-01 ────────────────────────────────────────────')
  {
    await page.goto(`${PROD_URL}/checkin`, { waitUntil: 'networkidle' })

    // Selector must show the T8 event (nearest instance)
    await page.waitForSelector('[data-testid="event-selector"]', { timeout: 10_000 })
    const selectorText = await page.textContent('[data-testid="event-selector"]')
    if (!selectorText?.includes(T8_EVENT_NAME)) {
      fail('E2E-T8-01', 'EventSelector does not show T8 test event', `Got: "${selectorText?.slice(0, 80)}"`)
    } else {
      await typePhone(page, T8_PERSON_PHONE)
      await page.locator(`text=${T8_PERSON_NAME}`).first().waitFor({ state: 'visible', timeout: LOOKUP_TIMEOUT })

      await page.locator('button:has-text("Daftar Hadir")').first().click()

      // Success feedback banner appears with the person's name
      const banner = page.locator('[data-testid="checkin-feedback"]')
      await banner.waitFor({ state: 'visible', timeout: 10_000 })
      const bannerText = await banner.textContent()

      // Recent panel shows the entry
      const recentHasPerson = await page
        .locator('[data-testid="recent-panel"]')
        .getByText(T8_PERSON_NAME)
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false)

      // DB row written with correct instance
      const { data: rows } = await adminSupabase
        .from('attendance')
        .select('id, event_instance_id, person_id, source')
        .eq('person_id', t8PersonId)
      const dbOk = rows?.length === 1 && rows[0].event_instance_id === t8InstanceId

      if (bannerText?.includes(T8_PERSON_NAME) && recentHasPerson && dbOk) {
        pass('E2E-T8-01', 'Check-in success: banner + recent panel + DB row', `source=${rows[0].source}`)
      } else {
        fail('E2E-T8-01', 'Check-in incomplete', `banner="${bannerText?.slice(0, 60)}" recent=${recentHasPerson} db=${dbOk}`)
      }
    }
  }

  // ── E2E-T8-02: duplicate check-in → friendly banner, no recent duplicate ────
  console.log('\n── E2E-T8-02 ────────────────────────────────────────────')
  {
    await typePhone(page, T8_PERSON_PHONE)
    await page.locator(`text=${T8_PERSON_NAME}`).first().waitFor({ state: 'visible', timeout: LOOKUP_TIMEOUT })

    await page.locator('button:has-text("Daftar Hadir")').first().click()

    const banner = page.locator('[data-testid="checkin-feedback"]')
    await banner.waitFor({ state: 'visible', timeout: 10_000 })
    // Wait for the banner to switch to the already-checked-in message
    await page.waitForFunction(
      (name) => {
        const el = document.querySelector('[data-testid="checkin-feedback"]')
        return el?.textContent?.includes(name) && el.getAttribute('role') === 'alert'
      },
      T8_PERSON_NAME,
      { timeout: 10_000 },
    ).catch(() => null)
    const bannerText = await banner.textContent()
    const bannerRole = await banner.getAttribute('role')

    // Recent panel must still contain exactly one entry for the person
    const recentCount = await page
      .locator('[data-testid="recent-panel"]')
      .getByText(T8_PERSON_NAME)
      .count()

    // Still exactly one DB row
    const { data: rows } = await adminSupabase
      .from('attendance')
      .select('id')
      .eq('person_id', t8PersonId)

    if (bannerRole === 'alert' && bannerText?.includes(T8_PERSON_NAME) && recentCount === 1 && rows?.length === 1) {
      pass('E2E-T8-02', 'Duplicate check-in: friendly banner, no recent duplicate, 1 DB row')
    } else {
      fail('E2E-T8-02', 'Duplicate handling wrong', `role=${bannerRole} text="${bannerText?.slice(0, 60)}" recent=${recentCount} rows=${rows?.length}`)
    }
  }

  // ── E2E-T8-03: cancelled instance → error feedback ───────────────────────────
  console.log('\n── E2E-T8-03 ────────────────────────────────────────────')
  {
    // Cancel the instance server-side while the page still holds it selected.
    // The pre-flight in createAttendance must reject with event_cancelled.
    await adminSupabase
      .from('event_instances')
      .update({ status: 'cancelled' })
      .eq('id', t8InstanceId)

    try {
      // Dismiss any existing banner so we wait on a fresh one
      const dismiss = page.locator('[data-testid="checkin-feedback"] button')
      if (await dismiss.isVisible().catch(() => false)) await dismiss.click()

      await typePhone(page, T8_PERSON_PHONE)
      await page.locator(`text=${T8_PERSON_NAME}`).first().waitFor({ state: 'visible', timeout: LOOKUP_TIMEOUT })
      await page.locator('button:has-text("Daftar Hadir")').first().click()

      const banner = page.locator('[data-testid="checkin-feedback"]')
      await banner.waitFor({ state: 'visible', timeout: 10_000 })
      const bannerRole = await banner.getAttribute('role')
      const bannerText = await banner.textContent()

      // No new attendance row
      const { data: rows } = await adminSupabase
        .from('attendance')
        .select('id')
        .eq('person_id', t8PersonId)

      // The error message must NOT be the duplicate message (it mentions the name)
      if (bannerRole === 'alert' && !bannerText?.includes(T8_PERSON_NAME) && rows?.length === 1) {
        pass('E2E-T8-03', 'Cancelled instance: error feedback, no new row', `"${bannerText?.slice(0, 60)}"`)
      } else {
        fail('E2E-T8-03', 'Cancelled-instance handling wrong', `role=${bannerRole} text="${bannerText?.slice(0, 60)}" rows=${rows?.length}`)
      }
    } finally {
      // Restore for the new-person test
      await adminSupabase
        .from('event_instances')
        .update({ status: 'scheduled' })
        .eq('id', t8InstanceId)
    }
  }

  // ── E2E-T8-04: new person → created + checked in ─────────────────────────────
  console.log('\n── E2E-T8-04 ────────────────────────────────────────────')
  {
    // Fresh page load so the EventSelector re-reads the (restored) instance
    await page.goto(`${PROD_URL}/checkin`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid="event-selector"]', { timeout: 10_000 })

    await typePhone(page, T8_NEW_PHONE)
    await page.locator('text=Tambah orang baru').first().waitFor({ state: 'visible', timeout: LOOKUP_TIMEOUT })
    await page.locator('text=Tambah orang baru').first().click()
    await page.waitForTimeout(600)

    await page.locator('input[type="text"]').nth(0).fill(T8_NEW_NAME)
    await page.locator('input[type="text"]').nth(1).fill('T8New')
    await page.locator('input[type="date"]').first().fill('1995-03-20')

    await page.locator('button:has-text("Tambah & Daftar Hadir")').click()

    const banner = page.locator('[data-testid="checkin-feedback"]')
    await banner.waitFor({ state: 'visible', timeout: 15_000 })
    const bannerText = await banner.textContent()

    // Both records must exist: person + attendance against the T8 instance
    const { data: people } = await adminSupabase
      .from('people')
      .select('id')
      .eq('phone_e164', T8_NEW_PHONE)
    const newPersonId = people?.[0]?.id ?? null
    let attendanceOk = false
    if (newPersonId) {
      const { data: att } = await adminSupabase
        .from('attendance')
        .select('id, event_instance_id')
        .eq('person_id', newPersonId)
      attendanceOk = att?.length === 1 && att[0].event_instance_id === t8InstanceId
    }

    if (bannerText?.includes(T8_NEW_NAME) && newPersonId && attendanceOk) {
      pass('E2E-T8-04', 'New person created and checked in', `person=${newPersonId}`)
    } else {
      fail('E2E-T8-04', 'New-person flow incomplete', `banner="${bannerText?.slice(0, 60)}" person=${newPersonId} attendance=${attendanceOk}`)
    }
  }

  await context.close()
} finally {
  await browser.close()
  await teardown()
  pass('E2E-T8-05', 'Cleanup completed (teardown ran)')
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
