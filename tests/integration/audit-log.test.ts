// Integration tests for Sprint 5 Task 9 — /admin/audit-log viewer's read
// path (impl_listAuditLog) against real local Docker Postgres. Real
// requireActiveAdmin() gating, real RLS-bypassing service-role fixture
// writes, real keyset pagination round-trips.
//
// Actor-scoped assertions (T5-09, pagination boundary) use FRESH randomUUID()
// actor fixtures per test, so `total` and row counts are exact — no other
// suite in this shared-DB run can reference an actor id that didn't exist
// until this file created it. Same isolation strategy as parish-approve.test.ts
// / settings.test.ts, not a global delete (memory: feedback_materialize_test_isolation
// Rule 1 — scope every delete to fixture ids).

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { impl_listAuditLog } from '@/lib/actions/audit-log.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[audit-log.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite creates/deletes real auth users and audit_log ` +
      `rows — must run against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const ts = Date.now()
const authUserIds: Set<string> = new Set()
const auditLogIds: Set<number> = new Set()

// Marks every row this suite inserts, for a scoped afterAll cleanup that
// never touches real audit history from other suites/dev use.
const TEST_ENTITY_TYPE = `s9_audit_log_test_${ts}`

async function createAppUserFixture(
  label: string,
  role: 'admin' | 'organizer',
  active = true,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `s9-audit-${label}-${randomUUID()}@test.invalid`
  const pass = `S9AuditPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  authUserIds.add(authData.user.id)

  const { error: appErr } = await serviceAdmin
    .from('app_users')
    .insert({ id: authData.user.id, email, full_name: `S9 Audit Test ${label}`, role, active })
  if (appErr) throw new Error(`insert app_user (${label}): ${appErr.message}`)

  const session = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

async function insertAuditRow(row: {
  actor_user_id: string | null
  action: string
  entity_type?: string
  entity_id: string
  details_json?: Record<string, unknown> | null
  created_at?: string
}): Promise<number> {
  const { data, error } = await serviceAdmin
    .from('audit_log')
    .insert({
      actor_user_id: row.actor_user_id,
      action: row.action,
      entity_type: row.entity_type ?? TEST_ENTITY_TYPE,
      entity_id: row.entity_id,
      details_json: row.details_json ?? null,
      ...(row.created_at ? { created_at: row.created_at } : {}),
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`insertAuditRow: ${error?.message}`)
  auditLogIds.add(data.id)
  return data.id
}

let adminSession: SupabaseClient
let organizerSession: SupabaseClient

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const admin = await createAppUserFixture('admin', 'admin')
  adminSession = admin.session

  const organizer = await createAppUserFixture('organizer', 'organizer')
  organizerSession = organizer.session
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
}, 30_000)

// ── privilege gate ───────────────────────────────────────────────────────────

describe('impl_listAuditLog — privilege gate', () => {
  it('organizer caller -> not_authorized, no rows leaked', async () => {
    const result = await impl_listAuditLog({}, organizerSession)
    expect(result).toEqual({ status: 'not_authorized' })
    // Discriminated union: a not_authorized result has no `rows` field at
    // all, not an empty array — nothing to leak by construction.
    expect('rows' in result).toBe(false)
  })
})

// ── T5-09: filter by actor returns ONLY that actor's rows ───────────────────

describe('T5-09 — filter by actor', () => {
  it('returns only that actor\'s rows, total matches an exact row-count proof', async () => {
    const actorA = await createAppUserFixture('actorA', 'organizer')
    const actorB = await createAppUserFixture('actorB', 'organizer')

    await insertAuditRow({ actor_user_id: actorA.id, action: 'people.update', entity_id: 'p1' })
    await insertAuditRow({ actor_user_id: actorA.id, action: 'people.update', entity_id: 'p2' })
    await insertAuditRow({ actor_user_id: actorA.id, action: 'checkin.create', entity_id: 'a1' })
    await insertAuditRow({ actor_user_id: actorB.id, action: 'people.update', entity_id: 'p3' })
    await insertAuditRow({ actor_user_id: actorB.id, action: 'people.update', entity_id: 'p4' })

    const result = await impl_listAuditLog({ filters: { actorUserId: actorA.id } }, adminSession)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return

    // actorA has fresh randomUUID() ids — no other test/suite can reference
    // them, so this total is exact, not just "at least".
    expect(result.total).toBe(3)
    expect(result.rows).toHaveLength(3)
    expect(result.rows.every(r => r.actor.kind === 'resolved')).toBe(true)
    for (const r of result.rows) {
      // Row-count proof: every returned row really is actorA's, not a
      // superset that merely happens to look right at a glance.
      expect(r.actor.kind === 'resolved' && r.actor.email).toBe(
        (await serviceAdmin.from('app_users').select('email').eq('id', actorA.id).single()).data?.email,
      )
    }
  })
})

// ── other filters ────────────────────────────────────────────────────────────

describe('impl_listAuditLog — action / entity_type / date-range filters', () => {
  it('action filter scopes to that action only', async () => {
    const actor = await createAppUserFixture('actionfilter', 'organizer')
    await insertAuditRow({ actor_user_id: actor.id, action: 'parish.approve', entity_id: 'e1' })
    await insertAuditRow({ actor_user_id: actor.id, action: 'parish.create', entity_id: 'e2' })

    const result = await impl_listAuditLog(
      { filters: { actorUserId: actor.id, action: 'parish.approve' } },
      adminSession,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.total).toBe(1)
    expect(result.rows[0].action).toBe('parish.approve')
  })

  it('entity_type filter (this suite\'s marker) scopes correctly, combined with actor', async () => {
    const actor = await createAppUserFixture('entityfilter', 'organizer')
    await insertAuditRow({ actor_user_id: actor.id, action: 'people.update', entity_id: 'e1' })
    await insertAuditRow({
      actor_user_id: actor.id,
      action: 'people.update',
      entity_id: 'e2',
      entity_type: `${TEST_ENTITY_TYPE}_other`,
    })

    const result = await impl_listAuditLog(
      { filters: { actorUserId: actor.id, entityType: TEST_ENTITY_TYPE } },
      adminSession,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.total).toBe(1)
    expect(result.rows[0].entityId).toBe('e1')
  })

  it('date-range filter (from/to) is inclusive on both ends', async () => {
    const actor = await createAppUserFixture('datefilter', 'organizer')
    await insertAuditRow({
      actor_user_id: actor.id,
      action: 'people.update',
      entity_id: 'in-range',
      created_at: '2026-05-15T12:00:00Z',
    })
    await insertAuditRow({
      actor_user_id: actor.id,
      action: 'people.update',
      entity_id: 'before-range',
      created_at: '2026-04-30T23:59:59Z',
    })
    await insertAuditRow({
      actor_user_id: actor.id,
      action: 'people.update',
      entity_id: 'after-range',
      created_at: '2026-06-01T00:00:01Z',
    })

    const result = await impl_listAuditLog(
      { filters: { actorUserId: actor.id, from: '2026-05-01', to: '2026-05-31' } },
      adminSession,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.total).toBe(1)
    expect(result.rows[0].entityId).toBe('in-range')
  })
})

// ── keyset pagination boundary, including a forced tie on created_at ────────

describe('impl_listAuditLog — keyset pagination round-trip', () => {
  it('pages through a forced-tie fixture with no gap, dupe, or skip', async () => {
    const actor = await createAppUserFixture('pagination', 'organizer')
    // All 7 rows share the IDENTICAL created_at — forces every page boundary
    // through the (created_at, id) tie-break path, which local prod data
    // (0 ties as of the schema gate) can't exercise on its own.
    const tiedTimestamp = '2026-06-15T09:00:00.500000Z'
    const insertedIds: number[] = []
    for (let i = 0; i < 7; i++) {
      insertedIds.push(
        await insertAuditRow({
          actor_user_id: actor.id,
          action: 'checkin.create',
          entity_id: `tie-${i}`,
          created_at: tiedTimestamp,
        }),
      )
    }
    // Expected DESC order: (created_at DESC, id DESC) — since all created_at
    // tie, this is purely id DESC.
    const expectedOrder = [...insertedIds].sort((a, b) => b - a)

    const collected: number[] = []
    let cursor: { createdAt: string; id: number } | null = null
    let pages = 0
    while (true) {
      const result = await impl_listAuditLog(
        { filters: { actorUserId: actor.id }, cursor, pageSize: 3 },
        adminSession,
      )
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      collected.push(...result.rows.map(r => r.id))
      pages++
      if (!result.nextCursor) break
      cursor = result.nextCursor
      if (pages > 20) throw new Error('runaway pagination loop')
    }

    expect(pages).toBe(3) // 7 rows / pageSize 3 -> pages of 3, 3, 1
    expect(collected).toEqual(expectedOrder) // exact order, no gap/dupe/skip
    expect(new Set(collected).size).toBe(7) // no duplicates
  })
})

// ── actor resolution: the "system" (null actor) fallback, DB-backed ─────────
//
// The "unresolved" case (actor_user_id set but the app_users row is gone) is
// NOT exercised here: audit_log.actor_user_id -> app_users(id) is a real FK
// (NO ACTION, no ON DELETE), so inserting a row with a non-existent actor id
// fails at the DB, and app_users rows are never hard-deleted by this app
// (deactivate only sets active=false) — so there is no way to manufacture a
// real dangling row today. That path is proven by construction in the
// mocked unit tests (lib/actions/__tests__/audit-log.test.ts) instead, and
// accepted as reasoning-covered rather than DB-proven. See the T9 verify
// report for the explicit note.

describe('impl_listAuditLog — null actor_user_id renders as "system", no error', () => {
  it('a row with actor_user_id IS NULL resolves to kind "system"', async () => {
    const actor = await createAppUserFixture('systemrow', 'organizer')
    // Insert one attributable row (to scope entity_type to this test) and
    // one system-originated row (actor_user_id null) sharing the same marker.
    await insertAuditRow({ actor_user_id: actor.id, action: 'people.update', entity_id: 'attributed' })
    await insertAuditRow({
      actor_user_id: null,
      action: 'attendance_summary.manual_trigger',
      entity_id: 'system-1',
      entity_type: `${TEST_ENTITY_TYPE}_system`,
    })

    const result = await impl_listAuditLog(
      { filters: { entityType: `${TEST_ENTITY_TYPE}_system` } },
      adminSession,
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.total).toBe(1)
    expect(result.rows[0].actor).toEqual({ kind: 'system' })
  })
})
