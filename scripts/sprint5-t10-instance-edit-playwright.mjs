/**
 * Sprint 5 T10 — live render-confirm for the instance edit surface
 * (/admin/events/[id]/instances/[instanceId]/edit).
 *
 * Covers what only a real render + real submit can prove:
 *   1. Nested-segment layout inheritance: exactly one topbar renders (no
 *      accidental new layout.tsx double-render — the D14/T9/T10(S4) lesson).
 *   2. The real InstanceEditForm + updateInstance server action round-trips
 *      image_url through the real admin session (not a mocked one).
 *   3. event_instance.update audit row lands with the right changed_fields.
 *
 * Reuses Sprint 4 T9's existing fixture event/instance (already documented as
 * excluded from the demo wipe predicate) — no new event/instance created.
 *
 * Run:
 *   node scripts/sprint5-t10-instance-edit-playwright.mjs set    # fill + save the image URL
 *   node scripts/sprint5-t10-instance-edit-playwright.mjs clear  # blank + save (clears to null)
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

const ADMIN_EMAIL = 'admin@example.com'

// T9's existing fixture — already documented as excluded from the demo wipe
// predicate; reused here rather than creating a new event.
const EVENT_ID    = '38f16348-b257-488a-ad28-a38e260e5b0e'
const INSTANCE_ID = '1724c4a2-0140-4694-9d91-e54ef475150f'
const EDIT_PATH   = `/admin/events/${EVENT_ID}/instances/${INSTANCE_ID}/edit`

// Public, stable, purpose-built for exactly this kind of test — no auth, always resolves.
const IMAGE_URL = 'https://picsum.photos/600/400'

const mode = process.argv[2]
if (mode !== 'set' && mode !== 'clear') {
  console.error('Usage: node scripts/sprint5-t10-instance-edit-playwright.mjs <set|clear>')
  process.exit(1)
}

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
  console.log(`\nSprint 5 T10 — live render-confirm: instance edit surface (${mode})\n`)

  const browser = await chromium.launch({ headless: true })
  const targetValue = mode === 'set' ? IMAGE_URL : ''

  try {
    const context = await loginContext(browser, ADMIN_EMAIL)
    const page = await context.newPage()

    await page.goto(`${PROD_URL}${EDIT_PATH}`, { waitUntil: 'networkidle' })

    // Exactly one topbar (header) and one logo — proves no duplicate
    // layout.tsx double-rendered the shared chrome on this nested segment.
    const headerCount = await page.locator('header').count()
    const logoCount    = await page.locator('img[alt="Project 37"]').count()
    if (headerCount === 1 && logoCount === 1) {
      pass('T10-LAYOUT-01', 'Exactly one topbar renders on the instance edit page', `header=${headerCount} logo=${logoCount}`)
    } else {
      fail('T10-LAYOUT-01', 'Unexpected topbar count — possible duplicate layout', `header=${headerCount} logo=${logoCount}`)
    }

    const input = page.locator('#image_url')
    const inputVisible = await input.isVisible().catch(() => false)
    if (inputVisible) {
      pass('T10-FORM-01', 'image_url field renders on the edit form')
    } else {
      fail('T10-FORM-01', 'image_url field not found — cannot proceed')
      throw new Error('image_url field missing')
    }

    // React controlled inputs need char-by-char input (Sprint 1 locked pattern).
    await input.click()
    await input.selectText().catch(() => null)
    await page.keyboard.press('Backspace') // clear any existing value first
    if (targetValue) {
      await input.pressSequentially(targetValue, { delay: 20 })
    }

    await page.locator('main form button[type="submit"]').click()
    await page.waitForURL(new RegExp(`/instances/${INSTANCE_ID}(\\?|$)`), { timeout: 10_000 })
    pass('T10-FORM-02', `Form submit redirected back to instance detail (${mode})`, page.url())

    await context.close()

    // ── DB verification ──────────────────────────────────────────────────
    const { data: inst } = await adminSupabase
      .from('event_instances')
      .select('image_url')
      .eq('id', INSTANCE_ID)
      .single()

    const expected = mode === 'set' ? IMAGE_URL : null
    if (inst?.image_url === expected) {
      pass('T10-DB-01', `event_instances.image_url matches expected (${mode})`, JSON.stringify(inst?.image_url))
    } else {
      fail('T10-DB-01', `event_instances.image_url mismatch`, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(inst?.image_url)}`)
    }

    const { data: auditRows } = await adminSupabase
      .from('audit_log')
      .select('details_json, created_at')
      .eq('entity_type', 'event_instance')
      .eq('entity_id', INSTANCE_ID)
      .eq('action', 'event_instance.update')
      .order('created_at', { ascending: false })
      .limit(1)

    const latest = auditRows?.[0]
    const changedFields = latest?.details_json?.changed_fields
    if (Array.isArray(changedFields) && changedFields.includes('image_url')) {
      pass('T10-AUDIT-01', 'event_instance.update audit row present with changed_fields including image_url', JSON.stringify(latest?.details_json))
    } else {
      fail('T10-AUDIT-01', 'No matching audit row found', JSON.stringify(latest))
    }
  } catch (err) {
    fail('FATAL', 'Unexpected error during verify run', String(err))
    console.error(err)
  } finally {
    await browser.close()
  }

  console.log('\n─'.repeat(40))
  console.log('T10 Instance-Edit Render-Verify Results:')
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
