// Integration tests for Sprint 8 Task 3 — additive schema migration
// (people.wedding_anniversary, spouse_name, anniversary_consent_state[_at]).
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint8_task3 migration applied (supabase db reset).
// Run: npm test -- sprint8-task3-schema
//
// PostgREST doesn't expose information_schema to normal roles, so column
// shape (type / nullability / default) is asserted behaviorally, same as
// sprint5-task2-schema.test.ts. The anonymize_person() scrub of these columns
// is covered in retention-anonymize.test.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !anonKey || !serviceRoleKey) {
  throw new Error(
    'Missing env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
  )
}

const ts = Date.now()
const phone = (n: number) => `+62893${(ts + n).toString().slice(-7)}`

const COLUMNS = 'id, wedding_anniversary, spouse_name, anniversary_consent_state, anniversary_consent_at'

let admin: SupabaseClient
const personIds: string[] = []

beforeAll(() => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

afterAll(async () => {
  if (personIds.length > 0) {
    await admin.from('people').delete().in('id', personIds)
  }
}, 30_000)

describe('people anniversary / spouse columns', () => {
  it('defaults: wedding_anniversary/spouse_name/anniversary_consent_at null, anniversary_consent_state unknown', async () => {
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(1),
        full_name: 'S8T3 Default Person',
        nickname: 'Default',
      })
      .select(COLUMNS)
      .single()
    if (error || !data) throw new Error(`insert person: ${error?.message}`)
    personIds.push((data as { id: string }).id)

    expect(data.wedding_anniversary).toBeNull()
    expect(data.spouse_name).toBeNull()
    expect(data.anniversary_consent_state).toBe('unknown')
    expect(data.anniversary_consent_at).toBeNull()
  })

  it('accepts and round-trips a date-only anniversary, spouse text, granted + timestamptz', async () => {
    const consentAt = new Date().toISOString()
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(2),
        full_name: 'S8T3 Married Person',
        nickname: 'Married',
        wedding_anniversary: '2015-06-20',
        spouse_name: 'S8T3 Spouse',
        anniversary_consent_state: 'granted',
        anniversary_consent_at: consentAt,
      })
      .select(COLUMNS)
      .single()
    if (error || !data) throw new Error(`insert person: ${error?.message}`)
    personIds.push((data as { id: string }).id)

    // date column: no time/zone component comes back
    expect(data.wedding_anniversary).toBe('2015-06-20')
    expect(data.spouse_name).toBe('S8T3 Spouse')
    expect(data.anniversary_consent_state).toBe('granted')
    expect(new Date(data.anniversary_consent_at as string).toISOString()).toBe(consentAt)
  })

  it('rejects an explicit null for anniversary_consent_state with a NOT NULL violation (23502)', async () => {
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(3),
        full_name: 'S8T3 Null Consent Person',
        nickname: 'NullConsent',
        anniversary_consent_state: null,
      })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23502')
    expect(error?.message).toContain('anniversary_consent_state')
  })

  it('rejects a value outside consent_state_enum (22P02)', async () => {
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(4),
        full_name: 'S8T3 Bad Enum Person',
        nickname: 'BadEnum',
        anniversary_consent_state: 'maybe',
      })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('22P02')
    expect(error?.message).toContain('consent_state_enum')
  })
})
