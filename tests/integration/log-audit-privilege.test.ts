// Integration tests for the log_audit() anon-forgery fix AND the
// authenticated cross-actor forgery fix (pre-public RLS audit finding, two
// independent migrations). Runs against local Docker Supabase only.
//
// Fix 1 (20260805120000_sprint6_task0_log_audit_revoke_anon.sql): log_audit()
// is SECURITY DEFINER and had EXECUTE granted to anon via TWO independent
// sources — the implicit PUBLIC grant AND a direct per-role grant from this
// schema's `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon`
// — so an unauthenticated caller holding only the public anon key could call
// `rpc('log_audit', { p_actor_user_id: <anyone's uuid>, ... })` directly and
// insert a fully-forged audit_log row. Revokes both sources, re-grants only
// to `authenticated`/`service_role`.
//
// Fix 2 (20260805130000_sprint6_task0b_log_audit_actor_precedence.sql): even
// after Fix 1, any ONE authenticated (invited admin/organizer) account could
// still call this RPC directly with a DIFFERENT user's UUID in
// p_actor_user_id and have the row attributed to that other person, because
// the original body resolved the actor as
// COALESCE(p_actor_user_id, auth.uid()) — the caller-supplied value won.
// Flipped to COALESCE(auth.uid(), p_actor_user_id) so the database's own
// verified identity always wins when one exists; the parameter is honored
// only when auth.uid() is NULL, i.e. no authenticated session at all — the
// service_role / system backfill path this parameter exists for.
//
// This suite asserts: anon gets no row at all (stronger than rejecting one
// forged id); an authenticated caller can no longer attribute a row to
// someone else; service_role's explicit-actor backfill path still works
// (because auth.uid() really is NULL under service_role, confirmed here);
// and the ordinary organizer-wrapper path is unaffected by either fix.
//
// Run: npm test -- log-audit-privilege

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[log-audit-privilege.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates real auth users and calls log_audit() directly ` +
      `to prove a privilege boundary — must run against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()
const appUserOnlyIds: Set<string> = new Set() // app_users rows with no auth.users row
const auditLogIds: Set<number> = new Set()

// Marks every row this suite could plausibly cause, for scoped cleanup only.
const TEST_ENTITY_TYPE = `log_audit_privilege_test_${ts}`

async function createOrganizerFixture(label = 'organizer'): Promise<{ id: string; session: SupabaseClient }> {
  const email = `log-audit-priv-${label}-${randomUUID()}@test.invalid`
  const pass = `LogAuditPrivPass-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser: ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `Log Audit Priv Test ${label}`, role: 'organizer', active: true })
  if (appErr) throw new Error(`insert app_user: ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in: ${signInErr.message}`)
  return { id: authData.user.id, session }
}

// A person the actor_user_id FK can point to, with NO auth.users row and no
// live session of their own — stands in for a real historical/system actor
// a service-role backfill script would cite (app_users.id has no FK to
// auth.users, same idiom as supabase/seed.sql's baseline admin).
async function createAppUserOnlyFixture(label: string): Promise<{ id: string }> {
  const id = randomUUID()
  const { error } = await serviceAdmin.from('app_users').insert({
    id,
    email: `log-audit-priv-${label}-${id}@test.invalid`,
    full_name: `Log Audit Priv Test ${label} (no auth.users row)`,
    role: 'organizer',
    active: true,
  })
  if (error) throw new Error(`insert app_user (${label}): ${error.message}`)
  appUserOnlyIds.add(id)
  return { id }
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}, 30_000)

afterAll(async () => {
  const ids = Array.from(auditLogIds)
  if (ids.length > 0) {
    await serviceAdmin.from('audit_log').delete().in('id', ids)
  }
  const userIds = Array.from(authUserIds)
  if (userIds.length > 0) {
    await serviceAdmin.from('app_users').delete().in('id', userIds)
    for (const id of userIds) {
      await serviceAdmin.auth.admin.deleteUser(id)
    }
  }
  const appOnlyIds = Array.from(appUserOnlyIds)
  if (appOnlyIds.length > 0) {
    await serviceAdmin.from('app_users').delete().in('id', appOnlyIds)
  }
}, 30_000)

describe('log_audit() privilege gate — anon-forgery fix', () => {
  it('an unauthenticated (anon) caller cannot call log_audit at all — no forged row is written', async () => {
    // No session at all — this is exactly the "public anon key, no login"
    // context the finding described. victimId stands in for a real admin
    // whose identity a forger would try to steal.
    const victimId = randomUUID()
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const entityId = `forged-${ts}`
    const { error } = await anon.rpc('log_audit', {
      p_actor_user_id: victimId,
      p_action: 'people.soft_delete',
      p_entity_type: TEST_ENTITY_TYPE,
      p_entity_id: entityId,
    })

    // Permission denied at the database layer (42501), not a silently
    // swallowed no-op — the anon role must not even be able to attempt this.
    expect(error).not.toBeNull()
    expect(error?.code).toBe('42501')

    // Belt-and-suspenders: confirm no row landed under either the forged
    // actor id or this test's entity marker.
    const { data: rows } = await serviceAdmin
      .from('audit_log')
      .select('id')
      .eq('entity_type', TEST_ENTITY_TYPE)
      .eq('entity_id', entityId)
    expect(rows).toEqual([])
  })

  it('a real authenticated organizer session can still call log_audit successfully (no regression)', async () => {
    // This is also the "existing organizer wrapper path" regression check
    // for the actor-precedence fix below: the app's real logAudit() wrapper
    // always passes the caller's own auth.uid() as p_actor_user_id, i.e.
    // exactly this shape (param == caller's own identity) — proving the
    // COALESCE(auth.uid(), p_actor_user_id) reorder is a no-op for every
    // legitimate call site, not just for the forged-actor case below.
    const organizer = await createOrganizerFixture()
    const entityId = `legit-${ts}`

    const { error } = await organizer.session.rpc('log_audit', {
      p_actor_user_id: organizer.id,
      p_action: 'people.update',
      p_entity_type: TEST_ENTITY_TYPE,
      p_entity_id: entityId,
    })
    expect(error).toBeNull()

    const { data: rows } = await serviceAdmin
      .from('audit_log')
      .select('id, actor_user_id')
      .eq('entity_type', TEST_ENTITY_TYPE)
      .eq('entity_id', entityId)
    expect(rows).toHaveLength(1)
    expect(rows?.[0].actor_user_id).toBe(organizer.id)
    if (rows?.[0]) auditLogIds.add(rows[0].id)
  })
})

describe('log_audit() actor resolution — authenticated cross-actor forgery fix', () => {
  it('an authenticated non-admin caller passing a DIFFERENT actor_user_id is ignored — stored actor is the caller\'s own auth.uid()', async () => {
    const caller = await createOrganizerFixture('caller')
    const victim = await createOrganizerFixture('victim')
    const entityId = `crossactor-${ts}`

    const { error } = await caller.session.rpc('log_audit', {
      p_actor_user_id: victim.id, // forged — attempting to attribute the row to victim
      p_action: 'people.soft_delete',
      p_entity_type: TEST_ENTITY_TYPE,
      p_entity_id: entityId,
    })
    expect(error).toBeNull() // caller IS authenticated, so the call succeeds...

    const { data: rows } = await serviceAdmin
      .from('audit_log')
      .select('id, actor_user_id')
      .eq('entity_type', TEST_ENTITY_TYPE)
      .eq('entity_id', entityId)
    expect(rows).toHaveLength(1)
    // ...but the stored actor is the CALLER's own verified identity, not the
    // forged victim id. auth.uid() won the COALESCE, as intended.
    expect(rows?.[0].actor_user_id).toBe(caller.id)
    expect(rows?.[0].actor_user_id).not.toBe(victim.id)
    if (rows?.[0]) auditLogIds.add(rows[0].id)
  })

  it('service_role passing an explicit p_actor_user_id IS honored — the system/backfill path still works because auth.uid() is NULL under service_role', async () => {
    const historicalActor = await createAppUserOnlyFixture('backfill-target')
    const entityId = `backfill-${ts}`

    // service_role carries no 'sub' claim, so auth.uid() resolves to NULL —
    // COALESCE(auth.uid(), p_actor_user_id) falls through to the parameter.
    // Using a fixture with NO live session (and no auth.users row at all)
    // rules out any coincidental match: the only way this id lands in the
    // row is via the parameter fall-through, not via some session identity.
    const { error } = await serviceAdmin.rpc('log_audit', {
      p_actor_user_id: historicalActor.id,
      p_action: 'people.import_backfill',
      p_entity_type: TEST_ENTITY_TYPE,
      p_entity_id: entityId,
    })
    expect(error).toBeNull()

    const { data: rows } = await serviceAdmin
      .from('audit_log')
      .select('id, actor_user_id')
      .eq('entity_type', TEST_ENTITY_TYPE)
      .eq('entity_id', entityId)
    expect(rows).toHaveLength(1)
    expect(rows?.[0].actor_user_id).toBe(historicalActor.id)
    if (rows?.[0]) auditLogIds.add(rows[0].id)
  })
})
