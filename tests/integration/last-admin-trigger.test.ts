// Integration tests for Sprint 5 Task 6 — enforce_last_admin() trigger.
// Runs against local Docker Supabase only (see PROD_PROJECT_REF guard below).
//
// This suite is fileParallelism:false but shares one persistent local Docker
// DB across the whole `npm test` run — other integration files may leave
// admin-role residue (a pre-existing, separately-tracked teardown bug, not
// fixed here). Per the established "scope to fixture IDs, never assume
// ambient state" convention, this suite does NOT assume the baseline seed
// admin is the only other admin: it snapshots whatever set of admins is
// active at suite start and quarantines (deactivates) that whole set for
// the duration of each "sole admin" / "exactly two admins" test, restoring
// it afterward — so the trigger's global count reflects exactly what this
// suite intends, regardless of what sibling files left behind.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { randomUUID } from 'crypto'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[last-admin-trigger.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite mutates app_users role/active state and must run ` +
      `against local Docker only.`,
  )
}

let serviceAdmin: SupabaseClient
const fixtureIds: string[] = []
let quarantinedIds: string[] = []

beforeAll(() => {
  serviceAdmin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

async function makeAdminFixture(): Promise<string> {
  const id = randomUUID()
  const { error } = await serviceAdmin
    .from('app_users')
    .insert({ id, email: `last-admin-fixture-${id}@test.invalid`, role: 'admin', active: true })
  if (error) throw new Error(`fixture insert failed: ${error.message}`)
  fixtureIds.push(id)
  return id
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

// Deactivates every CURRENTLY active admin except the given fixture ids, and
// remembers exactly which ones it touched so afterEach can restore precisely
// those — never a blind "reactivate everything" that could reactivate an
// admin some OTHER test intentionally deactivated.
async function quarantineOtherActiveAdmins(exceptIds: string[]): Promise<void> {
  const { data, error } = await serviceAdmin
    .from('app_users')
    .select('id')
    .eq('role', 'admin')
    .eq('active', true)
  if (error) throw new Error(`quarantine select failed: ${error.message}`)

  const toQuarantine = (data ?? []).map((r) => r.id as string).filter((id) => !exceptIds.includes(id))
  if (toQuarantine.length === 0) {
    quarantinedIds = []
    return
  }

  const { error: updateErr } = await serviceAdmin
    .from('app_users')
    .update({ active: false })
    .in('id', toQuarantine)
  if (updateErr) throw new Error(`quarantine update failed: ${updateErr.message}`)
  quarantinedIds = toQuarantine
}

afterEach(async () => {
  // Restore quarantined admins FIRST — deleting fixtures while the intended
  // admin count is still artificially at 1 could hit the trigger itself
  // (correctly) and abort cleanup.
  if (quarantinedIds.length > 0) {
    await serviceAdmin.from('app_users').update({ active: true }).in('id', quarantinedIds)
    quarantinedIds = []
  }
  if (fixtureIds.length > 0) {
    await serviceAdmin.from('app_users').delete().in('id', fixtureIds)
    fixtureIds.length = 0
  }
})

describe('enforce_last_admin trigger', () => {
  it('blocks demoting the sole active admin', async () => {
    const soleAdminId = await makeAdminFixture()
    await quarantineOtherActiveAdmins([soleAdminId])
    expect(await activeAdminCount()).toBe(1)

    const { error } = await serviceAdmin.from('app_users').update({ role: 'organizer' }).eq('id', soleAdminId)
    expect(error?.message).toMatch(/last_admin/)

    const { data } = await serviceAdmin.from('app_users').select('role').eq('id', soleAdminId).single()
    expect(data?.role).toBe('admin')
  })

  it('blocks deactivating the sole active admin', async () => {
    const soleAdminId = await makeAdminFixture()
    await quarantineOtherActiveAdmins([soleAdminId])
    expect(await activeAdminCount()).toBe(1)

    const { error } = await serviceAdmin.from('app_users').update({ active: false }).eq('id', soleAdminId)
    expect(error?.message).toMatch(/last_admin/)

    const { data } = await serviceAdmin.from('app_users').select('active').eq('id', soleAdminId).single()
    expect(data?.active).toBe(true)
  })

  it('blocks deleting the sole active admin', async () => {
    const soleAdminId = await makeAdminFixture()
    await quarantineOtherActiveAdmins([soleAdminId])
    expect(await activeAdminCount()).toBe(1)

    const { error } = await serviceAdmin.from('app_users').delete().eq('id', soleAdminId)
    expect(error?.message).toMatch(/last_admin/)

    const { data } = await serviceAdmin.from('app_users').select('id').eq('id', soleAdminId).single()
    expect(data?.id).toBe(soleAdminId)
  })

  it('allows demoting one admin when two active admins exist (2 -> 1)', async () => {
    const fixtureAdminId = await makeAdminFixture()
    const otherAdminId = await makeAdminFixture()
    await quarantineOtherActiveAdmins([fixtureAdminId, otherAdminId])
    expect(await activeAdminCount()).toBe(2)

    const { error } = await serviceAdmin.from('app_users').update({ role: 'organizer' }).eq('id', fixtureAdminId)
    expect(error).toBeNull()

    const { data } = await serviceAdmin.from('app_users').select('role').eq('id', fixtureAdminId).single()
    expect(data?.role).toBe('organizer')
  })

  it('concurrency: two connections demoting two DIFFERENT admins from exactly 2 active admins never both succeed', async () => {
    const adminA = await makeAdminFixture()
    const adminB = await makeAdminFixture()
    await quarantineOtherActiveAdmins([adminA, adminB])
    expect(await activeAdminCount()).toBe(2)

    const [resultA, resultB] = await Promise.all([
      serviceAdmin.from('app_users').update({ role: 'organizer' }).eq('id', adminA),
      serviceAdmin.from('app_users').update({ role: 'organizer' }).eq('id', adminB),
    ])

    const errors = [resultA.error, resultB.error].filter((e): e is NonNullable<typeof e> => e !== null)
    const successes = [resultA.error, resultB.error].filter((e) => e === null)

    // Exactly one must fail with last_admin, the other must succeed —
    // never both succeed (which would leave zero admins), never both fail
    // (which would mean the legitimate 2->1 demote was wrongly blocked).
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/last_admin/)
    expect(successes).toHaveLength(1)

    // Never zero, never two — exactly one admin survives the race.
    expect(await activeAdminCount()).toBe(1)
  })
})
