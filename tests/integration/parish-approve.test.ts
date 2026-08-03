// Integration tests for Sprint 5 Task 7 — parish curation (approve-only)
// against real local Docker Postgres. Real requireActiveAdmin() gating, real
// AND status='pending' double-approve guard, real audit rows.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { impl_listPendingParishes, impl_approveParish } from '@/lib/actions/parishes.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[parish-approve.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates/deletes real auth users and parish rows — ` +
      `must run against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()
const parishIds: Set<string> = new Set()

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s7-parish-${label}-${randomUUID()}@test.invalid`
  const pass = `S7ParishPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S7 Parish Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function createPendingParishFixture(name: string): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('parishes')
    .insert({ name, status: 'pending' })
    .select('id')
    .single()
  if (error) throw new Error(`fixture parish insert: ${error.message}`)
  parishIds.add(data.id)
  return data.id
}

let adminId: string
let adminSession: SupabaseClient
let organizerSession: SupabaseClient

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserFixture('admin', 'admin')
  adminId = admin.id
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session
}, 30_000)

afterAll(async () => {
  const ids = Array.from(parishIds)
  if (ids.length > 0) {
    await serviceAdmin.from('audit_log').delete().eq('entity_type', 'parishes').in('entity_id', ids)
    await serviceAdmin.from('parishes').delete().in('id', ids)
  }

  const userIds = Array.from(authUserIds)
  if (userIds.length === 0) return
  await serviceAdmin.from('audit_log').delete().in('actor_user_id', userIds)
  await serviceAdmin.from('app_users').delete().in('id', userIds)
  for (const id of userIds) {
    await serviceAdmin.auth.admin.deleteUser(id)
  }
}, 30_000)

// ── privilege gate ───────────────────────────────────────────────────────────

describe('privilege gate — non-admin and inactive-admin denied, parish unchanged', () => {
  it('listPendingParishes: organizer caller -> not_authorized', async () => {
    const result = await impl_listPendingParishes({ supabase: organizerSession, adminSupabase: serviceAdmin })
    expect(result.status).toBe('not_authorized')
  })

  it('approveParish: organizer caller -> not_authorized, parish still pending', async () => {
    const parishId = await createPendingParishFixture(`S7 Gate Test A ${randomUUID()}`)

    const result = await impl_approveParish({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { parishId },
    })
    expect(result.status).toBe('not_authorized')

    const { data } = await serviceAdmin.from('parishes').select('status').eq('id', parishId).single()
    expect(data?.status).toBe('pending')
  })

  it('approveParish: deactivated admin caller -> not_authorized, parish still pending', async () => {
    const deactivated = await createAppUserFixture('deactivated', 'admin', false)
    authUserIds.add(deactivated.id)
    const parishId = await createPendingParishFixture(`S7 Gate Test B ${randomUUID()}`)

    const result = await impl_approveParish({
      supabase: deactivated.session,
      adminSupabase: serviceAdmin,
      input: { parishId },
    })
    expect(result.status).toBe('not_authorized')

    const { data } = await serviceAdmin.from('parishes').select('status').eq('id', parishId).single()
    expect(data?.status).toBe('pending')
  })
})

// ── happy path + double-approve race guard ───────────────────────────────────

describe('impl_approveParish — happy path and double-approve guard', () => {
  it('approves a pending parish, writes exactly one parish.approve audit row', async () => {
    const name = `S7 Approve Happy ${randomUUID()}`
    const parishId = await createPendingParishFixture(name)

    const result = await impl_approveParish({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { parishId },
    })
    expect(result.status).toBe('approved')

    const { data } = await serviceAdmin.from('parishes').select('status').eq('id', parishId).single()
    expect(data?.status).toBe('approved')

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_id')
      .eq('entity_type', 'parishes')
      .eq('entity_id', parishId)
      .eq('action', 'parish.approve')
    expect(auditRows).toHaveLength(1)
    expect(auditRows?.[0].actor_user_id).toBe(adminId)
  })

  it('double-approve: second call on an already-approved parish is a no-op, exactly one audit row total', async () => {
    const name = `S7 Approve Double ${randomUUID()}`
    const parishId = await createPendingParishFixture(name)

    const first = await impl_approveParish({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { parishId },
    })
    expect(first.status).toBe('approved')

    const second = await impl_approveParish({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { parishId },
    })
    expect(second).toEqual({ status: 'not_pending', currentStatus: 'approved' })

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('id')
      .eq('entity_type', 'parishes')
      .eq('entity_id', parishId)
      .eq('action', 'parish.approve')
    expect(auditRows).toHaveLength(1) // not re-audited on the second call
  })

  it('unknown parish id -> not_found', async () => {
    const result = await impl_approveParish({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { parishId: randomUUID() },
    })
    expect(result.status).toBe('not_found')
  })
})

describe('impl_listPendingParishes', () => {
  it('returns pending parishes for an active admin, excludes approved ones', async () => {
    const pendingName = `S7 List Pending ${randomUUID()}`
    const approvedName = `S7 List Approved ${randomUUID()}`
    const pendingId = await createPendingParishFixture(pendingName)
    const { data: approvedRow, error } = await serviceAdmin
      .from('parishes')
      .insert({ name: approvedName, status: 'approved' })
      .select('id')
      .single()
    if (error) throw new Error(`approved fixture insert: ${error.message}`)
    parishIds.add(approvedRow.id)

    const result = await impl_listPendingParishes({ supabase: adminSession, adminSupabase: serviceAdmin })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.parishes.some((p) => p.id === pendingId)).toBe(true)
    expect(result.parishes.some((p) => p.id === approvedRow.id)).toBe(false)
  })
})
