// Integration test for S8-T3 — the enrichment script's guarded fill-empty
// write (scripts/lib/anniversary-spouse-enrich.ts guardedFillUpdate), run
// against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint8_task3 migration applied (supabase db reset).
// Run: npm test -- s8-t3-enrich-guard
//
// Proves the SQL-level IS NULL guard: a non-null value is never overwritten
// and the call reports 0 rows ('race_skipped'). Teardown deletes ONLY the
// fixture ids this file created.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { guardedFillUpdate } from '@/scripts/lib/anniversary-spouse-enrich'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const PROD_PROJECT_REF = 'bftifxgdcmisasgvobuf'
if (url.includes(PROD_PROJECT_REF)) {
  throw new Error(
    `[s8-t3-enrich-guard.test.ts] NEXT_PUBLIC_SUPABASE_URL resolves to the PRODUCTION project ` +
      `(${PROD_PROJECT_REF}). This suite writes people rows — must run against local Docker only.`,
  )
}

// +62891 is used by no other test file.
const ts = Date.now()
const phone = (n: number) => `+62891${(ts + n).toString().slice(-7)}`

const COLS = 'id, wedding_anniversary, spouse_name, anniversary_consent_state, anniversary_consent_at, updated_at'
const FIXED_UPDATED_AT = '2020-01-01T00:00:00+00:00'

let admin: SupabaseClient
const fixtureIds: string[] = []

async function createFixture(n: number, over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from('people')
    .insert({
      phone_e164: phone(n),
      full_name: `S8T3 Guard Person ${n}`,
      nickname: `Guard${n}`,
      updated_at: FIXED_UPDATED_AT,
      ...over,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`fixture insert: ${error?.message}`)
  fixtureIds.push(data.id as string)
  return data.id as string
}

async function getRow(id: string) {
  const { data, error } = await admin.from('people').select(COLS).eq('id', id).single()
  if (error || !data) throw new Error(`getRow: ${error?.message}`)
  return data as Record<string, unknown>
}

beforeAll(() => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

afterAll(async () => {
  if (fixtureIds.length > 0) {
    await admin.from('people').delete().in('id', fixtureIds)
  }
}, 30_000)

describe('guardedFillUpdate — SQL IS NULL guard', () => {
  it('non-null target: returns race_skipped, value and updated_at unchanged', async () => {
    const id = await createFixture(1, { spouse_name: 'S8T3 Existing' })
    const before = await getRow(id)

    const outcome = await guardedFillUpdate(admin, id, { spouse_name: 'S8T3 New' }, new Date().toISOString())

    expect(outcome).toBe('race_skipped')
    const after = await getRow(id)
    expect(after).toEqual(before)
    expect(after.spouse_name).toBe('S8T3 Existing')
  })

  it('positive control: NULL target is filled, 1 row, updated_at moves, consent pair untouched', async () => {
    const id = await createFixture(2)
    const stamp = new Date().toISOString()

    const outcome = await guardedFillUpdate(admin, id, { wedding_anniversary: '2015-06-20', spouse_name: 'S8T3 Filled' }, stamp)

    expect(outcome).toBe('filled')
    const after = await getRow(id)
    expect(after.wedding_anniversary).toBe('2015-06-20')
    expect(after.spouse_name).toBe('S8T3 Filled')
    expect(new Date(after.updated_at as string).toISOString()).toBe(stamp)
    expect(after.anniversary_consent_state).toBe('unknown')
    expect(after.anniversary_consent_at).toBeNull()
  })

  it('two-column payload with only one NULL column: 0 rows, neither column changes', async () => {
    const id = await createFixture(3, { wedding_anniversary: '2010-03-14' })
    const before = await getRow(id)

    const outcome = await guardedFillUpdate(admin, id, { wedding_anniversary: '2015-06-20', spouse_name: 'S8T3 Partial' }, new Date().toISOString())

    expect(outcome).toBe('race_skipped')
    expect(await getRow(id)).toEqual(before)
  })

  it('refuses a non-enrich column before touching the DB', async () => {
    const id = await createFixture(4)
    const before = await getRow(id)

    await expect(
      guardedFillUpdate(admin, id, { anniversary_consent_state: 'granted' } as unknown as Parameters<typeof guardedFillUpdate>[2], new Date().toISOString()),
    ).rejects.toThrow('forbidden column')
    expect(await getRow(id)).toEqual(before)
  })
})
