// Integration tests for Sprint 5 Task 6 Phase B — /admin/users actions.
// Runs against local Docker Supabase + local auth stack (not mocks) — real
// auth users, real sessions, real app_users rows. Never mocked: the S3-T8
// lesson (ON CONFLICT/RLS semantics must be proven against real Postgres)
// applies doubly here since this suite also exercises real GoTrue Admin API
// behavior (inviteUserByEmail's empirically-confirmed resend-vs-error split,
// see docs/sprint-5-task-6-verify.md Phase B).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import {
  impl_listAppUsers,
  impl_inviteOrganizer,
  impl_changeRole,
  impl_deactivateUser,
  impl_reactivateUser,
} from '@/lib/actions/admin-users.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[admin-users.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates/deletes real auth users and must run against ` +
      `local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()

// ── fixture bookkeeping — cleaned up in afterAll/afterEach, loud on error ────

const authUserIds: Set<string> = new Set()
const quarantinedAdminIds: string[] = []

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `au-${label}-${randomUUID()}@test.invalid`
  const pass = `AuPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `AU Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function activeAdminCount(): Promise<number> {
  const { count, error } = await serviceAdmin
    .from('app_users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true)
  if (error) throw new Error(`count query failed: ${error.message}`)
  return count ?? 0
}

// Same quarantine pattern as last-admin-trigger.test.ts — this suite shares
// one persistent local DB across the whole `npm test` run, so it can't
// assume it's the only admin-role fixture present.
async function quarantineOtherActiveAdmins(exceptIds: string[]): Promise<void> {
  const { data, error } = await serviceAdmin.from('app_users').select('id').eq('role', 'admin').eq('active', true)
  if (error) throw new Error(`quarantine select failed: ${error.message}`)
  const toQuarantine = (data ?? []).map((r) => r.id as string).filter((id) => !exceptIds.includes(id))
  if (toQuarantine.length === 0) {
    quarantinedAdminIds.length = 0
    return
  }
  const { error: updateErr } = await serviceAdmin.from('app_users').update({ active: false }).in('id', toQuarantine)
  if (updateErr) throw new Error(`quarantine update failed: ${updateErr.message}`)
  quarantinedAdminIds.push(...toQuarantine)
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

afterEach(async () => {
  if (quarantinedAdminIds.length > 0) {
    await serviceAdmin.from('app_users').update({ active: true }).in('id', quarantinedAdminIds)
    quarantinedAdminIds.length = 0
  }
})

afterAll(async () => {
  const ids = Array.from(authUserIds)
  if (ids.length === 0) return

  // audit_log's NO ACTION FK on actor_user_id blocks app_users deletes while
  // referencing rows exist — same lesson as the T6 orphan cleanup and
  // events-actions.test.ts's fix. Clear this suite's own audit rows first.
  const { error: auditErr } = await serviceAdmin.from('audit_log').delete().in('actor_user_id', ids)
  if (auditErr) throw new Error(`[teardown] audit_log delete failed: ${auditErr.message}`)

  const { error: appUsersErr } = await serviceAdmin.from('app_users').delete().in('id', ids)
  if (appUsersErr) throw new Error(`[teardown] app_users delete failed: ${appUsersErr.message}`)

  for (const id of ids) {
    const { error: authErr } = await serviceAdmin.auth.admin.deleteUser(id)
    if (authErr) throw new Error(`[teardown] auth.admin.deleteUser(${id}) failed: ${authErr.message}`)
  }
}, 30_000)

// ── invite ─────────────────────────────────────────────────────────────────

describe('impl_inviteOrganizer', () => {
  it('creates a matching auth user + app_users row (same id, role=organizer)', async () => {
    const email = `invite-fresh-${randomUUID()}@test.invalid`
    const result = await impl_inviteOrganizer({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { email },
    })
    expect(result.status).toBe('invited')
    if (result.status !== 'invited') return
    expect(result.repaired).toBe(false)
    authUserIds.add(result.id)

    const { data: authUser } = await serviceAdmin.auth.admin.getUserById(result.id)
    expect(authUser.user?.email).toBe(email)

    const { data: appUser } = await serviceAdmin.from('app_users').select('id, email, role').eq('id', result.id).single()
    expect(appUser?.id).toBe(result.id)
    expect(appUser?.email).toBe(email)
    expect(appUser?.role).toBe('organizer')
  })

  it('rejects an invalid email before ever calling Auth', async () => {
    const result = await impl_inviteOrganizer({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { email: 'not-an-email' },
    })
    expect(result.status).toBe('invalid_input')
  })

  it('idempotent re-invite of a fully set-up user returns already_exists — no new rows', async () => {
    const email = `invite-full-${randomUUID()}@test.invalid`
    const first = await impl_inviteOrganizer({ supabase: adminSession, adminSupabase: serviceAdmin, input: { email } })
    expect(first.status).toBe('invited')
    if (first.status !== 'invited') return
    authUserIds.add(first.id)

    const { count: appUsersBefore } = await serviceAdmin
      .from('app_users')
      .select('id', { count: 'exact', head: true })

    const second = await impl_inviteOrganizer({ supabase: adminSession, adminSupabase: serviceAdmin, input: { email } })
    expect(second).toEqual({ status: 'already_exists', role: 'organizer', active: true })

    const { count: appUsersAfter } = await serviceAdmin
      .from('app_users')
      .select('id', { count: 'exact', head: true })
    expect(appUsersAfter).toBe(appUsersBefore) // row-count proof: nothing new created
  })

  it('orphan-repair: an existing UNCONFIRMED auth user (no app_users row) is completed via re-invite', async () => {
    const email = `invite-unconfirmed-orphan-${randomUUID()}@test.invalid`

    // Simulate a partial failure: auth user created directly (unconfirmed),
    // app_users insert never happened.
    const { data: orphanData, error: orphanErr } = await serviceAdmin.auth.admin.inviteUserByEmail(email)
    if (orphanErr || !orphanData.user) throw new Error(`orphan setup failed: ${orphanErr?.message}`)
    authUserIds.add(orphanData.user.id)

    const { data: preCheck } = await serviceAdmin.from('app_users').select('id').eq('id', orphanData.user.id).maybeSingle()
    expect(preCheck).toBeNull() // confirms the orphan shape before repair

    const result = await impl_inviteOrganizer({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { email },
    })
    expect(result.status).toBe('invited')
    if (result.status !== 'invited') return
    expect(result.repaired).toBe(true)
    expect(result.id).toBe(orphanData.user.id) // SAME auth id — no duplicate account

    const { data: appUser } = await serviceAdmin.from('app_users').select('id, role').eq('id', orphanData.user.id).single()
    expect(appUser?.role).toBe('organizer')

    const { count: authUsersMatchingEmail } = await serviceAdmin.auth.admin
      .listUsers({ page: 1, perPage: 1000 })
      .then((r) => ({ count: r.data.users.filter((u) => u.email === email).length }))
    expect(authUsersMatchingEmail).toBe(1) // no duplicate auth account either
  })

  it('orphan-repair: an existing CONFIRMED auth user (no app_users row) is completed via the email_exists branch', async () => {
    const email = `invite-confirmed-orphan-${randomUUID()}@test.invalid`

    // Simulate an admin/organizer whose auth account is fully confirmed
    // (e.g. accepted a prior invite) but whose app_users row is missing.
    const { data: orphanData, error: orphanErr } = await serviceAdmin.auth.admin.createUser({
      email,
      password: `ConfirmedOrphan-${ts}!`,
      email_confirm: true,
    })
    if (orphanErr || !orphanData.user) throw new Error(`orphan setup failed: ${orphanErr?.message}`)
    authUserIds.add(orphanData.user.id)

    const result = await impl_inviteOrganizer({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { email },
    })
    expect(result.status).toBe('invited')
    if (result.status !== 'invited') return
    expect(result.repaired).toBe(true)
    expect(result.id).toBe(orphanData.user.id)

    const { data: appUser } = await serviceAdmin.from('app_users').select('role').eq('id', orphanData.user.id).single()
    expect(appUser?.role).toBe('organizer')
  })
})

// ── privilege gate ───────────────────────────────────────────────────────────

describe('privilege gate — non-admin and inactive-admin denied for every action', () => {
  it('inviteOrganizer: organizer caller → not_authorized, no auth user created', async () => {
    const email = `gate-invite-${randomUUID()}@test.invalid`
    const { count: before } = await serviceAdmin.auth.admin
      .listUsers({ page: 1, perPage: 1000 })
      .then((r) => ({ count: r.data.users.length }))

    const result = await impl_inviteOrganizer({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { email },
    })
    expect(result.status).toBe('not_authorized')

    const { count: after } = await serviceAdmin.auth.admin
      .listUsers({ page: 1, perPage: 1000 })
      .then((r) => ({ count: r.data.users.length }))
    expect(after).toBe(before) // row-count proof: no auth user created
  })

  it('inviteOrganizer: deactivated admin caller → not_authorized, no auth user created', async () => {
    const deactivated = await createAppUserFixture('deactivated', 'admin', false)
    authUserIds.add(deactivated.id)

    const email = `gate-invite-inactive-${randomUUID()}@test.invalid`
    const { count: before } = await serviceAdmin.from('app_users').select('id', { count: 'exact', head: true })

    const result = await impl_inviteOrganizer({
      supabase: deactivated.session,
      adminSupabase: serviceAdmin,
      input: { email },
    })
    expect(result.status).toBe('not_authorized')

    const { count: after } = await serviceAdmin.from('app_users').select('id', { count: 'exact', head: true })
    expect(after).toBe(before)
  })

  it('changeRole: organizer caller → not_authorized, target unchanged', async () => {
    const target = await createAppUserFixture('role-target', 'organizer')
    authUserIds.add(target.id)

    const result = await impl_changeRole({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id, newRole: 'admin' },
    })
    expect(result.status).toBe('not_authorized')

    const { data } = await serviceAdmin.from('app_users').select('role').eq('id', target.id).single()
    expect(data?.role).toBe('organizer')
  })

  it('deactivateUser: organizer caller → not_authorized, target unchanged', async () => {
    const target = await createAppUserFixture('deact-target', 'organizer')
    authUserIds.add(target.id)

    const result = await impl_deactivateUser({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id },
    })
    expect(result.status).toBe('not_authorized')

    const { data } = await serviceAdmin.from('app_users').select('active').eq('id', target.id).single()
    expect(data?.active).toBe(true)
  })

  it('reactivateUser: organizer caller → not_authorized, target unchanged', async () => {
    const target = await createAppUserFixture('react-target', 'organizer', false)
    authUserIds.add(target.id)

    const result = await impl_reactivateUser({
      supabase: organizerSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id },
    })
    expect(result.status).toBe('not_authorized')

    const { data } = await serviceAdmin.from('app_users').select('active').eq('id', target.id).single()
    expect(data?.active).toBe(false)
  })

  it('listAppUsers: organizer caller → not_authorized, no users leaked', async () => {
    const result = await impl_listAppUsers({ supabase: organizerSession, adminSupabase: serviceAdmin })
    expect(result.status).toBe('not_authorized')
    expect('users' in result).toBe(false) // no leak by construction — the type has no users field here
  })
})

// ── role change ──────────────────────────────────────────────────────────────

describe('impl_changeRole', () => {
  it('promotes an organizer to admin', async () => {
    const target = await createAppUserFixture('promote', 'organizer')
    authUserIds.add(target.id)

    const result = await impl_changeRole({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id, newRole: 'admin' },
    })
    expect(result).toEqual({ status: 'ok', id: target.id, role: 'admin' })
  })

  it('demotes an admin when another active admin exists (2 -> 1)', async () => {
    const target = await createAppUserFixture('demote-ok', 'admin')
    authUserIds.add(target.id)
    // adminSession's own fixture is also an active admin, so count >= 2 here.

    const result = await impl_changeRole({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id, newRole: 'organizer' },
    })
    expect(result).toEqual({ status: 'ok', id: target.id, role: 'organizer' })
  })

  it('blocks demoting the sole active admin (last_admin, friendly pre-check)', async () => {
    await quarantineOtherActiveAdmins([adminId])
    expect(await activeAdminCount()).toBe(1)

    const result = await impl_changeRole({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: adminId, newRole: 'organizer' },
    })
    expect(result).toEqual({ status: 'not_allowed', reason: 'last_admin' })

    const { data } = await serviceAdmin.from('app_users').select('role').eq('id', adminId).single()
    expect(data?.role).toBe('admin')
  })

  it('allows self-demotion when not the last admin', async () => {
    const other = await createAppUserFixture('self-demote-cover', 'admin')
    authUserIds.add(other.id)

    const result = await impl_changeRole({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: adminId, newRole: 'organizer' },
    })
    expect(result).toEqual({ status: 'ok', id: adminId, role: 'organizer' })

    // Restore for subsequent tests in this file.
    await serviceAdmin.from('app_users').update({ role: 'admin' }).eq('id', adminId)
  })
})

// ── deactivate / reactivate ──────────────────────────────────────────────────

describe('impl_deactivateUser / impl_reactivateUser', () => {
  it('deactivates an organizer and logs an audit row', async () => {
    const target = await createAppUserFixture('deact-ok', 'organizer')
    authUserIds.add(target.id)

    const result = await impl_deactivateUser({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id },
    })
    expect(result).toEqual({ status: 'ok', id: target.id })

    const { data: appUser } = await serviceAdmin.from('app_users').select('active').eq('id', target.id).single()
    expect(appUser?.active).toBe(false)

    const { data: auditRows } = await serviceAdmin
      .from('audit_log')
      .select('action, actor_user_id, entity_id')
      .eq('entity_id', target.id)
      .eq('action', 'app_user.deactivate')
    expect(auditRows).toHaveLength(1)
    expect(auditRows?.[0].actor_user_id).toBe(adminId)
  })

  it('blocks self-deactivation before any work is done', async () => {
    const result = await impl_deactivateUser({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: adminId },
    })
    expect(result).toEqual({ status: 'not_allowed', reason: 'self' })

    const { data } = await serviceAdmin.from('app_users').select('active').eq('id', adminId).single()
    expect(data?.active).toBe(true)
  })

  // NOTE: "deactivate the sole admin via a DIFFERENT caller" is not tested
  // here because it's unreachable through impl_deactivateUser by
  // construction — the privilege gate requires the caller to be an active
  // admin, so whenever the target is also an active admin distinct from the
  // caller, the count is always >= 2 (caller + target) before the call ever
  // runs, meaning the app-level last-admin pre-check can never actually fire
  // for a non-self target. Self-deactivation is blocked separately (and
  // always reachable) by the 'self' check above, before the last-admin count
  // is ever queried. The only way to reach "sole admin deactivated" at all is
  // by bypassing the app layer entirely (a direct DB update) — which is
  // exactly what tests/integration/last-admin-trigger.test.ts exercises
  // against the real enforcement point, the DB trigger.

  it('reactivates a deactivated user and restores access', async () => {
    const target = await createAppUserFixture('react-ok', 'organizer', false)
    authUserIds.add(target.id)

    const result = await impl_reactivateUser({
      supabase: adminSession,
      adminSupabase: serviceAdmin,
      input: { targetId: target.id },
    })
    expect(result).toEqual({ status: 'ok', id: target.id })

    const { data } = await serviceAdmin.from('app_users').select('active').eq('id', target.id).single()
    expect(data?.active).toBe(true)
  })
})

// ── listAppUsers ─────────────────────────────────────────────────────────────

describe('impl_listAppUsers', () => {
  it('returns the full list for an active admin, including self', async () => {
    const result = await impl_listAppUsers({ supabase: adminSession, adminSupabase: serviceAdmin })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.users.some((u) => u.id === adminId)).toBe(true)
  })
})
