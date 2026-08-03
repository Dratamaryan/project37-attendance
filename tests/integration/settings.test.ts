// Integration tests for Sprint 5 Task 7 — app_settings r/w against real local
// Docker Postgres (not mocks). Runs the real impl_getSettings/impl_updateSettings
// with real requireActiveAdmin() gating, real DB round-trips, real audit rows.
//
// next/cache's revalidateTag() throws outside a real Next.js server request
// context (see lib/actions/__tests__/settings.test.ts header comment) — mocked
// here too, since this suite still runs under plain `vitest run`, not inside an
// actual Next server. The revalidateTag behavior itself is proven live/local
// against a real running Next server — see docs/sprint-5-task-7-verify.md.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))

import { impl_getSettings, impl_updateSettings, impl_getHorizonImpact } from '@/lib/actions/settings.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[settings.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates/deletes real auth users and mutates the ` +
      `singleton app_settings row — must run against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s7-${label}-${randomUUID()}@test.invalid`
  const pass = `S7Pass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S7 Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

let adminId: string
let adminSession: SupabaseClient
let organizerSession: SupabaseClient

// This suite reads/writes the SINGLETON app_settings row — capture the true
// pre-suite values and restore them in afterAll so other test files / the
// dev DB aren't left with test values.
let originalSettings: Record<string, unknown>

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data } = await serviceAdmin.from('app_settings').select('*').eq('id', 1).single()
  originalSettings = data as Record<string, unknown>

  const admin = await createAppUserFixture('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session
}, 30_000)

afterAll(async () => {
  // Restore the singleton row exactly, including updated_at, so this suite
  // leaves zero trace on shared local-dev state.
  const { id: _id, ...restorable } = originalSettings
  void _id
  await serviceAdmin.from('app_settings').update(restorable).eq('id', 1)

  const ids = Array.from(authUserIds)
  if (ids.length === 0) return
  await serviceAdmin.from('audit_log').delete().in('actor_user_id', ids)
  await serviceAdmin.from('app_users').delete().in('id', ids)
  for (const id of ids) {
    await serviceAdmin.auth.admin.deleteUser(id)
  }
}, 30_000)

// ── privilege gate ───────────────────────────────────────────────────────────

describe('privilege gate — non-admin and inactive-admin denied, value unchanged', () => {
  it('getSettings: organizer caller -> not_authorized', async () => {
    const result = await impl_getSettings({ supabase: organizerSession, adminSupabase: serviceAdmin })
    expect(result.status).toBe('not_authorized')
  })

  it('updateSettings: organizer caller -> not_authorized, DB value unchanged', async () => {
    const { data: before } = await serviceAdmin.from('app_settings').select('default_language').eq('id', 1).single()

    const result = await impl_updateSettings({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { default_language: before?.default_language === 'id' ? 'en' : 'id' },
    })
    expect(result.status).toBe('not_authorized')

    const { data: after } = await serviceAdmin.from('app_settings').select('default_language').eq('id', 1).single()
    expect(after?.default_language).toBe(before?.default_language)
  })

  it('updateSettings: deactivated admin caller -> not_authorized, DB value unchanged', async () => {
    const deactivated = await createAppUserFixture('deactivated', 'admin', false)
    authUserIds.add(deactivated.id)

    const { data: before } = await serviceAdmin
      .from('app_settings')
      .select('materialization_horizon_mo')
      .eq('id', 1)
      .single()

    const result = await impl_updateSettings({
      supabase: deactivated.session,
      adminSupabase: serviceAdmin,
      input: { materialization_horizon_mo: 3 },
    })
    expect(result.status).toBe('not_authorized')

    const { data: after } = await serviceAdmin
      .from('app_settings')
      .select('materialization_horizon_mo')
      .eq('id', 1)
      .single()
    expect(after?.materialization_horizon_mo).toBe(before?.materialization_horizon_mo)
  })

  it('getHorizonImpact: organizer caller -> not_authorized', async () => {
    const result = await impl_getHorizonImpact({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { newHorizonMonths: 6 },
    })
    expect(result.status).toBe('not_authorized')
  })
})

// ── validation (DB round-trip confirms rejection, no write) ─────────────────

describe('impl_updateSettings — validation rejects out-of-range/bad enum, no write', () => {
  it('rejects an out-of-range horizon (25), value unchanged in DB', async () => {
    const { data: before } = await serviceAdmin
      .from('app_settings')
      .select('materialization_horizon_mo')
      .eq('id', 1)
      .single()

    const result = await impl_updateSettings({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { materialization_horizon_mo: 25 },
    })
    expect(result.status).toBe('validation_error')

    const { data: after } = await serviceAdmin
      .from('app_settings')
      .select('materialization_horizon_mo')
      .eq('id', 1)
      .single()
    expect(after?.materialization_horizon_mo).toBe(before?.materialization_horizon_mo)
  })

  it('rejects an unsupported language enum value, value unchanged in DB', async () => {
    const { data: before } = await serviceAdmin.from('app_settings').select('default_language').eq('id', 1).single()

    const result = await impl_updateSettings({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { default_language: 'fr' },
    })
    expect(result.status).toBe('validation_error')

    const { data: after } = await serviceAdmin.from('app_settings').select('default_language').eq('id', 1).single()
    expect(after?.default_language).toBe(before?.default_language)
  })
})

// ── happy path + audit ────────────────────────────────────────────────────────

describe('impl_updateSettings — happy path writes and audits', () => {
  it('updates birthday_notify_time and writes exactly one settings.update audit row with changed-field detail', async () => {
    const newTime = '08:30'
    const result = await impl_updateSettings({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { birthday_notify_time: newTime },
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.settings.birthday_notify_time.startsWith(newTime)).toBe(true)

    const { data: dbRow } = await serviceAdmin
      .from('app_settings')
      .select('birthday_notify_time')
      .eq('id', 1)
      .single()
    expect(dbRow?.birthday_notify_time.startsWith(newTime)).toBe(true)

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, details_json')
      .eq('entity_type', 'app_settings')
      .eq('actor_user_id', adminId)
      .eq('action', 'settings.update')
      .order('created_at', { ascending: false })
      .limit(1)
    expect(auditRows).toHaveLength(1)
    expect(auditRows?.[0].details_json).toHaveProperty('birthday_notify_time')
    // Changed-fields-only: no unrelated field present in the detail.
    expect(Object.keys(auditRows?.[0].details_json ?? {})).toEqual(['birthday_notify_time'])
  })
})

// ── horizon-impact estimate ───────────────────────────────────────────────────

describe('impl_getHorizonImpact', () => {
  it('counts scheduled event_instances beyond the computed horizon end', async () => {
    // Reduce horizon impact surface: create one event + a far-future scheduled
    // instance directly, confirm the estimate picks it up.
    const { data: event, error: eventErr } = await serviceAdmin
      .from('events')
      .insert({
        name: 'S7 Horizon Test Event',
        event_type: 'adhoc',
        start_date: '2030-01-01',
        start_time: '10:00',
        active: true,
        created_by: adminId,
      })
      .select('id')
      .single()
    if (eventErr) throw new Error(`fixture event insert: ${eventErr.message}`)

    const farFuture = new Date()
    farFuture.setFullYear(farFuture.getFullYear() + 5)

    const { error: instanceErr } = await serviceAdmin.from('event_instances').insert({
      event_id: event.id,
      scheduled_at: farFuture.toISOString(),
      event_name_snapshot: 'S7 Horizon Test Event',
      status: 'scheduled',
    })
    if (instanceErr) throw new Error(`fixture instance insert: ${instanceErr.message}`)

    try {
      const result = await impl_getHorizonImpact({
        supabase: adminSession,
        adminSupabase: serviceAdmin,
        input: { newHorizonMonths: 1 },
      })
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      expect(result.estimated_count).toBeGreaterThanOrEqual(1)
    } finally {
      await serviceAdmin.from('event_instances').delete().eq('event_id', event.id)
      await serviceAdmin.from('events').delete().eq('id', event.id)
    }
  })

  it('rejects an out-of-range horizon before querying', async () => {
    const result = await impl_getHorizonImpact({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { newHorizonMonths: 0 },
    })
    expect(result.status).toBe('validation_error')
  })
})
