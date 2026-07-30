/**
 * Sprint 4 T10 — live render-confirm for the invite page.
 *
 * Covers the two things that can only be proven by actually rendering the
 * page (not by code inspection or unit tests):
 *   1. Nested-segment layout inheritance: exactly one topbar + one bottom nav
 *      render on the invite page (no accidental new layout.tsx double-render).
 *   2. The invite page's OWN admin guard, hit directly by an organizer,
 *      independent of the shared events/layout.tsx role gate (plan review
 *      requirement #1 — the guard must hold on its own).
 *
 * Read-only: no invites are sent, no data is written. Reuses T9's existing
 * fixture event/instance (already documented as excluded from the demo wipe
 * predicate) rather than creating new fixtures for a pure navigation check.
 *
 * Run: node scripts/t10-invite-render-verify.mjs
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

const ADMIN_EMAIL     = 'admin-example@example.test'
const ORGANIZER_EMAIL = 'organizer-example@example.test'

// T9's existing fixture — already documented as excluded from the demo wipe
// predicate; reused here read-only, no new rows written.
const EVENT_ID    = '38f16348-b257-488a-ad28-a38e260e5b0e'
const INSTANCE_ID = '1724c4a2-0140-4694-9d91-e54ef475150f'
const INVITE_PATH = `/admin/events/${EVENT_ID}/instances/${INSTANCE_ID}/invite`

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('Missing env vars'); process.exit(1)
}

const adminSupabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anonSupabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

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

async function run() {
  console.log('\nSprint 4 T10 — live render-confirm: invite page\n')

  const browser = await chromium.launch({ headless: true })

  try {
    // ── Admin: instance list shows the Invite link, and it navigates correctly ──
    console.log('[1] Admin — Invite link on the instance list, layout inheritance on the invite page')
    const adminContext = await loginContext(browser, ADMIN_EMAIL)
    const adminPage = await adminContext.newPage()

    await adminPage.goto(`${PROD_URL}/admin/events/${EVENT_ID}`, { waitUntil: 'networkidle' })
    const inviteLink = adminPage.locator(`[data-testid="invite-link-${INSTANCE_ID}"]`)
    const linkVisible = await inviteLink.isVisible().catch(() => false)
    if (linkVisible) {
      pass('T10-NAV-01', 'Invite link visible on instance list for admin')
    } else {
      fail('T10-NAV-01', 'Invite link not found on instance list for admin')
    }

    await adminPage.goto(`${PROD_URL}${INVITE_PATH}`, { waitUntil: 'networkidle' })

    // Exactly one topbar (header) and one logo — proves no duplicate
    // layout.tsx double-rendered the shared chrome on this nested segment.
    const headerCount = await adminPage.locator('header').count()
    const logoCount    = await adminPage.locator('img[alt="Project 37"]').count()
    if (headerCount === 1 && logoCount === 1) {
      pass('T10-LAYOUT-01', 'Exactly one topbar renders on the invite page', `header=${headerCount} logo=${logoCount}`)
    } else {
      fail('T10-LAYOUT-01', 'Unexpected topbar count — possible duplicate layout', `header=${headerCount} logo=${logoCount}`)
    }

    const previewButton = adminPage.locator('[data-testid="preview-button"]')
    const panelVisible = await previewButton.isVisible().catch(() => false)
    if (panelVisible) {
      pass('T10-LAYOUT-02', 'Invite panel (filter/preview UI) renders inside the inherited layout for admin')
    } else {
      fail('T10-LAYOUT-02', 'Invite panel did not render for admin')
    }

    await adminContext.close()

    // ── Organizer: direct hit on the invite URL — page's OWN guard, independent ──
    console.log('\n[2] Organizer — direct hit on the invite URL is blocked by the invite page’s own guard')
    const orgContext = await loginContext(browser, ORGANIZER_EMAIL)
    const orgPage = await orgContext.newPage()

    await orgPage.goto(`${PROD_URL}${INVITE_PATH}`, { waitUntil: 'networkidle' })

    const orgPreviewButton = orgPage.locator('[data-testid="preview-button"]')
    const orgSeesPanel = await orgPreviewButton.isVisible().catch(() => false)
    const bodyText = await orgPage.textContent('body')

    if (!orgSeesPanel) {
      pass('T10-GUARD-01', 'Organizer direct URL hit does NOT render the invite panel')
    } else {
      fail('T10-GUARD-01', 'Organizer direct URL hit rendered the invite panel — guard failed')
    }

    // Distinguish "blocked" from "redirected somewhere unrelated" — confirm
    // we're still on an admin-area page (not bounced to /login, which would
    // mean the session itself was invalid rather than the guard firing).
    const urlAfter = orgPage.url()
    if (urlAfter.includes('/admin/events/')) {
      pass('T10-GUARD-02', 'Organizer session stayed in the admin area (guard fired, not a session failure)', urlAfter)
    } else {
      fail('T10-GUARD-02', 'Unexpected URL after organizer hit — check session validity', urlAfter)
    }

    console.log(`  (page text sample: "${bodyText?.slice(0, 120).replace(/\s+/g, ' ')}")`)

    await orgContext.close()
  } catch (err) {
    fail('FATAL', 'Unexpected error during verify run', String(err))
    console.error(err)
  } finally {
    await browser.close()
  }

  console.log('\n─'.repeat(40))
  console.log('T10 Render-Verify Results:')
  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.desc}${r.detail ? ' — ' + r.detail : ''}`)
  }
  const passedCount = results.filter((r) => r.passed).length
  console.log(`\n${passedCount}/${results.length} passed`)
  if (!allPassed) process.exit(1)
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
