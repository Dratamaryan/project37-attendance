// Integration test for Sprint 5 Task 6 — proves the actual lockout mechanism
// for a deactivated admin, against a REAL Supabase auth session (not a mock).
//
// The T6 plan's central claim about revoke: a deactivated user is locked out
// on their VERY NEXT REQUEST, independent of their JWT's remaining validity
// window — because requireActiveAdmin() re-queries app_users fresh every
// call, never trusting a cached role/active claim from the JWT itself. This
// test proves that with the SAME already-issued, still-valid session: it
// passes before deactivation and is denied after, with no re-authentication
// in between (the JWT is byte-for-byte the same both times).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { requireActiveAdmin } from '@/lib/auth/require-admin'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[require-admin-active-check.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION ` +
      `project (${PROD_PROJECT_REF}). This suite creates/deletes real auth users and must run ` +
      `against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
let testAdminId: string | undefined

beforeAll(() => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

afterAll(async () => {
  if (testAdminId) {
    const { error: appUsersErr } = await serviceAdmin.from('app_users').delete().eq('id', testAdminId)
    if (appUsersErr) throw new Error(`[teardown] app_users delete failed: ${appUsersErr.message}`)
    const { error: authErr } = await serviceAdmin.auth.admin.deleteUser(testAdminId)
    if (authErr) throw new Error(`[teardown] auth.admin.deleteUser failed: ${authErr.message}`)
  }
})

describe('requireActiveAdmin — deactivation lockout with a live session', () => {
  it('denies the very next call once active flips to false, using the SAME unchanged JWT', async () => {
    const ts = Date.now()
    const email = `t6-active-check-admin-${ts}@test.invalid`
    const password = `T6ActiveCheck-${ts}!`

    const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (authErr || !authData.user) throw new Error(`createUser failed: ${authErr?.message}`)
    testAdminId = authData.user.id

    const { error: appUserErr } = await serviceAdmin
      .from('app_users')
      .insert({ id: testAdminId, email, role: 'admin', active: true })
    if (appUserErr) throw new Error(`app_users insert failed: ${appUserErr.message}`)

    const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { error: signInErr } = await session.auth.signInWithPassword({ email, password })
    if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`)

    // Capture the JWT to prove it is IDENTICAL across both calls below — the
    // lockout is not "the token got invalidated", it's "the DB check now
    // says no" on an otherwise still-valid token.
    const { data: sessionData } = await session.auth.getSession()
    const jwtBeforeDeactivation = sessionData.session?.access_token

    const before = await requireActiveAdmin(session)
    expect(before).toEqual({ status: 'ok', actorId: testAdminId, role: 'admin' })

    // Deactivate via the service-role client — the organizer's own session
    // client never re-authenticates and is never told anything happened.
    const { error: deactivateErr } = await serviceAdmin
      .from('app_users')
      .update({ active: false })
      .eq('id', testAdminId)
    if (deactivateErr) throw new Error(`deactivate failed: ${deactivateErr.message}`)

    const { data: sessionDataAfter } = await session.auth.getSession()
    const jwtAfterDeactivation = sessionDataAfter.session?.access_token
    expect(jwtAfterDeactivation).toBe(jwtBeforeDeactivation) // same token — proves this isn't a token-expiry effect

    const after = await requireActiveAdmin(session)
    expect(after).toEqual({ status: 'denied' })
  })
})
