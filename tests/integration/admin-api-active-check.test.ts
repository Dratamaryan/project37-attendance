// Integration tests for Sprint 5 Task 7 — the /api/admin/* active-admin gap
// fix. All three /api/admin/* Route Handlers predated Phase A's bounded
// 13-call-site sweep (T6) and checked app_users.role directly, never active —
// meaning a deactivated admin could still trigger a real Telegram send, a
// real attendance export, or a real people import. This suite proves the fix
// (swap to requireActiveAdmin()) against a REAL deactivated admin session,
// not a mock, for all three routes:
//   - app/api/admin/telegram/test/route.ts
//   - app/api/admin/export/attendance/route.ts
//   - app/api/admin/import/people/route.ts
//
// The generic "deactivated admin denied" mechanism itself is already proven
// once, live-session, by tests/integration/require-admin-active-check.test.ts
// — not re-proven per route here. What IS route-specific and worth testing:
// that each route maps denial to the correct HTTP status AND never reaches
// its privileged side effect (Telegram send / audit row for export or
// import).
//
// lib/supabase/server.ts's createClient() reads next/headers cookies(),
// which has no request-scoped context under plain `vitest run`. Mocking the
// module to return the real, already-authenticated session client (created
// via admin.createUser + signInWithPassword, same pattern as
// require-admin-active-check.test.ts) sidesteps that Next-only dependency
// while still exercising the real requireActiveAdmin() -> real app_users
// lookup -> real DB state.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as XLSX from 'xlsx'
import { COLUMN_MAPPINGS } from '../../lib/import/columns'

const CONSENT_HEADER = COLUMN_MAPPINGS.find((m) => m.target === 'photo_consent_raw')!.headerAliases[0]

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[admin-api-active-check.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users — must run ` +
      `against local Docker only.`,
  )
}

let currentSessionClient: SupabaseClient
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => currentSessionClient,
}))

const sendTelegramMessageMock = vi.fn()
vi.mock('@/lib/telegram/client', () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
}))

// lib/telegram/token.ts has `import 'server-only'` — throws unconditionally
// under plain `vitest run` (outside Next's "react-server" bundler
// condition), same issue as lib/settings/default-language-cache.ts. Mocked
// here rather than exercised for real: this suite is testing the ROUTE'S
// active-admin gate, not the token-presence logic (which has its own
// coverage in app/admin/settings/__tests__/telegram-status.test.tsx).
vi.mock('@/lib/telegram/token', () => ({
  getTelegramBotToken: () => 'mock-token-not-real',
}))

let serviceAdmin: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s7-api-${label}-${randomUUID()}@test.invalid`
  const pass = `S7ApiPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S7 API Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

let activeAdmin: { id: string; session: SupabaseClient }
let deactivatedAdmin: { id: string; session: SupabaseClient }
let organizer: { id: string; session: SupabaseClient }

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  activeAdmin = await createAppUserFixture('active', 'admin')
  deactivatedAdmin = await createAppUserFixture('deactivated', 'admin', false)
  organizer = await createAppUserFixture('organizer', 'organizer')
}, 30_000)

afterAll(async () => {
  const ids = Array.from(authUserIds)
  if (ids.length === 0) return
  await serviceAdmin.from('audit_log').delete().in('actor_user_id', ids)
  await serviceAdmin.from('app_users').delete().in('id', ids)
  for (const id of ids) {
    await serviceAdmin.auth.admin.deleteUser(id)
  }
}, 30_000)

async function countAuditRows(action: string, entityType: string): Promise<number> {
  const { count, error } = await serviceAdmin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', action)
    .eq('entity_type', entityType)
  if (error) throw new Error(`countAuditRows failed: ${error.message}`)
  return count ?? 0
}

// ── POST /api/admin/telegram/test ────────────────────────────────────────────

describe('POST /api/admin/telegram/test — active-check', () => {
  it('deactivated admin -> 403, sendTelegramMessage never called', async () => {
    currentSessionClient = deactivatedAdmin.session
    sendTelegramMessageMock.mockClear()

    const { POST } = await import('@/app/api/admin/telegram/test/route')
    const res = await POST()

    expect(res.status).toBe(403)
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('organizer -> 403, sendTelegramMessage never called', async () => {
    currentSessionClient = organizer.session
    sendTelegramMessageMock.mockClear()

    const { POST } = await import('@/app/api/admin/telegram/test/route')
    const res = await POST()

    expect(res.status).toBe(403)
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('active admin -> passes the gate, reaches the send call (mocked success)', async () => {
    currentSessionClient = activeAdmin.session
    sendTelegramMessageMock.mockClear()
    sendTelegramMessageMock.mockResolvedValue({ ok: true, messageId: 1 })

    // Ensure a structurally-valid chat id is present so the gate is the ONLY
    // thing under test — an unrelated "not_configured" 400 short-circuit
    // would give a false pass for the gate assertion. (TELEGRAM_BOT_TOKEN
    // itself is mocked away above via lib/telegram/token.)
    const { data: originalSettings } = await serviceAdmin
      .from('app_settings')
      .select('telegram_admin_chat_id')
      .eq('id', 1)
      .single()
    await serviceAdmin.from('app_settings').update({ telegram_admin_chat_id: '123456789' }).eq('id', 1)

    try {
      const { POST } = await import('@/app/api/admin/telegram/test/route')
      const res = await POST()

      expect(res.status).toBe(200)
      expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1)
    } finally {
      await serviceAdmin
        .from('app_settings')
        .update({ telegram_admin_chat_id: originalSettings?.telegram_admin_chat_id ?? null })
        .eq('id', 1)
    }
  })
})

// ── GET /api/admin/export/attendance ─────────────────────────────────────────

describe('GET /api/admin/export/attendance — active-check', () => {
  it('deactivated admin -> 403, no export.create audit row written', async () => {
    currentSessionClient = deactivatedAdmin.session
    const before = await countAuditRows('export.create', 'export')

    const { GET } = await import('@/app/api/admin/export/attendance/route')
    const req = new NextRequest('http://localhost/api/admin/export/attendance')
    const res = await GET(req)

    expect(res.status).toBe(403)
    const after = await countAuditRows('export.create', 'export')
    expect(after).toBe(before)
  })

  it('active admin -> 200, exactly one new export.create audit row', async () => {
    currentSessionClient = activeAdmin.session
    const before = await countAuditRows('export.create', 'export')

    const { GET } = await import('@/app/api/admin/export/attendance/route')
    const req = new NextRequest('http://localhost/api/admin/export/attendance')
    const res = await GET(req)

    expect(res.status).toBe(200)
    const after = await countAuditRows('export.create', 'export')
    expect(after).toBe(before + 1)
  })
})

// ── POST /api/admin/import/people ────────────────────────────────────────────

function buildDryRunFormData(): FormData {
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['Nama Lengkap', 'Nomor HP', CONSENT_HEADER],
    ['S7 Gate Test Person', '081200091099', 'Ya'],
  ])
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer

  const formData = new FormData()
  formData.set('mode', 'dry_run')
  formData.set('file', new File([new Uint8Array(buffer)], 's7-gate-test.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }))
  return formData
}

describe('POST /api/admin/import/people — active-check', () => {
  it('deactivated admin -> 403, no import.dry_run audit row written', async () => {
    currentSessionClient = deactivatedAdmin.session
    const before = await countAuditRows('import.dry_run', 'import')

    const { POST } = await import('@/app/api/admin/import/people/route')
    const req = new NextRequest('http://localhost/api/admin/import/people', {
      method: 'POST',
      body: buildDryRunFormData(),
    })
    const res = await POST(req)

    expect(res.status).toBe(403)
    const after = await countAuditRows('import.dry_run', 'import')
    expect(after).toBe(before)
  })

  it('active admin -> 200, exactly one new import.dry_run audit row', async () => {
    currentSessionClient = activeAdmin.session
    const before = await countAuditRows('import.dry_run', 'import')

    const { POST } = await import('@/app/api/admin/import/people/route')
    const req = new NextRequest('http://localhost/api/admin/import/people', {
      method: 'POST',
      body: buildDryRunFormData(),
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    const after = await countAuditRows('import.dry_run', 'import')
    expect(after).toBe(before + 1)
  })
})
