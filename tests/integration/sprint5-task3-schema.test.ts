// Integration tests for Sprint 5 Task 3 — additive schema migration
// (system_health.source, system_health.ict_date, partial unique index
// idx_system_health_source_ict_date).
// Runs against local Docker Supabase (configured in .env.test.local).
// Prerequisite: sprint5_task3 migration applied (supabase db reset).
// Run: npm test -- sprint5-task3-schema
//
// system_health accumulates real heartbeat/cron rows locally (and other
// test runs), so every row this file inserts is tagged with a distinct
// per-run marker source value and its id is captured for a fixture-scoped
// afterAll delete. Never a table-wide DELETE FROM system_health.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url || !serviceRoleKey) {
  throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
}

const ts = Date.now()
const marker = (label: string) => `test-t3-${ts}-${label}`

let admin: SupabaseClient
const rowIds: number[] = []

beforeAll(() => {
  admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
})

afterAll(async () => {
  if (rowIds.length > 0) {
    await admin.from('system_health').delete().in('id', rowIds)
  }
}, 30_000)

describe('system_health.source / system_health.ict_date', () => {
  it('are nullable and omitted values default to null', async () => {
    const { data, error } = await admin
      .from('system_health')
      .insert({ notes: marker('nullable-defaults') })
      .select('id, source, ict_date')
      .single()
    if (error || !data) throw new Error(`insert: ${error?.message}`)
    rowIds.push((data as { id: number }).id)

    expect(data.source).toBeNull()
    expect(data.ict_date).toBeNull()
  })

  it('accepts and round-trips a text source + date ict_date', async () => {
    const source = marker('roundtrip')
    const { data, error } = await admin
      .from('system_health')
      .insert({ source, ict_date: '2026-08-01' })
      .select('id, source, ict_date')
      .single()
    if (error || !data) throw new Error(`insert: ${error?.message}`)
    rowIds.push((data as { id: number }).id)

    expect(data.source).toBe(source)
    expect(data.ict_date).toBe('2026-08-01')
  })
})

describe('idx_system_health_source_ict_date (partial unique index)', () => {
  it('rejects a second row with the same non-null (source, ict_date) pair with 23505 naming the index', async () => {
    const source = marker('enforce')

    const first = await admin
      .from('system_health')
      .insert({ source, ict_date: '2026-08-02' })
      .select('id')
      .single()
    if (first.error || !first.data) throw new Error(`insert first: ${first.error?.message}`)
    rowIds.push((first.data as { id: number }).id)

    const second = await admin
      .from('system_health')
      .insert({ source, ict_date: '2026-08-02' })
      .select('id')
      .single()

    expect(second.data).toBeNull()
    expect(second.error).not.toBeNull()
    expect(second.error?.code).toBe('23505')
    expect(second.error?.message).toContain('idx_system_health_source_ict_date')
  })

  it('allows two rows with the same source when ict_date is NULL on both (partial index excludes NULL)', async () => {
    const source = marker('null-exempt')

    const first = await admin
      .from('system_health')
      .insert({ source })
      .select('id')
      .single()
    if (first.error || !first.data) throw new Error(`insert first: ${first.error?.message}`)
    rowIds.push((first.data as { id: number }).id)

    const second = await admin
      .from('system_health')
      .insert({ source })
      .select('id')
      .single()
    if (second.error || !second.data) throw new Error(`insert second: ${second.error?.message}`)
    rowIds.push((second.data as { id: number }).id)

    expect(first.data).not.toBeNull()
    expect(second.data).not.toBeNull()
  })
})
