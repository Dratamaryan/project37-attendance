// Integration test for Sprint 3 Task 7 — fetchExistingPhonesByE164.
// Runs against local Docker Supabase (configured in .env.test.local).
// Run: npm test -- import-lookup (scoped run for iteration only — verify
// report requires the full `npm test`, per feedback_collab.md).
//
// Fixture: phones in +62999009103xx — next free space after T4's 100xx,
// T6's 102xx, T2's 300xx.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fetchExistingPhonesByE164 } from '../../lib/import/lookup'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const PHONES = {
  ACTIVE: '+62999009103001',
  SOFT_DELETED: '+62999009103002',
  NOT_IN_DB: '+62999009103003',
} as const

let svc: SupabaseClient
let activeId: string
let softDeletedId: string

beforeAll(async () => {
  svc = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  const { data: active, error: activeErr } = await svc
    .from('people')
    .insert({ phone_e164: PHONES.ACTIVE, full_name: 'Import Lookup Active', nickname: 'Active' })
    .select('id')
    .single()
  if (activeErr) throw new Error(`fixture insert (active): ${activeErr.message}`)
  activeId = active.id

  const { data: deleted, error: deletedErr } = await svc
    .from('people')
    .insert({
      phone_e164: PHONES.SOFT_DELETED,
      full_name: 'Import Lookup Deleted',
      nickname: 'Deleted',
      deleted_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (deletedErr) throw new Error(`fixture insert (soft-deleted): ${deletedErr.message}`)
  softDeletedId = deleted.id
})

afterAll(async () => {
  await svc.from('people').delete().in('phone_e164', [PHONES.ACTIVE, PHONES.SOFT_DELETED])
})

describe('fetchExistingPhonesByE164', () => {
  it('returns active and soft-deleted matches, omits phones not in DB', async () => {
    const result = await fetchExistingPhonesByE164(svc, [PHONES.ACTIVE, PHONES.SOFT_DELETED, PHONES.NOT_IN_DB])

    expect(result.get(PHONES.ACTIVE)).toEqual({ id: activeId, deletedAt: null })

    const deletedRecord = result.get(PHONES.SOFT_DELETED)
    expect(deletedRecord?.id).toBe(softDeletedId)
    expect(deletedRecord?.deletedAt).not.toBeNull()

    expect(result.has(PHONES.NOT_IN_DB)).toBe(false)
    expect(result.size).toBe(2)
  })

  it('dedupes the input phone list before querying (same phone listed 3x)', async () => {
    const result = await fetchExistingPhonesByE164(svc, [PHONES.ACTIVE, PHONES.ACTIVE, PHONES.ACTIVE])
    expect(result.size).toBe(1)
    expect(result.get(PHONES.ACTIVE)?.id).toBe(activeId)
  })

  it('empty phones array -> empty map, no query executed', async () => {
    const result = await fetchExistingPhonesByE164(svc, [])
    expect(result.size).toBe(0)
  })
})
