// Integration tests for Sprint 8 Task 4b (pass 1) — child create/update/soft-delete.
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: S8-T1 migration applied (supabase db reset).
// Run: npm test -- children-mutations
//
// Mirrors child-attendance-actions.test.ts. Every impl runs on a REAL user
// session (organizer or admin) — RLS is the enforcement layer under test; the
// service-role client is used only for fixture setup/teardown and assertions.
// All actors are real auth users, so no FAKE_*_ID block is consumed here.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { impl_createChild, impl_updateChild, impl_softDeleteChild } from '@/lib/actions/children.impl'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

let serviceAdmin: SupabaseClient
let orgSession: SupabaseClient
let adminSession: SupabaseClient
let orgId: string
let adminId: string

let parentId: string          // active parent
let deletedParentId: string   // soft-deleted parent
let deletedChildId: string    // pre-seeded soft-deleted child

const createdChildIds: string[] = []

async function createAppUser(
  label: string,
  role: 'organizer' | 'admin',
  ts: number,
): Promise<{ id: string; session: SupabaseClient }> {
  const email = `cmut-${label}-${ts}@test.invalid`
  const pass = `CmutPass-${label}-${ts}!`
  const { data: authData, error: authErr } = await serviceAdmin.auth.admin.createUser({
    email,
    password: pass,
    email_confirm: true,
  })
  if (authErr || !authData.user) throw new Error(`createUser (${label}): ${authErr?.message}`)
  const { error: appUserErr } = await serviceAdmin.from('app_users').insert({
    id: authData.user.id,
    email,
    full_name: `CMUT Test ${label}`,
    role,
    active: true,
  })
  if (appUserErr) throw new Error(`insert app_user (${label}): ${appUserErr.message}`)
  const session = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInErr } = await session.auth.signInWithPassword({ email, password: pass })
  if (signInErr) throw new Error(`sign-in (${label}): ${signInErr.message}`)
  return { id: authData.user.id, session }
}

beforeAll(async () => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const ts = Date.now()
  const org = await createAppUser('org', 'organizer', ts)
  orgId = org.id
  orgSession = org.session
  const admin = await createAppUser('admin', 'admin', ts)
  adminId = admin.id
  adminSession = admin.session

  const tail = ts.toString().slice(-7)
  const { data: parents, error: pErr } = await serviceAdmin
    .from('people')
    .insert([
      { phone_e164: `+62896${tail}`, full_name: 'CMUT Test Parent', nickname: 'CmutParent' },
      {
        phone_e164: `+62897${tail}`,
        full_name: 'CMUT Test Deleted Parent',
        nickname: 'CmutDeleted',
        deleted_at: new Date().toISOString(),
      },
    ])
    .select('id, deleted_at')
  if (pErr || !parents || parents.length !== 2) throw new Error(`insert parents: ${pErr?.message}`)
  const typed = parents as { id: string; deleted_at: string | null }[]
  parentId = typed.find((p) => p.deleted_at === null)!.id
  deletedParentId = typed.find((p) => p.deleted_at !== null)!.id

  const { data: dk, error: dkErr } = await serviceAdmin
    .from('children')
    .insert({
      parent_person_id: parentId,
      full_name: 'CMUT Test Child Deleted',
      birth_date: '2019-06-15',
      deleted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (dkErr || !dk) throw new Error(`insert deleted child: ${dkErr?.message}`)
  deletedChildId = (dk as { id: string }).id
}, 30_000)

afterAll(async () => {
  // audit_log is append-only — never deleted; assertions query by entity_id.
  const childIds = [...createdChildIds, deletedChildId].filter(Boolean)
  if (childIds.length) {
    await serviceAdmin.from('children').delete().in('id', childIds)
  }
  // Catch-all for any child created under the test parents that wasn't tracked.
  await serviceAdmin.from('children').delete().in('parent_person_id', [parentId, deletedParentId].filter(Boolean))
  await serviceAdmin.from('people').delete().in('id', [parentId, deletedParentId].filter(Boolean))
  for (const userId of [orgId, adminId].filter(Boolean)) {
    await serviceAdmin.from('app_users').delete().eq('id', userId)
    await serviceAdmin.auth.admin.deleteUser(userId)
  }
}, 30_000)

async function auditRows(entityId: string, action: string) {
  const { data } = await serviceAdmin
    .from('audit_log')
    .select('actor_user_id, action, entity_type, entity_id, details_json')
    .eq('entity_id', entityId)
    .eq('action', action)
  return (data ?? []) as Array<{
    actor_user_id: string
    action: string
    entity_type: string
    entity_id: string
    details_json: Record<string, unknown>
  }>
}

function expectIdsOnly(details: Record<string, unknown>, childId: string) {
  expect(details.child_id).toBe(childId)
  expect(details.parent_id).toBe(parentId)
  for (const k of ['full_name', 'birth_date', 'name', 'before', 'after', 'notes', 'gender']) {
    expect(details).not.toHaveProperty(k)
  }
  expect(JSON.stringify(details)).not.toMatch(/CMUT Test|20\d\d-\d\d-\d\d/)
}

async function rowById(id: string) {
  const { data } = await serviceAdmin
    .from('children')
    .select('id, full_name, birth_date, notes, deleted_at, updated_at')
    .eq('id', id)
    .single()
  return data as { id: string; full_name: string; birth_date: string | null; notes: string | null; deleted_at: string | null; updated_at: string }
}

async function seedChild(fullName: string): Promise<string> {
  const { data, error } = await serviceAdmin
    .from('children')
    .insert({ parent_person_id: parentId, full_name: fullName, birth_date: '2017-01-01' })
    .select('id')
    .single()
  if (error || !data) throw new Error(`seed child: ${error?.message}`)
  const id = (data as { id: string }).id
  createdChildIds.push(id)
  return id
}

describe('children mutations (S8-T4b)', () => {
  it('CMUT-01: organizer session CAN create; one CHILD_CREATE audit row, IDs-only, actor = organizer', async () => {
    const result = await impl_createChild(
      { parentPersonId: parentId, full_name: '  CMUT Test Child Org  ', birth_date: '2018-03-01', gender: 'female' },
      orgSession,
    )
    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    createdChildIds.push(result.child.id)
    expect(result.child.full_name).toBe('CMUT Test Child Org')
    expect(result.child.parent_person_id).toBe(parentId)

    const audits = await auditRows(result.child.id, 'child.create')
    expect(audits).toHaveLength(1)
    expect(audits[0].actor_user_id).toBe(orgId)
    expect(audits[0].entity_type).toBe('children')
    expectIdsOnly(audits[0].details_json, result.child.id)
  })

  it('CMUT-02: duplicate_warning — second same-name (case-insensitive) child is created, existing populated', async () => {
    const firstId = await seedChild('CMUT Test Twin')
    const result = await impl_createChild(
      { parentPersonId: parentId, full_name: 'cmut test TWIN' },
      orgSession,
    )
    expect(result.status).toBe('duplicate_warning')
    if (result.status !== 'duplicate_warning') return
    createdChildIds.push(result.child.id)
    expect(result.child.id).not.toBe(firstId)
    expect(result.existing.map((c) => c.id)).toEqual([firstId])

    // Both rows exist — the warning never blocks the write.
    const { data } = await serviceAdmin
      .from('children').select('id').eq('parent_person_id', parentId).ilike('full_name', 'cmut test twin').is('deleted_at', null)
    expect((data ?? []).length).toBe(2)

    expect(await auditRows(result.child.id, 'child.create')).toHaveLength(1)
  })

  it('CMUT-03: soft-deleted same-name sibling does NOT trigger duplicate_warning', async () => {
    const result = await impl_createChild(
      { parentPersonId: parentId, full_name: 'CMUT Test Child Deleted' },
      orgSession,
    )
    expect(result.status).toBe('created')
    if (result.status === 'created') createdChildIds.push(result.child.id)
  })

  it('CMUT-04: create under a soft-deleted parent → parent_not_found (organizer AND admin), no row, no audit', async () => {
    for (const session of [orgSession, adminSession]) {
      const result = await impl_createChild(
        { parentPersonId: deletedParentId, full_name: 'CMUT Test Orphan' },
        session,
      )
      expect(result).toEqual({ status: 'parent_not_found' })
    }
    const { data } = await serviceAdmin.from('children').select('id').eq('parent_person_id', deletedParentId)
    expect(data ?? []).toHaveLength(0)
  })

  it('CMUT-05: organizer CAN update an active child; one CHILD_UPDATE row with field names only', async () => {
    const id = await seedChild('CMUT Test Child Upd')
    const before = await rowById(id)
    const result = await impl_updateChild(id, { full_name: 'CMUT Test Child Upd2', notes: 'n' }, orgSession)
    expect(result.status).toBe('updated')

    const after = await rowById(id)
    expect(after.full_name).toBe('CMUT Test Child Upd2')
    expect(after.birth_date).toBe('2017-01-01')  // untouched
    expect(after.updated_at > before.updated_at).toBe(true)

    const audits = await auditRows(id, 'child.update')
    expect(audits).toHaveLength(1)
    expect(audits[0].actor_user_id).toBe(orgId)
    expectIdsOnly(audits[0].details_json, id)
    expect(audits[0].details_json.changed_fields).toEqual(['full_name', 'notes'])
  })

  it('CMUT-06: organizer CANNOT update a soft-deleted child (RLS hides it) → not_found, row unchanged, no audit', async () => {
    const result = await impl_updateChild(deletedChildId, { full_name: 'CMUT Hacked' }, orgSession)
    expect(result).toEqual({ status: 'not_found' })
    expect((await rowById(deletedChildId)).full_name).toBe('CMUT Test Child Deleted')
    expect(await auditRows(deletedChildId, 'child.update')).toHaveLength(0)
  })

  it('CMUT-07: organizer CANNOT soft-delete (RLS WITH CHECK) → forbidden, row still active, no audit', async () => {
    const id = await seedChild('CMUT Test Child NoDel')
    const result = await impl_softDeleteChild(id, orgSession)
    expect(result.status).toBe('forbidden')
    expect((await rowById(id)).deleted_at).toBeNull()
    expect(await auditRows(id, 'child.soft_delete')).toHaveLength(0)
  })

  it('CMUT-08: admin CAN create / update / soft-delete; exactly one audit row per write, IDs-only, actor = admin', async () => {
    const created = await impl_createChild(
      { parentPersonId: parentId, full_name: 'CMUT Test Child Admin', birth_date: '2015-12-31' },
      adminSession,
    )
    expect(created.status).toBe('created')
    if (created.status !== 'created') return
    const id = created.child.id
    createdChildIds.push(id)

    const updated = await impl_updateChild(id, { birth_date: '2015-11-30', gender: 'male' }, adminSession)
    expect(updated.status).toBe('updated')

    const deleted = await impl_softDeleteChild(id, adminSession)
    expect(deleted).toEqual({ status: 'soft_deleted', id })
    expect((await rowById(id)).deleted_at).not.toBeNull()

    for (const action of ['child.create', 'child.update', 'child.soft_delete']) {
      const rows = await auditRows(id, action)
      expect(rows, action).toHaveLength(1)
      expect(rows[0].actor_user_id).toBe(adminId)
      expectIdsOnly(rows[0].details_json, id)
    }

    // Second soft-delete is a no-op not_found, and writes no second audit row.
    expect(await impl_softDeleteChild(id, adminSession)).toEqual({ status: 'not_found' })
    expect(await auditRows(id, 'child.soft_delete')).toHaveLength(1)
  })

  it('CMUT-09: future birth_date (Jakarta) is rejected before any write', async () => {
    const result = await impl_createChild(
      { parentPersonId: parentId, full_name: 'CMUT Test Future', birth_date: '2099-01-01' },
      orgSession,
    )
    expect(result.status).toBe('validation_error')
  })
})
