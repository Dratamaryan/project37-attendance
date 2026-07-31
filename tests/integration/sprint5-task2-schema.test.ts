// Integration tests for Sprint 5 Task 2 — additive schema migration
// (event_instances.image_url, people.birthday_email_opt_in[_at]).
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint5_task2 migration applied (supabase db reset).
// Run: npm test -- sprint5-task2-schema
//
// PostgREST doesn't expose information_schema to normal roles, so column
// shape (type / nullability / default) is asserted behaviorally: insert rows
// that omit vs. set the new columns and check what comes back, plus one
// negative case that forces the NOT NULL constraint to fire.

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

const FAKE_ADMIN_ID = '00000000-0000-0000-0000-000000000097'
const ts = Date.now()
const phone = (n: number) => `+62894${(ts + n).toString().slice(-7)}`

let admin: SupabaseClient
let eventId: string
const instanceIds: string[] = []
const personIds: string[] = []

beforeAll(async () => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  await admin.from('app_users').upsert(
    {
      id: FAKE_ADMIN_ID,
      email: 'fake-admin-s5t2@test.invalid',
      full_name: 'S5T2 Fake Admin',
      role: 'admin',
      active: true,
    },
    { onConflict: 'id' },
  )

  const { data: event, error: eventErr } = await admin
    .from('events')
    .insert({
      name: 'S5T2 Schema Test Event',
      event_type: 'adhoc',
      start_date: '2026-07-01',
      start_time: '18:00:00',
      active: true,
      created_by: FAKE_ADMIN_ID,
    })
    .select('id')
    .single()
  if (eventErr || !event) throw new Error(`insert event: ${eventErr?.message}`)
  eventId = (event as { id: string }).id
}, 30_000)

afterAll(async () => {
  if (instanceIds.length > 0) {
    await admin.from('event_instances').delete().in('id', instanceIds)
  }
  if (eventId) {
    await admin.from('events').delete().eq('id', eventId)
  }
  if (personIds.length > 0) {
    await admin.from('people').delete().in('id', personIds)
  }
  await admin.from('app_users').delete().eq('id', FAKE_ADMIN_ID)
}, 30_000)

describe('event_instances.image_url', () => {
  it('defaults to null when omitted (nullable, no default)', async () => {
    const { data, error } = await admin
      .from('event_instances')
      .insert({
        event_id: eventId,
        scheduled_at: '2026-08-01T10:00:00Z',
        event_name_snapshot: 'S5T2 Schema Test Event',
      })
      .select('id, image_url')
      .single()
    if (error || !data) throw new Error(`insert instance: ${error?.message}`)
    instanceIds.push((data as { id: string }).id)

    expect(data.image_url).toBeNull()
  })

  it('accepts and round-trips a text value', async () => {
    const url = 'https://example.com/photo.jpg'
    const { data, error } = await admin
      .from('event_instances')
      .insert({
        event_id: eventId,
        scheduled_at: '2026-08-02T10:00:00Z',
        event_name_snapshot: 'S5T2 Schema Test Event',
        image_url: url,
      })
      .select('id, image_url')
      .single()
    if (error || !data) throw new Error(`insert instance: ${error?.message}`)
    instanceIds.push((data as { id: string }).id)

    expect(data.image_url).toBe(url)
  })
})

describe('people.birthday_email_opt_in / birthday_email_opt_in_at', () => {
  it('defaults opt_in to false and opt_in_at to null when omitted', async () => {
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(1),
        full_name: 'S5T2 Default Person',
        nickname: 'Default',
      })
      .select('id, birthday_email_opt_in, birthday_email_opt_in_at')
      .single()
    if (error || !data) throw new Error(`insert person: ${error?.message}`)
    personIds.push((data as { id: string }).id)

    expect(data.birthday_email_opt_in).toBe(false)
    expect(data.birthday_email_opt_in_at).toBeNull()
  })

  it('accepts and round-trips explicit true + timestamptz', async () => {
    const optInAt = new Date().toISOString()
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(2),
        full_name: 'S5T2 OptedIn Person',
        nickname: 'OptedIn',
        birthday_email_opt_in: true,
        birthday_email_opt_in_at: optInAt,
      })
      .select('id, birthday_email_opt_in, birthday_email_opt_in_at')
      .single()
    if (error || !data) throw new Error(`insert person: ${error?.message}`)
    personIds.push((data as { id: string }).id)

    expect(data.birthday_email_opt_in).toBe(true)
    expect(new Date(data.birthday_email_opt_in_at as string).toISOString()).toBe(optInAt)
  })

  it('rejects an explicit null for birthday_email_opt_in with a NOT NULL violation (23502), all other required columns valid', async () => {
    const { data, error } = await admin
      .from('people')
      .insert({
        phone_e164: phone(3),
        full_name: 'S5T2 Null OptIn Person',
        nickname: 'NullOptIn',
        birthday_email_opt_in: null,
      })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23502')
    expect(error?.message).toContain('birthday_email_opt_in')
  })
})
